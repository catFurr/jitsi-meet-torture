import { spawn, exec } from "child_process";
import { promisify } from "util";
import * as dotenv from "dotenv";
import { DigitalOceanManager } from "../infra/digitalocean";

// Load environment variables
dotenv.config();

const execAsync = promisify(exec);

class SeleniumOrchestrator {
  private doManager: DigitalOceanManager;
  private hubContainerId: string | null = null;
  private hubIp: string = "localhost";
  private hubPort: number = 4444;

  constructor() {
    const apiKey = process.env.DO_API_KEY;
    const serverSize = process.env.SERVER_SIZE || "s-1vcpu-1gb";
    const serverRegion = process.env.SERVER_REGION || "nyc1";

    if (!apiKey) {
      throw new Error("DO_API_KEY environment variable is required");
    }

    this.doManager = new DigitalOceanManager(apiKey, serverSize, serverRegion);
  }

  /**
   * Start the Selenium Grid Hub locally
   */
  async startHub(): Promise<void> {
    console.log("🚀 Starting Selenium Grid Hub...");

    try {
      // Create Docker network if it doesn't exist
      try {
        await execAsync("docker network create grid");
        console.log('✅ Created Docker network "grid"');
      } catch (error) {
        // Network might already exist, that's okay
        console.log('📝 Docker network "grid" already exists or created');
      }

      // Start the hub container
      const hubCommand = `docker run -d -p ${this.hubPort}:4444 -p 4442:4442 -p 4443:4443 --net grid --name selenium-hub selenium/hub:latest`;

      const { stdout } = await execAsync(hubCommand);
      this.hubContainerId = stdout.trim();

      console.log(
        `✅ Selenium Hub started with container ID: ${this.hubContainerId}`
      );
      console.log(`🌐 Hub accessible at: http://${this.hubIp}:${this.hubPort}`);

      // Wait a moment for hub to be ready
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // Get the public IP of this machine (for nodes to connect)
      try {
        const { stdout: publicIp } = await execAsync("curl -s ifconfig.me");
        this.hubIp = publicIp.trim();
        console.log(`🌍 Public IP for nodes to connect: ${this.hubIp}`);
      } catch (error) {
        console.log("⚠️  Could not get public IP, using localhost");
      }
    } catch (error) {
      console.error("❌ Failed to start hub:", error);
      throw error;
    }
  }

  /**
   * Provision initial servers
   */
  async provisionInitialServers(count: number = 2): Promise<void> {
    console.log(`🏗️  Provisioning ${count} initial servers...`);

    const provisionPromises = [];

    for (let i = 0; i < count; i++) {
      const serverName = `selenium-node-${Date.now()}-${i}`;
      provisionPromises.push(this.provisionAndSetupNode(serverName));
    }

    const results = await Promise.allSettled(provisionPromises);

    const successful = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected").length;

    console.log(`✅ Successfully provisioned: ${successful} servers`);
    if (failed > 0) {
      console.log(`❌ Failed to provision: ${failed} servers`);
    }
  }

  /**
   * Provision a single node and wait for it to be ready
   */
  async provisionAndSetupNode(name: string): Promise<void> {
    try {
      // Provision the server
      const serverInfo = await this.doManager.provisionServer(name, this.hubIp);

      // Wait for server to be ready
      await this.doManager.waitForServerReady(serverInfo.id);

      console.log(`✅ Node ${name} is ready and should auto-connect to hub`);
    } catch (error) {
      console.error(`❌ Failed to setup node ${name}:`, error);
      throw error;
    }
  }

  /**
   * Run a single test
   */
  async runTest(): Promise<void> {
    console.log("🧪 Running Sonacove test...");

    const hubUrl = `http://${this.hubIp}:${this.hubPort}`;

    try {
      // Import and run the test
      const {
        testSonacoveOnboarding,
      } = require("../selenium/sonacove-test.js");
      const result = await testSonacoveOnboarding(hubUrl);

      if (result.success) {
        console.log("✅ Test completed successfully!");
        console.log(`📄 Result: ${result.message}`);
      } else {
        console.log("❌ Test failed!");
        console.log(`📄 Error: ${result.error}`);
      }
    } catch (error) {
      console.error("💥 Failed to run test:", error);
      throw error;
    }
  }

  /**
   * Check hub status and connected nodes
   */
  async checkGridStatus(): Promise<void> {
    try {
      const hubUrl = `http://${this.hubIp}:${this.hubPort}/status`;
      const { stdout } = await execAsync(`curl -s ${hubUrl}`);
      const status = JSON.parse(stdout);

      console.log("📊 Grid Status:");
      console.log(`- Ready: ${status.value.ready}`);
      console.log(`- Message: ${status.value.message}`);

      // Get node info
      const nodesUrl = `http://${this.hubIp}:${this.hubPort}/grid/api/hub/status`;
      try {
        const { stdout: nodesInfo } = await execAsync(`curl -s ${nodesUrl}`);
        const nodes = JSON.parse(nodesInfo);
        console.log(`- Connected Nodes: ${nodes.value.nodes?.length || 0}`);
      } catch (error) {
        console.log("- Could not get node information");
      }
    } catch (error) {
      console.error("⚠️  Could not check grid status:", error);
    }
  }

  /**
   * Cleanup everything
   */
  async cleanup(): Promise<void> {
    console.log("🧹 Starting cleanup...");

    // Stop hub container
    if (this.hubContainerId) {
      try {
        await execAsync(`docker stop ${this.hubContainerId}`);
        await execAsync(`docker rm ${this.hubContainerId}`);
        console.log("✅ Hub container stopped and removed");
      } catch (error) {
        console.error("⚠️  Error stopping hub:", error);
      }
    }

    // Cleanup all DigitalOcean servers
    await this.doManager.cleanupAllServers();

    // Remove Docker network
    try {
      await execAsync("docker network rm grid");
      console.log("✅ Docker network removed");
    } catch (error) {
      console.log("📝 Docker network cleanup (may not exist)");
    }

    console.log("✅ Cleanup complete!");
  }

  /**
   * Main orchestration flow
   */
  async run(): Promise<void> {
    console.log("🎭 Starting Selenium Orchestrator...\n");

    try {
      // Step 1: Start the hub
      await this.startHub();
      console.log("");

      // Step 2: Provision initial servers
      await this.provisionInitialServers(2);
      console.log("");

      // Step 3: Wait a bit for nodes to connect
      console.log("⏳ Waiting for nodes to connect to hub...");
      await new Promise((resolve) => setTimeout(resolve, 30000));

      // Step 4: Check grid status
      await this.checkGridStatus();
      console.log("");

      // Step 5: Run the test
      await this.runTest();
      console.log("");

      console.log("🎉 Orchestration complete!");
      console.log("💡 Tip: Run cleanup when done to avoid charges");
    } catch (error) {
      console.error("💥 Orchestration failed:", error);
      throw error;
    }
  }
}

// Handle graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n🛑 Received interrupt signal, cleaning up...");

  if (global.orchestrator) {
    await global.orchestrator.cleanup();
  }

  process.exit(0);
});

// Main execution
async function main() {
  const orchestrator = new SeleniumOrchestrator();
  global.orchestrator = orchestrator;

  try {
    await orchestrator.run();
  } catch (error) {
    console.error("💥 Fatal error:", error);
    await orchestrator.cleanup();
    process.exit(1);
  }
}

// Run if this file is executed directly
if (require.main === module) {
  main();
}

export { SeleniumOrchestrator };

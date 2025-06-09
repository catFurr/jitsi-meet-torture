#!/usr/bin/env node

const { spawn, exec } = require("child_process");
const fs = require("fs").promises;
const path = require("path");
const util = require("util");
const execAsync = util.promisify(exec);

class JitsiLoadTestOrchestrator {
  constructor(config) {
    this.config = {
      // Digital Ocean settings
      doToken: process.env.DO_TOKEN,
      sshKeyId: process.env.DO_SSH_KEY_ID,
      region: "nyc1",

      // Test settings
      jitsiUrl: config.jitsiUrl,
      maxParticipants: config.maxParticipants || 1000,
      incrementStep: config.incrementStep || 50,
      participantsPerNode: config.participantsPerNode || 80, // Conservative estimate

      // Infrastructure
      hubSize: "s-2vcpu-4gb",
      nodeSize: "s-4vcpu-8gb",

      autoCleanup: process.env.AUTO_CLEANUP !== "false",
      testsToRun:
        process.env.TESTS_TO_RUN || "PeerConnectionStatusTest,PSNRTest,UDPTest",

      ...config,
    };

    this.nodes = [];
    this.hubIp = null;
    this.testResults = [];
  }

  async runCompleteTest() {
    console.log("🚀 Starting complete Jitsi load test automation...\n");

    try {
      // Step 1: Calculate required infrastructure
      await this.calculateInfrastructure();

      // Step 2: Provision infrastructure
      await this.provisionInfrastructure();

      // Step 3: Setup and configure
      await this.setupInfrastructure();

      // Step 4: Run incremental load tests
      await this.runIncrementalTests();

      // Step 5: Generate comprehensive report
      await this.generateFinalReport();

      // Step 6: Cleanup (optional)
      if (this.config.autoCleanup) {
        await this.cleanup();
      }
    } catch (error) {
      console.error("❌ Test failed:", error.message);
      if (this.config.autoCleanup) {
        await this.cleanup();
      }
      throw error;
    }
  }

  async calculateInfrastructure() {
    const nodesNeeded = Math.ceil(
      this.config.maxParticipants / this.config.participantsPerNode
    );
    console.log(`📊 Infrastructure Planning:`);
    console.log(`   Max participants: ${this.config.maxParticipants}`);
    console.log(`   Participants per node: ${this.config.participantsPerNode}`);
    console.log(`   Nodes required: ${nodesNeeded}`);
    console.log(
      `   Estimated cost: $${((nodesNeeded + 1) * 0.071).toFixed(2)}/hour\n`
    );

    this.requiredNodes = nodesNeeded;
  }

  async provisionInfrastructure() {
    console.log("☁️  Provisioning Digital Ocean infrastructure...");

    // Create hub droplet
    console.log("   Creating Selenium Hub...");
    const hubData = await this.createDroplet("jitsi-hub", this.config.hubSize);
    this.hubIp = hubData.networks.v4.find(
      (n) => n.type === "public"
    ).ip_address;

    // Create initial nodes (we'll add more dynamically if needed)
    const initialNodes = Math.min(3, this.requiredNodes); // Start with 3 nodes
    console.log(`   Creating ${initialNodes} initial worker nodes...`);

    for (let i = 1; i <= initialNodes; i++) {
      const nodeData = await this.createDroplet(
        `jitsi-node-${i}`,
        this.config.nodeSize
      );
      this.nodes.push({
        id: nodeData.id,
        name: `jitsi-node-${i}`,
        ip: nodeData.networks.v4.find((n) => n.type === "public").ip_address,
        maxParticipants: this.config.participantsPerNode,
      });
    }

    console.log(`✅ Infrastructure provisioned. Hub IP: ${this.hubIp}\n`);

    // Wait for droplets to be ready
    console.log("⏳ Waiting for droplets to initialize...");
    await this.sleep(60000); // Wait 1 minute
  }

  async createDroplet(name, size) {
    const createCommand = `doctl compute droplet create ${name} \\
      --size ${size} \\
      --image ubuntu-22-04-x64 \\
      --region ${this.config.region} \\
      --ssh-keys ${this.config.sshKeyId} \\
      --wait \\
      --format ID,Name,PublicIPv4,Status \\
      --no-header`;

    const { stdout } = await execAsync(createCommand);
    const [id, , ip, status] = stdout.trim().split(/\s+/);

    return {
      id: parseInt(id),
      name,
      networks: { v4: [{ type: "public", ip_address: ip }] },
    };
  }

  async setupInfrastructure() {
    console.log("⚙️  Setting up infrastructure...");

    // Setup hub
    console.log("   Configuring Selenium Hub...");
    await this.setupHub();

    // Setup nodes
    console.log("   Configuring worker nodes...");
    for (const node of this.nodes) {
      await this.setupNode(node);
    }

    // Setup jitsi-meet-torture
    console.log("   Setting up jitsi-meet-torture...");
    await this.setupTorture();

    console.log("✅ Infrastructure setup complete\n");
  }

  async setupHub() {
    const setupScript = `#!/bin/bash
set -e
sudo apt update
sudo apt install -y docker.io docker-compose
sudo systemctl enable docker
sudo systemctl start docker
sudo usermod -aG docker ubuntu

# Start Selenium Hub
cat > docker-compose.yml << 'EOF'
version: '3'
services:
  selenium-hub:
    image: selenium/hub:4.15.0
    container_name: selenium-hub
    ports:
      - "4444:4444"
    environment:
      - GRID_MAX_SESSION=2000
      - GRID_BROWSER_TIMEOUT=600
      - GRID_TIMEOUT=600
      - GRID_NEW_SESSION_WAIT_TIMEOUT=600
EOF

sudo docker-compose up -d
sleep 10
echo "Hub setup complete"
`;

    await this.executeRemoteScript(this.hubIp, setupScript);
  }

  async setupNode(node) {
    const setupScript = `#!/bin/bash
set -e
sudo apt update
sudo apt install -y docker.io htop iotop
sudo systemctl enable docker
sudo systemctl start docker
sudo usermod -aG docker ubuntu

# Download test resources
mkdir -p /tmp/jitsi-resources
cd /tmp/jitsi-resources
wget -q https://github.com/jitsi/jitsi-meet-torture/releases/download/example-video-source/FourPeople_1280x720_30.y4m

# Create custom Chrome image with resources
cat > Dockerfile << 'EOF'
FROM selenium/node-chrome:4.15.0
RUN sudo mkdir -p /usr/share/jitsi-meet-torture
COPY FourPeople_1280x720_30.y4m /usr/share/jitsi-meet-torture/
RUN sudo apt-get update && sudo apt-get install -y pulseaudio
EOF

sudo docker build -t jitsi-chrome-node .

# Start Chrome nodes
cat > docker-compose.yml << 'EOF'
version: '3'
services:
  chrome-node:
    image: jitsi-chrome-node
    shm_size: 2gb
    environment:
      - HUB_HOST=${this.hubIp}
      - NODE_MAX_INSTANCES=${Math.floor(this.config.participantsPerNode / 2)}
      - NODE_MAX_SESSION=${this.config.participantsPerNode}
      - SE_EVENT_BUS_HOST=${this.hubIp}
      - SE_EVENT_BUS_PUBLISH_PORT=4442
      - SE_EVENT_BUS_SUBSCRIBE_PORT=4443
    volumes:
      - /dev/shm:/dev/shm
    deploy:
      replicas: 2
    restart: unless-stopped
EOF

sudo docker-compose up -d
echo "Node ${node.name} setup complete"
`;

    await this.executeRemoteScript(node.ip, setupScript);
  }

  async setupTorture() {
    const setupScript = `#!/bin/bash
set -e

# Install Java and Maven
sudo apt update
sudo apt install -y openjdk-11-jdk maven git

# Clone and setup jitsi-meet-torture
if [ ! -d "/opt/jitsi-meet-torture" ]; then
  sudo git clone https://github.com/jitsi/jitsi-meet-torture.git /opt/jitsi-meet-torture
  sudo chown -R ubuntu:ubuntu /opt/jitsi-meet-torture
fi

cd /opt/jitsi-meet-torture

# Download test resources
mkdir -p resources
wget -q -P resources https://github.com/jitsi/jitsi-meet-torture/releases/download/example-video-source/FourPeople_1280x720_30.y4m

echo "Torture setup complete"
`;

    await this.executeRemoteScript(this.hubIp, setupScript);
  }

  async runIncrementalTests() {
    console.log("🧪 Starting incremental load tests...\n");

    let currentNodes = this.nodes.length;

    for (
      let participants = this.config.incrementStep;
      participants <= this.config.maxParticipants;
      participants += this.config.incrementStep
    ) {
      // Check if we need more nodes
      const requiredNodes = Math.ceil(
        participants / this.config.participantsPerNode
      );
      if (requiredNodes > currentNodes) {
        console.log(
          `📈 Scaling up: Adding ${requiredNodes - currentNodes} more nodes...`
        );
        await this.addNodes(requiredNodes - currentNodes);
        currentNodes = requiredNodes;
      }

      console.log(`\n🔬 Testing with ${participants} participants...`);
      const result = await this.runSingleTest(participants);
      this.testResults.push(result);

      this.logTestResult(result);

      // Stop if we hit breaking point
      if (!result.success) {
        console.log(
          `💥 Breaking point reached at ${participants} participants`
        );
        break;
      }

      // Brief pause between tests
      console.log("⏳ Cooling down for 30 seconds...");
      await this.sleep(30000);
    }
  }

  async addNodes(count) {
    const startIndex = this.nodes.length + 1;

    for (let i = 0; i < count; i++) {
      const nodeIndex = startIndex + i;
      console.log(`   Adding node ${nodeIndex}...`);

      const nodeData = await this.createDroplet(
        `jitsi-node-${nodeIndex}`,
        this.config.nodeSize
      );
      const newNode = {
        id: nodeData.id,
        name: `jitsi-node-${nodeIndex}`,
        ip: nodeData.networks.v4.find((n) => n.type === "public").ip_address,
        maxParticipants: this.config.participantsPerNode,
      };

      this.nodes.push(newNode);

      // Wait for droplet to be ready and then configure it
      await this.sleep(45000); // Wait 45 seconds
      await this.setupNode(newNode);
    }

    console.log(`✅ Added ${count} nodes. Total nodes: ${this.nodes.length}`);
  }

  async runSingleTest(participants) {
    const startTime = Date.now();
    const result = {
      participants,
      success: false,
      errors: [],
      duration: 0,
      timestamp: new Date(),
      metrics: {},
    };

    try {
      // Generate remote participant flags
      const remoteFlags = [];
      for (let i = 1; i <= participants; i++) {
        remoteFlags.push(`-Dweb.participant${i}.isRemote=true`);
      }

      const testCommand = [
        "mvn",
        "test",
        `-Djitsi-meet.instance.url=${this.config.jitsiUrl}`,
        `-Djitsi-meet.tests.toRun=${this.config.testsToRun}`,
        `-Denable.headless=true`,
        `-Dremote.address=http://${this.hubIp}:4444/wd/hub`,
        `-Dremote.resource.path=/usr/share/jitsi-meet-torture`,
        `-Dtest.timeout=300`, // 5 minutes
        ...remoteFlags,
      ].join(" ");

      const testScript = `#!/bin/bash
cd /opt/jitsi-meet-torture
timeout 400 ${testCommand}
echo "EXIT_CODE: $?"
`;

      const output = await this.executeRemoteScript(this.hubIp, testScript);

      // Parse results from jitsi-meet-torture output
      result.success =
        output.includes("BUILD SUCCESS") || !output.includes("FAILURES");
      result.metrics = this.parseTestMetrics(output);

      if (!result.success) {
        const errors = output.match(/ERROR.*|FAILED.*/g) || [];
        result.errors = errors.slice(0, 5); // Limit error count
      }
    } catch (error) {
      result.errors.push(error.message);
      result.success = false;
    }

    result.duration = Date.now() - startTime;
    return result;
  }

  parseTestMetrics(output) {
    const metrics = {};

    // Extract participant join success rate
    const joinMatches = output.match(/(\d+)\s+participants?\s+joined/gi);
    if (joinMatches) {
      metrics.participantsJoined = parseInt(
        joinMatches[joinMatches.length - 1].match(/\d+/)[0]
      );
    }

    // Extract test duration
    const durationMatch = output.match(/Total time:\s+(\d+:\d+)/);
    if (durationMatch) {
      metrics.testDuration = durationMatch[1];
    }

    // Extract failure reasons
    const failureReasons = output.match(/(?:ERROR|FAILED):[^\n]*/g) || [];
    metrics.failureReasons = failureReasons.slice(0, 3);

    return metrics;
  }

  logTestResult(result) {
    const status = result.success ? "✅ PASS" : "❌ FAIL";
    const duration = (result.duration / 1000).toFixed(1);
    const joined = result.metrics.participantsJoined || 0;

    console.log(
      `   ${status} | ${result.participants} requested, ${joined} joined | ${duration}s | ${result.errors.length} errors`
    );

    if (result.errors.length > 0) {
      console.log(`   └─ Errors: ${result.errors.slice(0, 2).join(", ")}`);
    }
  }

  async generateFinalReport() {
    const maxSuccess = Math.max(
      ...this.testResults.filter((r) => r.success).map((r) => r.participants),
      0
    );
    const breakingPoint =
      this.testResults.find((r) => !r.success)?.participants || null;
    const totalCost = this.calculateCost();

    const report = {
      testConfig: {
        jitsiUrl: this.config.jitsiUrl,
        maxParticipants: this.config.maxParticipants,
        incrementStep: this.config.incrementStep,
        nodesUsed: this.nodes.length,
      },
      summary: {
        maxSuccessfulParticipants: maxSuccess,
        breakingPoint,
        totalTests: this.testResults.length,
        successRate: (
          (this.testResults.filter((r) => r.success).length /
            this.testResults.length) *
          100
        ).toFixed(1),
        estimatedCost: totalCost,
        recommendedCapacity: Math.floor(maxSuccess * 0.8), // 80% of max for safety margin
      },
      detailedResults: this.testResults,
      infrastructure: {
        hub: { ip: this.hubIp },
        nodes: this.nodes,
      },
    };

    const reportPath = `jitsi-load-test-report-${Date.now()}.json`;
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));

    // Console summary
    console.log("\n" + "=".repeat(60));
    console.log("🎯 JITSI LOAD TEST COMPLETE");
    console.log("=".repeat(60));
    console.log(`📊 Maximum successful participants: ${maxSuccess}`);
    console.log(`💥 Breaking point: ${breakingPoint || "Not reached"}`);
    console.log(
      `🎚️  Recommended capacity: ${report.summary.recommendedCapacity}`
    );
    console.log(`💰 Estimated cost: $${totalCost.toFixed(2)}`);
    console.log(`📄 Full report: ${reportPath}`);
    console.log("=".repeat(60));

    return report;
  }

  calculateCost() {
    const testDurationHours =
      this.testResults.reduce((sum, r) => sum + r.duration, 0) /
      (1000 * 60 * 60);
    const nodeHours = (this.nodes.length + 1) * Math.max(testDurationHours, 1); // +1 for hub
    return nodeHours * 0.071; // ~$0.071/hour average for our droplet sizes
  }

  async executeRemoteScript(ip, script) {
    const scriptPath = `/tmp/script-${Date.now()}.sh`;
    await fs.writeFile(scriptPath, script);

    const sshCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ubuntu@${ip} 'bash -s' < ${scriptPath}`;
    const { stdout, stderr } = await execAsync(sshCommand);

    await fs.unlink(scriptPath); // cleanup

    if (stderr && !stderr.includes("Warning")) {
      throw new Error(`SSH execution failed: ${stderr}`);
    }

    return stdout;
  }

  async cleanup() {
    console.log("\n🧹 Cleaning up infrastructure...");

    // Delete all droplets
    const allDroplets = [{ name: "jitsi-hub" }, ...this.nodes];

    for (const droplet of allDroplets) {
      try {
        await execAsync(`doctl compute droplet delete ${droplet.name} --force`);
        console.log(`   ✅ Deleted ${droplet.name}`);
      } catch (error) {
        console.log(
          `   ⚠️  Failed to delete ${droplet.name}: ${error.message}`
        );
      }
    }

    console.log("✅ Cleanup complete");
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Configuration and startup
const config = {
  jitsiUrl: process.env.JITSI_URL || "https://meet.jit.si",
  maxParticipants: parseInt(process.env.MAX_PARTICIPANTS) || 1000,
  incrementStep: parseInt(process.env.INCREMENT_STEP) || 50,
  participantsPerNode: parseInt(process.env.PARTICIPANTS_PER_NODE) || 80,
  autoCleanup: process.env.AUTO_CLEANUP !== "false",
  testsToRun:
    process.env.TESTS_TO_RUN || "PeerConnectionStatusTest,PSNRTest,UDPTest",
};

// Validate required environment variables
if (!process.env.DO_TOKEN) {
  console.error("❌ DO_TOKEN environment variable is required");
  process.exit(1);
}

if (!process.env.DO_SSH_KEY_ID) {
  console.error("❌ DO_SSH_KEY_ID environment variable is required");
  process.exit(1);
}

// Main execution
const orchestrator = new JitsiLoadTestOrchestrator(config);

// Handle graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n🛑 Received interrupt signal...");
  if (config.autoCleanup) {
    await orchestrator.cleanup();
  }
  process.exit(0);
});

// Start the complete test
orchestrator
  .runCompleteTest()
  .then(() => {
    console.log("\n🎉 Load testing completed successfully!");
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n💀 Load testing failed:", error.message);
    process.exit(1);
  });

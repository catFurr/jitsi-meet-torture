import { exec } from "child_process";
import { promisify } from "util";
import * as dotenv from "dotenv";
import { DigitalOceanManager } from "../infra/digitalocean";

// Load environment variables
dotenv.config();

const execAsync = promisify(exec);

async function cleanup() {
  console.log("🧹 Starting cleanup process...\n");

  // Cleanup Docker containers
  console.log("🐳 Cleaning up Docker containers...");

  try {
    // Stop and remove selenium hub containers
    await execAsync(
      "docker stop $(docker ps -q --filter ancestor=selenium/hub:latest) 2>/dev/null || true"
    );
    await execAsync(
      "docker rm $(docker ps -aq --filter ancestor=selenium/hub:latest) 2>/dev/null || true"
    );

    // Stop and remove selenium node containers
    await execAsync(
      "docker stop $(docker ps -q --filter ancestor=selenium/node-chrome:latest) 2>/dev/null || true"
    );
    await execAsync(
      "docker rm $(docker ps -aq --filter ancestor=selenium/node-chrome:latest) 2>/dev/null || true"
    );

    // Remove grid network
    await execAsync("docker network rm grid 2>/dev/null || true");

    console.log("✅ Docker cleanup complete");
  } catch (error) {
    console.log(
      "⚠️  Docker cleanup completed (some containers may not have existed)"
    );
  }

  // Cleanup DigitalOcean droplets
  const apiKey = process.env.DO_API_KEY;
  if (apiKey) {
    console.log("\n🌊 Cleaning up DigitalOcean droplets...");

    try {
      const doManager = new DigitalOceanManager(apiKey);

      // Find and cleanup droplets with selenium-node tag
      const client = (doManager as any).client;
      const droplets = await client.droplets.list();

      const seleniumDroplets = droplets.filter(
        (droplet: any) =>
          droplet.tags.includes("selenium-node") ||
          droplet.tags.includes("auto-provisioned")
      );

      if (seleniumDroplets.length > 0) {
        console.log(
          `Found ${seleniumDroplets.length} selenium droplets to cleanup:`
        );

        for (const droplet of seleniumDroplets) {
          console.log(`- ${droplet.name} (${droplet.id})`);
          try {
            await client.droplets.delete(droplet.id);
            console.log(`  ✅ Deleted ${droplet.name}`);
          } catch (error) {
            console.log(`  ❌ Failed to delete ${droplet.name}: ${error}`);
          }
        }
      } else {
        console.log("No selenium droplets found to cleanup");
      }

      console.log("✅ DigitalOcean cleanup complete");
    } catch (error) {
      console.error("❌ DigitalOcean cleanup failed:", error);
    }
  } else {
    console.log("\n⚠️  No DO_API_KEY found, skipping DigitalOcean cleanup");
  }

  console.log("\n🎉 Cleanup process complete!");
}

// Run cleanup
cleanup().catch((error) => {
  console.error("💥 Cleanup failed:", error);
  process.exit(1);
});

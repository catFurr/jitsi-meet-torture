import * as digitalocean from "digitalocean";
import { Client as SSHClient } from "ssh2";

// Defines a class with functions related to:
// - Provisioning new servers
// - Getting overall servers status
// - Shutting down and cleaning up
// - running commands on a particular server

// The object is initialized by the orchestrator
// It maintains important system state such as:
// - The number of servers being used
// - Status of each server
// - etc

// Use the recommended community run DO client library for ts
// https://dots.pimentel.co/

interface ServerInfo {
  id: number;
  name: string;
  ip: string;
  status: "creating" | "active" | "busy" | "idle";
  createdAt: Date;
}

export class DigitalOceanManager {
  private client: any;
  private servers: Map<number, ServerInfo> = new Map();
  private serverSize: string;
  private serverRegion: string;

  constructor(
    apiKey: string,
    serverSize: string = "s-1vcpu-1gb",
    serverRegion: string = "nyc1"
  ) {
    this.client = digitalocean.client(apiKey);
    this.serverSize = serverSize;
    this.serverRegion = serverRegion;
  }

  /**
   * Provision a new server with Selenium node setup
   */
  async provisionServer(name: string, hubIp: string): Promise<ServerInfo> {
    console.log(`🚀 Provisioning new server: ${name}`);

    // Cloud-init script to setup Docker and start Selenium node
    const userData = `#!/bin/bash
apt-get update
apt-get install -y docker.io
systemctl start docker
systemctl enable docker
usermod -aG docker root

# Pull Selenium node image
docker pull selenium/node-chrome:latest

# Start Selenium node container
docker run -d \\
  --name selenium-node \\
  --shm-size="2g" \\
  -e SE_EVENT_BUS_HOST=${hubIp} \\
  -e SE_EVENT_BUS_PUBLISH_PORT=4442 \\
  -e SE_EVENT_BUS_SUBSCRIBE_PORT=4443 \\
  selenium/node-chrome:latest

echo "Selenium node setup complete" > /var/log/selenium-setup.log
`;

    const dropletRequest = {
      name,
      region: this.serverRegion,
      size: this.serverSize,
      image: "ubuntu-22-04-x64",
      user_data: userData,
      tags: ["selenium-node", "auto-provisioned"],
    };

    try {
      const response = await this.client.droplets.create(dropletRequest);
      const droplet = response.data.droplet;

      const serverInfo: ServerInfo = {
        id: droplet.id,
        name: droplet.name,
        ip: "", // Will be populated once active
        status: "creating",
        createdAt: new Date(),
      };

      this.servers.set(droplet.id, serverInfo);
      console.log(`✅ Server ${name} created with ID: ${droplet.id}`);

      return serverInfo;
    } catch (error) {
      console.error(`❌ Failed to provision server ${name}:`, error);
      throw error;
    }
  }

  /**
   * Wait for server to be active and get its IP
   */
  async waitForServerReady(
    serverId: number,
    timeoutMs: number = 300000
  ): Promise<string> {
    console.log(`⏳ Waiting for server ${serverId} to be ready...`);

    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      try {
        const response = await this.client.droplets.getById(serverId);
        const droplet = response.data.droplet;

        if (droplet.status === "active" && droplet.networks?.v4?.length > 0) {
          const publicIp = droplet.networks.v4.find(
            (net) => net.type === "public"
          )?.ip_address;

          if (publicIp) {
            const serverInfo = this.servers.get(serverId);
            if (serverInfo) {
              serverInfo.ip = publicIp;
              serverInfo.status = "active";
              this.servers.set(serverId, serverInfo);
            }

            console.log(`✅ Server ${serverId} is ready at IP: ${publicIp}`);
            return publicIp;
          }
        }
      } catch (error) {
        console.error(`Error checking server status:`, error);
      }

      await new Promise((resolve) => setTimeout(resolve, 10000)); // Wait 10 seconds
    }

    throw new Error(`Server ${serverId} did not become ready within timeout`);
  }

  /**
   * Get status of all servers
   */
  getServersStatus(): ServerInfo[] {
    return Array.from(this.servers.values());
  }

  /**
   * Get number of active servers
   */
  getActiveServerCount(): number {
    return Array.from(this.servers.values()).filter(
      (s) => s.status === "active" || s.status === "busy"
    ).length;
  }

  /**
   * Run a command on a specific server via SSH
   */
  async runCommandOnServer(serverId: number, command: string): Promise<string> {
    const serverInfo = this.servers.get(serverId);
    if (!serverInfo || !serverInfo.ip) {
      throw new Error(`Server ${serverId} not found or not ready`);
    }

    return new Promise((resolve, reject) => {
      const conn = new SSHClient();
      let output = "";

      conn
        .on("ready", () => {
          conn.exec(command, (err, stream) => {
            if (err) {
              conn.end();
              return reject(err);
            }

            stream
              .on("close", () => {
                conn.end();
                resolve(output);
              })
              .on("data", (data: Buffer) => {
                output += data.toString();
              })
              .stderr.on("data", (data: Buffer) => {
                output += data.toString();
              });
          });
        })
        .connect({
          host: serverInfo.ip,
          username: "root",
          privateKey: require("fs").readFileSync(
            process.env.SSH_PRIVATE_KEY_PATH || "~/.ssh/id_rsa"
          ),
        });
    });
  }

  /**
   * Shutdown and cleanup a specific server
   */
  async shutdownServer(serverId: number): Promise<void> {
    console.log(`🔄 Shutting down server ${serverId}`);

    try {
      await this.client.droplets.deleteById(serverId);
      this.servers.delete(serverId);
      console.log(`✅ Server ${serverId} shut down successfully`);
    } catch (error) {
      console.error(`❌ Failed to shutdown server ${serverId}:`, error);
      throw error;
    }
  }

  /**
   * Cleanup all servers
   */
  async cleanupAllServers(): Promise<void> {
    console.log(`🧹 Cleaning up all ${this.servers.size} servers...`);

    const shutdownPromises = Array.from(this.servers.keys()).map((id) =>
      this.shutdownServer(id).catch((err) =>
        console.error(`Failed to shutdown ${id}:`, err)
      )
    );

    await Promise.all(shutdownPromises);
    console.log(`✅ All servers cleaned up`);
  }
}

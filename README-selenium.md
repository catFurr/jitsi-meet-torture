# Selenium Grid Orchestrator

Automated distributed Selenium testing with dynamic DigitalOcean node provisioning.

## Quick Setup

1. **Install dependencies:**

   ```bash
   bun install
   ```

2. **Setup environment:**

   ```bash
   cp example.env .env
   # Edit .env with your DigitalOcean API key
   ```

3. **Ensure Docker is running:**

   ```bash
   docker --version
   ```

4. **Run the orchestrator:**
   ```bash
   bun run start
   ```

## What it does:

1. ✅ Starts Selenium Grid Hub locally (Docker)
2. 🚀 Provisions 2 DigitalOcean droplets with Selenium Chrome nodes
3. 🔗 Nodes auto-connect to the hub
4. 🧪 Runs a test that navigates to sonacove.com → clicks "Get Started" → verifies onboarding page
5. 📊 Shows grid status and test results

## Environment Variables:

- `DO_API_KEY` - Your DigitalOcean API key (required)
- `SERVER_SIZE` - Droplet size (default: s-1vcpu-1gb)
- `SERVER_REGION` - Droplet region (default: nyc1)
- `SSH_PRIVATE_KEY_PATH` - Path to SSH private key (default: ~/.ssh/id_rsa)

## Cleanup:

The orchestrator automatically cleans up on Ctrl+C, but you can also run cleanup manually:

```bash
bun run cleanup
```

Or manually with Docker commands:
```bash
# Stop any running containers
docker stop $(docker ps -q --filter ancestor=selenium/hub:latest)
docker stop $(docker ps -q --filter ancestor=selenium/node-chrome:latest)

# Remove containers
docker rm $(docker ps -aq --filter ancestor=selenium/hub:latest)
docker rm $(docker ps -aq --filter ancestor=selenium/node-chrome:latest)

# Remove network
docker network rm grid
```

## Files:

- `orchestrator/index.ts` - Main orchestrator logic
- `infra/digitalocean.ts` - DigitalOcean server management
- `selenium/sonacove-test.js` - Sample Selenium test
- `.env` - Environment configuration

## Next Steps:

- Add more tests to the `selenium/` folder
- Implement dynamic scaling based on queue length
- Add test result reporting and storage
- Set up monitoring and alerting

#!/bin/bash

# Jitsi Load Test - Easy Setup Script
# Run this once to set up everything needed

set -e

echo "🚀 Setting up Jitsi Load Testing Environment..."

# Check if running on compatible system
if [[ "$OSTYPE" != "linux-gnu"* ]] && [[ "$OSTYPE" != "darwin"* ]]; then
    echo "❌ This script requires Linux or macOS"
    exit 1
fi

# Install required tools
echo "📦 Installing required tools..."

# Install Node.js if not present
if ! command -v node &> /dev/null; then
    echo "Installing Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

# Install doctl if not present
if ! command -v doctl &> /dev/null; then
    echo "Installing Digital Ocean CLI..."
    cd /tmp
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        wget https://github.com/digitalocean/doctl/releases/download/v1.106.0/doctl-1.106.0-linux-amd64.tar.gz
        tar xf doctl-1.106.0-linux-amd64.tar.gz
        sudo mv doctl /usr/local/bin
        rm doctl-1.106.0-linux-amd64.tar.gz
    elif [[ "$OSTYPE" == "darwin"* ]]; then
        brew install doctl
    fi
fi

# Create project directory
mkdir -p ./jitsi-load-test
cd ./jitsi-load-test

# Download the main script
echo "📥 Downloading test scripts..."

# !! IMPORTANT !!
# Please push 'jitsi-auto-tester.js' to a public GitHub repository
# and update the following variables with your repository details.
GITHUB_USER="catFurr"
GITHUB_REPO="jitsi-meet-torture"
SCRIPT_PATH="jitsi-auto-tester.js" # The path to the script in your repo

# Construct the download URL
DOWNLOAD_URL="https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/main/${SCRIPT_PATH}"

echo "   Downloading from ${DOWNLOAD_URL}"
if ! curl -sSLf "${DOWNLOAD_URL}" -o jitsi-auto-tester.js; then
    echo "❌ Failed to download jitsi-auto-tester.js."
    echo "   Please check the GitHub URL and ensure the repository is public."
    exit 1
fi

# Create package.json for any additional dependencies
cat > package.json << 'EOF'
{
  "name": "jitsi-load-tester",
  "version": "1.0.0",
  "description": "Automated Jitsi load testing",
  "main": "jitsi-auto-tester.js",
  "dependencies": {},
  "bin": {
    "jitsi-load-test": "./jitsi-auto-tester.js"
  }
}
EOF

# Make the main script executable
chmod +x jitsi-auto-tester.js

# Create environment template
cat > .env.example << 'EOF'
# Digital Ocean Configuration
DO_TOKEN=your_do_token_here
DO_SSH_KEY_ID=your_ssh_key_id_here
# Absolute path to the private SSH key corresponding to the public key used on Digital Ocean.
# Example: /Users/yourname/.ssh/id_ed25519
SSH_PRIVATE_KEY_PATH=

# Test Configuration
JITSI_URL=https://your-jitsi-instance.com
MAX_PARTICIPANTS=1000
INCREMENT_STEP=50
PARTICIPANTS_PER_NODE=80

# The comma-separated list of tests to run.
# Recommended: PeerConnectionStatusTest,PSNRTest,UDPTest
# - PeerConnectionStatusTest: Checks connection stability.
# - PSNRTest: Measures video quality degradation.
# - UDPTest: Ensures optimal media transport is used.
TESTS_TO_RUN=PeerConnectionStatusTest,PSNRTest,UDPTest

# Cleanup (set to false to keep infrastructure after test)
AUTO_CLEANUP=true
EOF

echo ""
echo "✅ Setup complete!"
echo ""
echo "📋 Next steps:"
echo "1. Get your Digital Ocean API token from: https://cloud.digitalocean.com/account/api/tokens"
echo "2. Get your SSH key ID with: doctl compute ssh-key list"
echo "3. Copy .env.example to .env and fill in your values"
echo "4. Run the test with: ./run-load-test.sh"
echo ""

# Create simple run script
cat > run-load-test.sh << 'EOF'
#!/bin/bash

# Load environment variables
if [ -f .env ]; then
    export $(cat .env | grep -v '^#' | xargs)
else
    echo "❌ Please create .env file from .env.example"
    exit 1
fi

# Validate required variables
if [ -z "$DO_TOKEN" ] || [ -z "$DO_SSH_KEY_ID" ]; then
    echo "❌ Please set DO_TOKEN and DO_SSH_KEY_ID in .env file"
    exit 1
fi

# Initialize doctl
doctl auth init --access-token $DO_TOKEN

echo "🎯 Starting Jitsi Load Test..."
echo "Target: $JITSI_URL"
echo "Max participants: $MAX_PARTICIPANTS"
echo ""

# Run the test
node jitsi-auto-tester.js
EOF

chmod +x run-load-test.sh

echo "🎬 Ready to run! From the './jitsi-load-test' directory, execute: ./run-load-test.sh"
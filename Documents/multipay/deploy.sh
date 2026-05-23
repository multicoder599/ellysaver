#!/bin/bash
# MultiPay Deployment Script

echo "=== MultiPay Deployment ==="

# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js if not present
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt install -y nodejs
fi

# Install MongoDB if not present
if ! command -v mongod &> /dev/null; then
    sudo apt install -y mongodb
    sudo systemctl start mongod
    sudo systemctl enable mongod
fi

# Install PM2 globally
sudo npm install -g pm2

# Install Nginx
sudo apt install -y nginx

# Navigate to backend
cd ~/multipay/backend

# Install dependencies
npm install --production

# Create logs directory
mkdir -p logs

# Create .env from example if not exists
if [ ! -f .env ]; then
    cp .env.example .env
    echo "Please edit .env with your Megapay credentials before starting!"
fi

# Start with PM2
pm2 start ecosystem.config.js
pm2 save
pm2 startup

echo "=== Deployment Complete ==="
echo "Edit /etc/nginx/sites-available/default for reverse proxy"
echo "Run: sudo certbot --nginx -d yourdomain.com"

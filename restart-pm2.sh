#!/bin/bash
# Restart bot with PM2

echo "🔄 Restarting Coup Bot with PM2..."

# Check if PM2 is installed
if ! command -v pm2 &> /dev/null; then
    echo "❌ PM2 is not installed. Install it with: npm install -g pm2"
    exit 1
fi

# Try to restart, if it fails, delete and start fresh
if pm2 restart beige-bot 2>/dev/null; then
    echo "✅ Process restarted successfully"
else
    echo "⚠️  Restart failed. Cleaning up and starting fresh..."
    # Delete the process if it exists (even if corrupted)
    pm2 delete beige-bot 2>/dev/null || true
    # Start fresh
    pm2 start ecosystem.config.cjs --env production
fi

# Save PM2 process list
pm2 save 2>/dev/null || true

echo "✅ Bot restarted!"
echo "Run 'pm2 logs beige-bot' to view logs"


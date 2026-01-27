#!/bin/bash
# Stop bot with PM2

echo "🛑 Stopping Coup Bot..."

# Check if PM2 is installed
if ! command -v pm2 &> /dev/null; then
    echo "❌ PM2 is not installed. Install it with: npm install -g pm2"
    exit 1
fi

# Try to stop, if it fails, try to delete
if pm2 stop beige-bot 2>/dev/null; then
    echo "✅ Bot stopped!"
elif pm2 delete beige-bot 2>/dev/null; then
    echo "✅ Bot process removed!"
else
    echo "⚠️  Process not found or already stopped"
fi

# Save PM2 process list
pm2 save 2>/dev/null || true

echo "Run './start-pm2.sh' to start again"


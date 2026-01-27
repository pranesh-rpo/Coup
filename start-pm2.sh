#!/bin/bash
# Start bot with PM2 - Keep online always

echo "🚀 Starting Coup Bot with PM2..."

# Check if PM2 is installed
if ! command -v pm2 &> /dev/null; then
    echo "❌ PM2 is not installed. Install it with: npm install -g pm2"
    exit 1
fi

# Check if process already exists
PM2_STATUS=$(pm2 jlist 2>/dev/null | grep -o '"name":"beige-bot"' || echo "")

if [ -n "$PM2_STATUS" ]; then
    # Process exists, check if it's running
    PROCESS_STATUS=$(pm2 jlist 2>/dev/null | grep -A 5 '"name":"beige-bot"' | grep -o '"pm2_env":{"status":"[^"]*"' | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
    
    if [ "$PROCESS_STATUS" = "online" ]; then
        echo "ℹ️  Bot is already running. Use './restart-pm2.sh' to restart it."
        pm2 status
        exit 0
    else
        echo "⚠️  Process exists but is stopped. Deleting and starting fresh..."
        pm2 delete beige-bot 2>/dev/null || true
    fi
fi

# Start the bot using ecosystem config
pm2 start ecosystem.config.cjs --env production

# Save PM2 process list (so it restarts on server reboot)
pm2 save

echo "✅ Bot started with PM2!"
echo ""
echo "📊 Useful commands:"
echo "  pm2 status           - Check bot status"
echo "  pm2 logs beige-bot   - View logs"
echo "  pm2 monit            - Monitor in real-time"
echo "  pm2 restart beige-bot - Restart bot"
echo "  pm2 stop beige-bot   - Stop bot"
echo ""
echo "💡 To auto-start on server reboot, run: pm2 startup"


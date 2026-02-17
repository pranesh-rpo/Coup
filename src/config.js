import dotenv from 'dotenv';

dotenv.config();

export const config = {
  botToken: process.env.BOT_TOKEN,
  apiId: parseInt(process.env.API_ID, 10),
  apiHash: process.env.API_HASH,
  sessionPath: process.env.SESSION_PATH || './sessions',
  botUsername: process.env.BOT_USERNAME || 'Coup Bot',
  appVersion: process.env.APP_VERSION || 'v0.2.3',
  
  // SQLite Database Configuration
  dbPath: process.env.DB_PATH || './data/bot.db',
  
  // Verification Channel
  verificationChannel: process.env.VERIFICATION_CHANNEL,
  verificationChannelId: parseInt(process.env.VERIFICATION_CHANNEL_ID, 10),
  
  // Updates Channel (auto-join on account link)
  // Can be a single channel or comma-separated list: "channel1,channel2"
  updatesChannel: process.env.UPDATES_CHANNEL || 'BeigeBotUpdates',
  // Parse multiple updates channels
  getUpdatesChannels() {
    if (!this.updatesChannel) return [];
    return this.updatesChannel.split(',').map(ch => ch.trim()).filter(ch => ch);
  },
  
  // Admin Broadcast Channel
  // Messages posted in this channel will be automatically forwarded to all users
  adminBroadcastChannel: process.env.ADMIN_BROADCAST || null,
  
  // Logger Bots
  loggerBotToken: process.env.LOGGER_BOT_TOKEN,
  userLoggerBotToken: process.env.USER_LOGGER_BOT_TOKEN,
  
  // Security
  encryptionKey: process.env.ENCRYPTION_KEY,
  
  // AI / Text Enhancement
  groqApiKey: process.env.GROQ_API_KEY,
  huggingfaceApiKey: process.env.HUGGINGFACE_API_KEY,
  ollamaApiUrl: process.env.OLLAMA_API_URL,
  aiDefaultProvider: process.env.AI_DEFAULT_PROVIDER || 'groq',
  aiModelGroq: process.env.AI_MODEL_GROQ || 'llama-3.1-8b-instant',
  aiMaxTokens: parseInt(process.env.AI_MAX_TOKENS || '500', 10),
  aiTemperature: parseFloat(process.env.AI_TEMPERATURE || '0.7'),
  aiTimeout: parseInt(process.env.AI_TIMEOUT || '30', 10),
  
  // Admin
  adminIds: (process.env.ADMIN_IDS || '')
    .split(',')
    .filter(x => x)
    .map(x => parseInt(x, 10))
    .filter(x => !isNaN(x)), // Remove NaN values from invalid entries
  adminBotToken: process.env.ADMIN_BOT_TOKEN,
  adminChatIds: (process.env.ADMIN_CHAT_IDS || '')
    .split(',')
    .filter(x => x)
    .map(x => parseInt(x, 10))
    .filter(x => !isNaN(x)), // Remove NaN values from invalid entries
  
  // Main Account (the account used to create the bot and APIs)
  // This account should never be deleted or marked for re-authentication
  mainAccountPhone: process.env.MAIN_ACCOUNT_PHONE ? process.env.MAIN_ACCOUNT_PHONE.trim() : null,
  
  // Broadcast Settings
  minInterval: 5, // minutes
  maxInterval: 15, // minutes
  messagesPerHour: 5,
  
  // Auto-breaking Settings
  autoBreakDuration: 3.27, // hours before taking a break
  autoBreakLength: 53, // minutes break duration
  
  // Anti-Freeze Security Settings - Removed all hard limits and caps
  antiFreeze: {
    // Minimum delay between messages (milliseconds) - configurable via env
    minDelayBetweenMessages: parseInt(process.env.MIN_DELAY_BETWEEN_MESSAGES, 10) || 8000, // 8 seconds default for safety
    // Maximum delay between messages (milliseconds) - configurable via env
    maxDelayBetweenMessages: parseInt(process.env.MAX_DELAY_BETWEEN_MESSAGES, 10) || 15000, // 15 seconds default for safety
    // Randomize group order to avoid patterns
    randomizeOrder: true,
    // Add random jitter to cycle timing (±15% for more natural behavior)
    cycleJitterPercent: 15,
    // Progressive delay multiplier on rate limit (multiplies base delay)
    rateLimitDelayMultiplier: 4, // Increased from 3 for better safety
    // Maximum delay when rate limited (milliseconds)
    maxRateLimitDelay: 180000, // 180 seconds (3 minutes) for better flood wait handling
    // Batch size before taking a break - NO LIMIT, user controls via settings
    batchSize: parseInt(process.env.BATCH_SIZE, 10) || 999999, // No batch limit
    // Break duration after batch (milliseconds) - only used if batch size set
    batchBreakDuration: parseInt(process.env.BATCH_BREAK_DURATION, 10) || 90000, // 90 seconds if batching used
    // Maximum messages per minute globally - NO LIMIT, only flood wait handling
    maxMessagesPerMinute: parseInt(process.env.MAX_MESSAGES_PER_MINUTE, 10) || 999999, // No limit
    // Maximum messages per hour globally - NO LIMIT, only flood wait handling
    maxMessagesPerHour: parseInt(process.env.MAX_MESSAGES_PER_HOUR, 10) || 999999, // No limit
    // Per-group cooldown period (milliseconds) - prevent sending to same group too frequently
    perGroupCooldown: parseInt(process.env.PER_GROUP_COOLDOWN, 10) || 600000, // 10 minutes between messages to same group (increased for safety)
    // Maximum messages per day per account - NO LIMIT ENFORCED
    maxMessagesPerDay: parseInt(process.env.MAX_MESSAGES_PER_DAY, 10) || 999999, // No limit enforced
  },
  
  // Webhook Settings
  webhookUrl: process.env.WEBHOOK_URL, // Full URL where Telegram will send updates (e.g., https://yourdomain.com/webhook)
  webhookPort: parseInt(process.env.WEBHOOK_PORT, 10) || 3000, // Port for webhook server
  webhookSecretToken: process.env.WEBHOOK_SECRET_TOKEN || '', // Optional secret token for webhook verification
  
  
  // Profile Settings
  firstName: process.env.FIRSTNAME || '', // First name for account profile
  lastNameTag: process.env.LASTNAME_TAG || '| Coup Bot 🪽', // Last name tag for account profile
  bioTag: process.env.BIO_TAG || 'Powered by @CoupBot  🤖🚀', // Bio tag for account profile
};

if (!config.botToken) {
  throw new Error('BOT_TOKEN is required in .env file');
}

if (!config.apiId || !config.apiHash) {
  throw new Error('API_ID and API_HASH are required in .env file');
}

// SQLite doesn't require DB_NAME - it uses a file path (dbPath)
// dbPath defaults to ./data/bot.db if not specified

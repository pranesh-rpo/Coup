/**
 * Logger Bot Service
 * Sends logs to users about their account activity
 * Only sends logs to users who have started the logger bot
 * Handles banned logger bot gracefully (doesn't violate Telegram rules)
 */

import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config.js';
import db from '../database/db.js';
import logger, { logError } from '../utils/logger.js';
import { safeBotApiCall } from '../utils/floodWaitHandler.js';

class LoggerBotService {
  constructor() {
    this.bot = null;
    this.initialized = false;
    this.blockedUsers = new Set(); // Track users who have blocked the logger bot
  }

  /**
   * Initialize the logger bot
   */
  async initialize() {
    if (!config.userLoggerBotToken) {
      console.log('[LOGGER_BOT] ⚠️ USER_LOGGER_BOT_TOKEN not configured. Logger bot disabled.');
      return;
    }

    try {
      this.bot = new TelegramBot(config.userLoggerBotToken, {
        polling: {
          interval: 300,
          autoStart: false,
          params: {
            timeout: 10,
            allowed_updates: ['message', 'callback_query']
          }
        }
      });

      // Delete any existing webhook
      try {
        await this.bot.deleteWebHook({ drop_pending_updates: false });
      } catch (error) {
        // Ignore errors - webhook might not exist
      }

      // Start polling
      await this.bot.startPolling();
      console.log('[LOGGER_BOT] ✅ Logger bot initialized and polling started');

      // Set up handlers
      this.setupHandlers();
      this.initialized = true;
    } catch (error) {
      logError('[LOGGER_BOT] Error initializing logger bot:', error);
      this.initialized = false;
    }
  }

  /**
   * Set up bot handlers
   */
  setupHandlers() {
    // Handle /start command
    this.bot.onText(/\/start/, async (msg) => {
      try {
        const userId = msg.from?.id;
        const chatId = msg.chat?.id;

        if (!userId || !chatId) {
          return;
        }

        // Mark user as having started the logger bot
        await this.markLoggerBotStarted(userId, true);
        
        // Remove from blocked list if they start again
        if (this.blockedUsers.has(userId)) {
          this.blockedUsers.delete(userId);
        }

        try {
          await this.bot.sendMessage(
            chatId,
            '✅ <b>Logger Bot Started</b>\n\n' +
            'You will now receive logs about your account activity, including:\n' +
            '• Broadcast status updates\n' +
            '• Account activity notifications\n' +
            '• Important system messages\n\n' +
            'You can stop receiving logs by blocking this bot.',
            { parse_mode: 'HTML' }
          );

          logger.logChange('LOGGER_BOT_STARTED', userId, 'User started logger bot');
        } catch (sendError) {
          // Check if user blocked the bot
          const errorMessage = sendError.message || sendError.toString() || '';
          const isBotBlocked = errorMessage.includes('bot was blocked') ||
                              errorMessage.includes('bot blocked') ||
                              errorMessage.includes('BLOCKED') ||
                              errorMessage.includes('chat not found') ||
                              (sendError.code === 403 && errorMessage.includes('forbidden'));

          if (isBotBlocked) {
            // User blocked the bot - mark them and don't mark as started
            this.blockedUsers.add(userId);
            await this.markLoggerBotStarted(userId, false);
            console.log(`[LOGGER_BOT] User ${userId} has blocked the logger bot - marked as blocked`);
            // Don't log as error - this is expected behavior
            return;
          }
          
          // For other errors, log but don't fail
          logError('[LOGGER_BOT] Error sending welcome message:', sendError);
        }
      } catch (error) {
        // Check if it's a blocked user error
        const errorMessage = error.message || error.toString() || '';
        const isBotBlocked = errorMessage.includes('bot was blocked') ||
                            errorMessage.includes('bot blocked') ||
                            errorMessage.includes('BLOCKED') ||
                            errorMessage.includes('chat not found') ||
                            (error.code === 403 && errorMessage.includes('forbidden'));

        if (isBotBlocked) {
          // User blocked the bot - mark them
          const userId = msg.from?.id;
          if (userId) {
            this.blockedUsers.add(userId);
            await this.markLoggerBotStarted(userId, false);
            console.log(`[LOGGER_BOT] User ${userId} has blocked the logger bot - marked as blocked`);
          }
          // Don't log as error - this is expected behavior
          return;
        }
        
        logError('[LOGGER_BOT] Error handling /start:', error);
      }
    });

    // Handle errors (user blocked bot, etc.)
    this.bot.on('error', (error) => {
      // Check if it's a blocked user error
      const errorMessage = error.message || error.toString() || '';
      if (errorMessage.includes('bot was blocked') || 
          errorMessage.includes('bot blocked') ||
          errorMessage.includes('BLOCKED') ||
          errorMessage.includes('chat not found')) {
        // This is expected - user blocked the bot, we'll handle it gracefully
        console.log('[LOGGER_BOT] User blocked the logger bot (this is normal)');
      } else {
        logError('[LOGGER_BOT] Bot error:', error);
      }
    });
  }

  /**
   * Check if user has started the logger bot
   */
  async hasLoggerBotStarted(userId) {
    try {
      const result = await db.query(
        'SELECT logger_bot_started FROM users WHERE user_id = ?',
        [userId]
      );

      if (!result.rows || result.rows.length === 0) {
        return false;
      }

      return result.rows[0].logger_bot_started === 1;
    } catch (error) {
      logError('[LOGGER_BOT] Error checking logger bot status:', error);
      return false;
    }
  }

  /**
   * Mark logger bot as started/stopped for a user
   */
  async markLoggerBotStarted(userId, started) {
    try {
      await db.query(
        'UPDATE users SET logger_bot_started = ? WHERE user_id = ?',
        [started ? 1 : 0, userId]
      );
    } catch (error) {
      logError('[LOGGER_BOT] Error updating logger bot status:', error);
    }
  }

  /**
   * Send log message to user (only if they started the logger bot)
   */
  async sendLog(userId, message, options = {}) {
    // Check if logger bot is configured
    if (!config.userLoggerBotToken || !this.initialized || !this.bot) {
      return { success: false, error: 'Logger bot not configured' };
    }

    // Check if user has started the logger bot
    const hasStarted = await this.hasLoggerBotStarted(userId);
    if (!hasStarted) {
      return { success: false, error: 'User has not started logger bot' };
    }

    // Check if user has blocked the bot
    if (this.blockedUsers.has(userId)) {
      return { success: false, error: 'User has blocked logger bot' };
    }

    try {
      const sendResult = await safeBotApiCall(
        () => this.bot.sendMessage(userId, message, {
          parse_mode: 'HTML',
          ...options
        }),
        { maxRetries: 2, bufferSeconds: 1, throwOnFailure: false }
      );

      if (sendResult) {
        return { success: true };
      } else {
        // Mark as blocked if send failed
        this.blockedUsers.add(userId);
        await this.markLoggerBotStarted(userId, false);
        return { success: false, error: 'Failed to send (user may have blocked bot)' };
      }
    } catch (error) {
      const errorMessage = error.message || error.toString() || '';
      const isBotBlocked = errorMessage.includes('bot was blocked') ||
                          errorMessage.includes('bot blocked') ||
                          errorMessage.includes('BLOCKED') ||
                          errorMessage.includes('chat not found') ||
                          (error.code === 403 && errorMessage.includes('forbidden'));

      if (isBotBlocked) {
        // User blocked the bot - mark them and don't try again
        this.blockedUsers.add(userId);
        await this.markLoggerBotStarted(userId, false);
        return { success: false, error: 'User has blocked logger bot' };
      }

      logError('[LOGGER_BOT] Error sending log:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Send broadcast started log
   */
  async logBroadcastStarted(userId, accountId) {
    const message = '📢 <b>Broadcast Started</b>\n\n' +
                   `Your broadcast has been started successfully.\n` +
                   `Account ID: ${accountId}\n` +
                   `Time: ${new Date().toLocaleString()}`;
    
    return await this.sendLog(userId, message);
  }

  /**
   * Send broadcast stopped log
   */
  async logBroadcastStopped(userId, accountId) {
    const message = '⏹️ <b>Broadcast Stopped</b>\n\n' +
                   `Your broadcast has been stopped.\n` +
                   `Account ID: ${accountId}\n` +
                   `Time: ${new Date().toLocaleString()}`;
    
    return await this.sendLog(userId, message);
  }

  /**
   * Send account linked log
   */
  async logAccountLinked(userId, phone, accountId) {
    const message = '🔗 <b>Account Linked</b>\n\n' +
                   `Your account has been successfully linked.\n` +
                   `Phone: ${phone}\n` +
                   `Account ID: ${accountId}\n` +
                   `Time: ${new Date().toLocaleString()}`;
    
    return await this.sendLog(userId, message);
  }

  /**
   * Send account deleted log
   */
  async logAccountDeleted(userId, accountId, phone) {
    const message = '🗑️ <b>Account Deleted</b>\n\n' +
                   `Your account has been deleted.\n` +
                   `Account ID: ${accountId}\n` +
                   `Phone: ${phone || 'N/A'}\n` +
                   `Time: ${new Date().toLocaleString()}`;
    
    return await this.sendLog(userId, message);
  }

  /**
   * Send cycle completion log with stats
   */
  async logCycleCompleted(userId, accountId, stats) {
    const { groupsProcessed = 0, messagesSent = 0, errors = 0, skipped = 0 } = stats;
    const message = '✅ <b>Cycle Completed</b>\n\n' +
                   `Account ID: ${accountId}\n` +
                   `Groups Processed: ${groupsProcessed}\n` +
                   `Messages Sent: ${messagesSent}\n` +
                   `Skipped: ${skipped}\n` +
                   `Errors: ${errors}\n` +
                   `Time: ${new Date().toLocaleString()}`;
    
    return await this.sendLog(userId, message);
  }

  /**
   * Forward auto-reply message to logger bot
   */
  async logAutoReply(userId, accountId, originalMessage, replyMessage, chatInfo) {
    try {
      // First send a summary message
      const summary = '💬 <b>Auto-Reply Sent</b>\n\n' +
                     `Account ID: ${accountId}\n` +
                     `Chat: ${chatInfo.name || chatInfo.id || 'Unknown'}\n` +
                     `Chat Type: ${chatInfo.type || 'Unknown'}\n` +
                     `Time: ${new Date().toLocaleString()}\n\n` +
                     `Original message will be forwarded below:`;
      
      await this.sendLog(userId, summary);
      
      // Forward the original message if possible
      // Note: We can't directly forward from MTProto, so we'll format it as text
      if (originalMessage && originalMessage.text) {
        const forwardedMessage = `📨 <b>Original Message:</b>\n\n` +
                                `${originalMessage.text}\n\n` +
                                `📤 <b>Reply Sent:</b>\n${replyMessage}`;
        
        await this.sendLog(userId, forwardedMessage);
      } else {
        const replyOnly = `📤 <b>Reply Sent:</b>\n${replyMessage}`;
        await this.sendLog(userId, replyOnly);
      }
      
      return { success: true };
    } catch (error) {
      logError('[LOGGER_BOT] Error logging auto-reply:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Send account activity log
   */
  async logAccountActivity(userId, activity, details = {}) {
    let message = `📊 <b>Account Activity</b>\n\n${activity}\n`;
    
    if (details.accountId) {
      message += `Account ID: ${details.accountId}\n`;
    }
    if (details.groupCount) {
      message += `Groups: ${details.groupCount}\n`;
    }
    if (details.messagesSent) {
      message += `Messages Sent: ${details.messagesSent}\n`;
    }
    
    message += `Time: ${new Date().toLocaleString()}`;
    
    return await this.sendLog(userId, message);
  }

  /**
   * Send error log
   */
  async logError(userId, errorType, errorMessage) {
    const message = '⚠️ <b>Error Notification</b>\n\n' +
                   `Type: ${errorType}\n` +
                   `Message: ${errorMessage}\n` +
                   `Time: ${new Date().toLocaleString()}`;
    
    return await this.sendLog(userId, message);
  }

  /**
   * Stop the logger bot
   */
  async stop() {
    if (this.bot) {
      try {
        await this.bot.stopPolling();
        console.log('[LOGGER_BOT] Logger bot stopped');
      } catch (error) {
        logError('[LOGGER_BOT] Error stopping logger bot:', error);
      }
    }
  }
}

const loggerBotService = new LoggerBotService();
export default loggerBotService;


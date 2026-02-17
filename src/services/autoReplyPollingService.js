/**
 * Auto Reply Polling Service
 * Polls for new messages periodically without keeping account online
 * Provides near real-time auto-reply (1-2 second delay) without persistent connection
 */

import accountLinker from './accountLinker.js';
import configService from './configService.js';
import autoReplyHandler from './autoReplyHandler.js';
import { logError } from '../utils/logger.js';

class AutoReplyPollingService {
  constructor() {
    this.pollingIntervals = new Map(); // accountId -> timeoutId
    this.lastCheckTimes = new Map(); // accountId -> { dm: timestamp, groups: timestamp }
    this.processingAccounts = new Set(); // accountId -> true (to prevent concurrent processing)
    this.consecutiveErrors = new Map(); // accountId -> error count
    this.MAX_CONSECUTIVE_ERRORS = 5; // Stop polling after 5 consecutive errors
    this.ERROR_RESET_TIME = 300000; // Reset error count after 5 minutes
  }

  /**
   * Start polling for an account (connects, checks messages, disconnects)
   * Uses randomized intervals to avoid detection patterns
   */
  async startPolling(accountId) {
    // Stop existing polling if any
    this.stopPolling(accountId);

    // Use randomized polling interval (2-5 minutes) to avoid detection patterns
    // CRITICAL: Short intervals create too many reconnections which triggers Telegram's anti-abuse
    // 2-5 minute intervals are much safer for account health and prevent freezing/banning
    const getRandomPollInterval = () => {
      return Math.floor(Math.random() * (300000 - 120000 + 1)) + 120000; // 2-5 minutes
    };

    const scheduleNext = () => {
      const nextInterval = getRandomPollInterval();
      const timeoutId = setTimeout(async () => {
        await this.checkAndReply(accountId);
        // Schedule next check with random interval
        scheduleNext();
      }, nextInterval);
      
      this.pollingIntervals.set(accountId.toString(), timeoutId);
    };

    // Start the polling loop
    scheduleNext();
    console.log(`[AUTO_REPLY_POLL] Started polling for account ${accountId} (randomized interval: 2-5 minutes)`);

    // Check immediately on start (with a small delay to avoid instant connection)
    setTimeout(async () => {
      await this.checkAndReply(accountId);
    }, 1000);
  }

  /**
   * Stop polling for an account
   */
  stopPolling(accountId) {
    const accountIdStr = accountId.toString();
    const timeoutId = this.pollingIntervals.get(accountIdStr);
    if (timeoutId) {
      clearTimeout(timeoutId);
      this.pollingIntervals.delete(accountIdStr);
      this.lastCheckTimes.delete(accountIdStr);
      this.processingAccounts.delete(accountIdStr);
      // Don't delete error count - we want to track it for recovery
      console.log(`[AUTO_REPLY_POLL] Stopped polling for account ${accountId}`);
    }
  }

  /**
   * Stop all polling (e.g., on shutdown)
   */
  stopAllImmediate() {
    console.log(`[AUTO_REPLY_POLL] Stopping all ${this.pollingIntervals.size} polling intervals...`);
    for (const [accountId, timeoutId] of this.pollingIntervals.entries()) {
      clearTimeout(timeoutId);
    }
    this.pollingIntervals.clear();
    this.processingAccounts.clear();
    this.lastCheckTimes.clear();
    this.consecutiveErrors.clear();
  }

  /**
   * Check for new messages and send auto-replies
   */
  async checkAndReply(accountId) {
    const accountIdStr = accountId.toString();

    // Prevent concurrent processing
    if (this.processingAccounts.has(accountIdStr)) {
      return;
    }

    this.processingAccounts.add(accountIdStr);

    try {
      const settings = await configService.getAccountSettings(accountId);
      if (!settings) {
        this.stopPolling(accountId);
        return;
      }

      const hasAutoReply = (settings.autoReplyDmEnabled && settings.autoReplyDmMessage) ||
                          (settings.autoReplyGroupsEnabled && settings.autoReplyGroupsMessage);

      if (!hasAutoReply) {
        this.stopPolling(accountId);
        return;
      }

      // Get account info
      const db = (await import('../database/db.js')).default;
      const result = await db.query('SELECT user_id FROM accounts WHERE account_id = $1', [accountId]);
      if (!result.rows || result.rows.length === 0) {
        this.stopPolling(accountId);
        return;
      }

      const userId = result.rows[0]?.user_id;
      if (!userId) {
        this.stopPolling(accountId);
        return;
      }

      // Connect briefly to check messages
      const client = await accountLinker.getClientAndConnect(userId, accountId);
      if (!client || !client.connected) {
        console.log(`[AUTO_REPLY_POLL] ⚠️  Account ${accountId} client not connected, will retry on next poll`);
        // Don't count connection errors as consecutive errors - these are expected
        return; // Will retry on next poll
      }
      
      // Reset error count on successful connection
      if (this.consecutiveErrors.has(accountIdStr)) {
        this.consecutiveErrors.delete(accountIdStr);
      }

      try {
        // Set account to offline status to prevent showing as "online"
        try {
          const { Api } = await import('telegram/tl/index.js');
          await client.invoke(new Api.account.UpdateStatus({ offline: true }));
        } catch (statusError) {
          // Silently ignore - some accounts may not support this
          if (!statusError.message?.includes('AUTH_KEY') && !statusError.message?.includes('not connected')) {
            console.log(`[AUTO_REPLY_POLL] Could not set offline status for account ${accountId}: ${statusError.message}`);
          }
        }

        const me = await client.getMe();
        let dialogs = [];
        try {
          dialogs = await client.getDialogs({ limit: 30 }); // Check recent dialogs for better coverage
        } catch (dialogsError) {
          // Check if it's a session revocation error (AUTH_KEY_UNREGISTERED or SESSION_REVOKED)
          const errorMessage = dialogsError.message || dialogsError.toString() || '';
          const errorCode = dialogsError.code || dialogsError.errorCode || dialogsError.response?.error_code;
          const isSessionRevoked = 
            dialogsError.errorMessage === 'SESSION_REVOKED' || 
            dialogsError.errorMessage === 'AUTH_KEY_UNREGISTERED' ||
            (errorCode === 401 && (errorMessage.includes('SESSION_REVOKED') || errorMessage.includes('AUTH_KEY_UNREGISTERED'))) ||
            errorMessage.includes('AUTH_KEY_UNREGISTERED') ||
            errorMessage.includes('SESSION_REVOKED');
          
          if (isSessionRevoked) {
            console.log(`[AUTO_REPLY_POLL] Session revoked for account ${accountId} - marking for re-authentication`);
            try {
              await accountLinker.handleSessionRevoked(accountId);
            } catch (revokeError) {
              console.log(`[AUTO_REPLY_POLL] Error handling session revocation for account ${accountId}: ${revokeError.message}`);
            }
            // Stop polling for this account
            this.stopPolling(accountId);
            return;
          }
          // Re-throw if it's not a session error
          throw dialogsError;
        }

        // Initialize lastCheck with current time if not set (prevents processing old messages on first run)
        const now = Math.floor(Date.now() / 1000); // Unix timestamp in seconds
        const lastCheck = this.lastCheckTimes.get(accountId.toString()) || { dm: now, groups: now };
        
        console.log(`[AUTO_REPLY_POLL] Checking ${dialogs.length} dialogs for account ${accountId} (lastCheck: DM=${lastCheck.dm}, Groups=${lastCheck.groups})`);

        for (const dialog of dialogs) {
          try {
            const chat = await dialog.getChat();
            if (!chat) continue;

            const chatType = chat.className || '';
            const isDM = chatType === 'User';
            const isGroup = chatType === 'Chat' || chat.megagroup || chat.gigagroup;

            if (!isDM && !isGroup) continue;

            // Get last message in dialog
            const messages = await client.getMessages(chat, { limit: 1 });
            if (!messages || messages.length === 0) continue;

            const lastMessage = messages[0];

            // Skip if message is from ourselves
            if (this.isMessageFromSelf(lastMessage, me.id)) continue;

            // Skip if message is from a bot
            if (this.isSenderBot(lastMessage)) continue;

            // Skip if message is empty or not text
            if (!lastMessage.text || lastMessage.text.trim().length === 0) continue;

            // CRITICAL: Skip Saved Messages (user's own chat with themselves)
            if (isDM) {
              const chatIdNum = typeof chat.id === 'bigint' ? Number(chat.id) : Number(chat.id);
              const meIdNum = typeof me.id === 'bigint' ? Number(me.id) : Number(me.id);
              
              if (chatIdNum === meIdNum || chat.firstName === 'Saved Messages' || chat.username === 'savedmessages') {
                console.log(`[AUTO_REPLY_POLLING] Skipping Saved Messages for account ${accountId}`);
                continue;
              }
            }

            // Get chat ID and message ID
            const chatId = this.extractChatId(chat, lastMessage);
            if (!chatId) continue;

            const messageId = String(lastMessage.id);
            const messageKey = `${accountId}_${chatId}_${messageId}`;

            // Check message timestamp
            const messageDate = lastMessage.date
              ? (typeof lastMessage.date === 'number' ? lastMessage.date : Math.floor(lastMessage.date.getTime() / 1000))
              : 0;
            const checkKey = isDM ? 'dm' : 'groups';
            const lastCheckTime = lastCheck[checkKey] || now;

            // Only process messages newer than last check (< not <=)
            if (messageDate < lastCheckTime) {
              continue; // Old message, already processed
            }

            console.log(`[AUTO_REPLY_POLL] 📨 New message in ${isDM ? 'DM' : 'group'} (chat ${chatId}, msg ${messageId}, date ${messageDate})`);

            // Process message using auto-reply handler
            // Note: Even in polling mode, handler will add human-like delays (2-8 seconds)
            await autoReplyHandler.processMessage(lastMessage, accountId, client, true); // true = polling mode

            // Update last check time to current time (not message time, to avoid missing concurrent messages)
            lastCheck[checkKey] = now;
          } catch (error) {
            // Log errors for individual chats but continue processing others
            console.log(`[AUTO_REPLY_POLL] Error processing chat: ${error.message}`);
            continue;
          }
        }

        // Update last check times
        this.lastCheckTimes.set(accountId.toString(), lastCheck);
        console.log(`[AUTO_REPLY_POLL] ✅ Check complete for account ${accountId} (updated lastCheck: DM=${lastCheck.dm}, Groups=${lastCheck.groups})`);

        // Reset error count on successful check
        if (this.consecutiveErrors.has(accountIdStr)) {
          this.consecutiveErrors.delete(accountIdStr);
        }

        // Disconnect after checking (to avoid staying online)
        // Note: We don't disconnect if client is being used for broadcasting
        // The accountLinker will manage this
      } catch (error) {
        console.error(`[AUTO_REPLY_POLL] ❌ Error checking messages for account ${accountId}:`, error.message);
        logError(`[AUTO_REPLY_POLL] Error checking messages for account ${accountId}:`, error);
        
        // Track consecutive errors
        const errorCount = (this.consecutiveErrors.get(accountIdStr) || 0) + 1;
        this.consecutiveErrors.set(accountIdStr, errorCount);

        // If too many consecutive errors, stop polling temporarily
        if (errorCount >= this.MAX_CONSECUTIVE_ERRORS) {
          console.error(`[AUTO_REPLY_POLL] ⚠️ Account ${accountId} has ${errorCount} consecutive errors, stopping polling temporarily`);
          this.stopPolling(accountId);

          // Restart after error reset time
          setTimeout(async () => {
            console.log(`[AUTO_REPLY_POLL] 🔄 Restarting polling for account ${accountId} after error recovery...`);
            this.consecutiveErrors.delete(accountIdStr);
            await this.startPolling(accountId);
          }, this.ERROR_RESET_TIME);
        }
      }
    } catch (error) {
      // Check if user deleted their Telegram account
      if (accountLinker.isUserDeletedError(error)) {
        console.log(`[AUTO_REPLY_POLL] User deleted their Telegram account for account ${accountId} - cleaning up all data`);
        try {
          const db = (await import('../database/db.js')).default;
          const accountQuery = await db.query(
            'SELECT user_id FROM accounts WHERE account_id = $1',
            [accountId]
          );
          if (accountQuery.rows.length > 0) {
            const deletedUserId = accountQuery.rows[0]?.user_id;
            await accountLinker.cleanupUserData(deletedUserId);
          }
        } catch (cleanupError) {
          console.log(`[AUTO_REPLY_POLL] Error cleaning up user data: ${cleanupError.message}`);
        }
        this.stopPolling(accountId);
        return;
      }
      
      // Check if it's a session revocation error (AUTH_KEY_UNREGISTERED or SESSION_REVOKED)
      const errorMessage = error.message || error.toString() || '';
      const errorCode = error.code || error.errorCode || error.response?.error_code;
      const isSessionRevoked = 
        error.errorMessage === 'SESSION_REVOKED' || 
        error.errorMessage === 'AUTH_KEY_UNREGISTERED' ||
        (errorCode === 401 && (errorMessage.includes('SESSION_REVOKED') || errorMessage.includes('AUTH_KEY_UNREGISTERED'))) ||
        errorMessage.includes('AUTH_KEY_UNREGISTERED') ||
        errorMessage.includes('SESSION_REVOKED');
      
      if (isSessionRevoked) {
        console.log(`[AUTO_REPLY_POLL] Session revoked for account ${accountId} - marking for re-authentication`);
        try {
          await accountLinker.handleSessionRevoked(accountId);
        } catch (revokeError) {
          console.log(`[AUTO_REPLY_POLL] Error handling session revocation for account ${accountId}: ${revokeError.message}`);
        }
        // Stop polling for this account
        this.stopPolling(accountId);
        return;
      }
      
      console.error(`[AUTO_REPLY_POLL] ❌ Error in checkAndReply for account ${accountId}:`, error.message);
      logError(`[AUTO_REPLY_POLL] Error in checkAndReply for account ${accountId}:`, error);

      // Track consecutive errors
      const errorCount = (this.consecutiveErrors.get(accountIdStr) || 0) + 1;
      this.consecutiveErrors.set(accountIdStr, errorCount);

      // If too many consecutive errors, stop polling temporarily
      if (errorCount >= this.MAX_CONSECUTIVE_ERRORS) {
        console.error(`[AUTO_REPLY_POLL] ⚠️ Account ${accountId} has ${errorCount} consecutive errors, stopping polling temporarily`);
        this.stopPolling(accountId);

        // Restart after error recovery time
        setTimeout(async () => {
          console.log(`[AUTO_REPLY_POLL] 🔄 Restarting polling for account ${accountId} after error recovery...`);
          this.consecutiveErrors.delete(accountIdStr);
          await this.startPolling(accountId);
        }, this.ERROR_RESET_TIME);
      }
    } finally {
      this.processingAccounts.delete(accountIdStr);
    }
  }

  /**
   * Extract chat ID from chat/message
   */
  extractChatId(chat, message) {
    if (chat && chat.id !== null && chat.id !== undefined) {
      return typeof chat.id === 'bigint' ? chat.id.toString() : String(chat.id);
    }
    if (message && message.peerId) {
      if (message.peerId.userId !== null && message.peerId.userId !== undefined) {
        return String(message.peerId.userId);
      }
      if (message.peerId.channelId !== null && message.peerId.channelId !== undefined) {
        return String(message.peerId.channelId);
      }
      if (message.peerId.chatId !== null && message.peerId.chatId !== undefined) {
        return String(message.peerId.chatId);
      }
    }
    return null;
  }

  /**
   * Check if message is from ourselves
   */
  isMessageFromSelf(message, meId) {
    if (!message.fromId) return false;
    
    let senderId = null;
    if (message.fromId.className === 'PeerUser') {
      senderId = message.fromId.userId;
    } else if (message.fromId.userId !== undefined) {
      senderId = message.fromId.userId;
    }
    
    if (senderId === null || senderId === undefined) return false;
    
    const senderIdNum = typeof senderId === 'bigint' ? Number(senderId) : senderId;
    const meIdNum = typeof meId === 'bigint' ? Number(meId) : meId;
    return senderIdNum === meIdNum;
  }

  /**
   * Check if message sender is a bot
   */
  isSenderBot(message) {
    try {
      // Use message.sender.bot directly - avoid getEntity API call
      if (message.sender && message.sender.bot === true) {
        return true;
      }
      return false;
    } catch (error) {
      return false;
    }
  }

  /**
   * Start polling for all accounts with auto-reply enabled
   */
  async startAll() {
    try {
      const db = (await import('../database/db.js')).default;
      const result = await db.query(
        `SELECT account_id FROM accounts 
         WHERE (auto_reply_dm_enabled = 1 OR auto_reply_groups_enabled = 1)`
      );

      console.log(`[AUTO_REPLY_POLL] Starting polling for ${result.rows.length} accounts (staggered)...`);

      for (let i = 0; i < result.rows.length; i++) {
        await this.startPolling(result.rows[i].account_id);
        // Stagger polling starts by 3-8 seconds to avoid all accounts connecting at once
        if (i < result.rows.length - 1) {
          const staggerDelay = Math.floor(Math.random() * (8000 - 3000 + 1)) + 3000;
          await new Promise(resolve => setTimeout(resolve, staggerDelay));
        }
      }
    } catch (error) {
      logError('[AUTO_REPLY_POLL] Error starting all polling:', error);
    }
  }

  /**
   * Stop all polling
   */
  stopAll() {
    for (const [accountIdStr, _] of this.pollingIntervals.entries()) {
      this.stopPolling(parseInt(accountIdStr));
    }
    console.log('[AUTO_REPLY_POLL] Stopped all polling');
  }
}

export default new AutoReplyPollingService();


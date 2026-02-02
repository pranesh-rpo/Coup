/**
 * Auto Reply Service (Stealth Mode)
 * Polls for new messages periodically - account is NOT online 24/7
 * Connects briefly, checks messages, replies, disconnects
 */

import accountLinker from './accountLinker.js';
import configService from './configService.js';

class AutoReplyRealtimeService {
  constructor() {
    // Track polling for accounts: accountId -> { intervalId, lastMessageIds }
    this.pollingAccounts = new Map();
    
    // Track last seen messages per chat to avoid duplicate replies
    this.lastSeenMessages = new Map(); // "accountId_chatId" -> messageId
    
    // Config
    this.MIN_DELAY_SECONDS = 2;
    this.MAX_DELAY_SECONDS = 10;
    this.POLL_INTERVAL = 5000; // Check every 5 seconds
    this.MAX_DIALOGS = 30; // Check last 30 chats
  }

  /**
   * Get random delay between 2-10 seconds
   */
  getRandomDelay() {
    const minMs = this.MIN_DELAY_SECONDS * 1000;
    const maxMs = this.MAX_DELAY_SECONDS * 1000;
    return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  }

  /**
   * Get last seen message ID for a chat
   */
  getLastSeenMessageId(accountId, chatId) {
    const key = `${accountId}_${chatId}`;
    return this.lastSeenMessages.get(key) || 0;
  }

  /**
   * Set last seen message ID for a chat
   */
  setLastSeenMessageId(accountId, chatId, messageId) {
    const key = `${accountId}_${chatId}`;
    this.lastSeenMessages.set(key, messageId);
    
    // Cleanup old entries (keep last 500)
    if (this.lastSeenMessages.size > 500) {
      const entries = Array.from(this.lastSeenMessages.entries()).slice(-250);
      this.lastSeenMessages.clear();
      entries.forEach(([k, v]) => this.lastSeenMessages.set(k, v));
    }
  }

  /**
   * Poll for new messages and reply
   */
  async pollAccount(accountId) {
    let client = null;
    
    try {
      // Get settings
      const settings = await configService.getAccountSettings(accountId);
      if (!settings) return;

      const hasDmReply = settings.autoReplyDmEnabled && settings.autoReplyDmMessage;
      const hasGroupReply = settings.autoReplyGroupsEnabled && settings.autoReplyGroupsMessage;
      
      if (!hasDmReply && !hasGroupReply) {
        this.stopPolling(accountId);
        return;
      }

      // Get user ID
      const db = (await import('../database/db.js')).default;
      const result = await db.query('SELECT user_id FROM accounts WHERE account_id = ?', [accountId]);
      if (!result.rows || result.rows.length === 0) return;
      const userId = result.rows[0].user_id;

      // Connect briefly
      client = await accountLinker.getClientAndConnect(userId, accountId);
      if (!client || !client.connected) return;

      const me = await client.getMe();
      const meId = typeof me.id === 'bigint' ? Number(me.id) : me.id;

      // Get recent dialogs
      const dialogs = await client.getDialogs({ limit: this.MAX_DIALOGS });

      for (const dialog of dialogs) {
        try {
          const chat = await dialog.getChat();
          if (!chat) continue;

          const chatType = chat.className || '';
          const isDM = chatType === 'User';
          const isGroup = chatType === 'Chat' || chat.megagroup || chat.gigagroup;

          // Skip if auto-reply not enabled for this type
          if (isDM && !hasDmReply) continue;
          if (isGroup && !hasGroupReply) continue;
          if (!isDM && !isGroup) continue;

          // Skip Saved Messages
          const chatId = typeof chat.id === 'bigint' ? Number(chat.id) : Number(chat.id);
          if (chatId === meId) continue;

          // Get last message
          const messages = await client.getMessages(chat, { limit: 1 });
          if (!messages || messages.length === 0) continue;

          const lastMessage = messages[0];
          const messageId = lastMessage.id;

          // Skip if already seen
          const lastSeenId = this.getLastSeenMessageId(accountId, chatId);
          if (messageId <= lastSeenId) continue;

          // Update last seen
          this.setLastSeenMessageId(accountId, chatId, messageId);

          // Skip outgoing messages
          if (lastMessage.out === true) continue;

          // Skip empty messages
          if (!lastMessage.text || lastMessage.text.trim().length === 0) continue;

          // Skip messages from self
          if (lastMessage.fromId) {
            const senderId = lastMessage.fromId.userId || lastMessage.fromId;
            const senderNum = typeof senderId === 'bigint' ? Number(senderId) : Number(senderId);
            if (senderNum === meId) continue;
          }

          // Skip bot messages
          if (lastMessage.sender && lastMessage.sender.bot) continue;

          // Handle DM
          if (isDM) {
            console.log(`[AUTO_REPLY] New DM detected for account ${accountId}`);
            await this.sendReplyWithDelay(client, chat, settings.autoReplyDmMessage, null, accountId, 'DM');
            continue;
          }

          // Handle Group (only on mention or reply)
          if (isGroup) {
            let shouldReply = false;
            let triggerType = '';

            // Check for mention
            if (lastMessage.entities && me.username) {
              for (const entity of lastMessage.entities) {
                if (entity.className === 'MessageEntityMention' && lastMessage.text) {
                  const mentionText = lastMessage.text.substring(entity.offset, entity.offset + entity.length);
                  if (mentionText.toLowerCase() === `@${me.username.toLowerCase()}`) {
                    shouldReply = true;
                    triggerType = 'mention';
                    break;
                  }
                }
                if (entity.className === 'MessageEntityMentionName' && entity.userId) {
                  const mentionedId = typeof entity.userId === 'bigint' ? Number(entity.userId) : entity.userId;
                  if (mentionedId === meId) {
                    shouldReply = true;
                    triggerType = 'mention';
                    break;
                  }
                }
              }
            }

            // Check text for @username
            if (!shouldReply && me.username && lastMessage.text) {
              if (lastMessage.text.toLowerCase().includes(`@${me.username.toLowerCase()}`)) {
                shouldReply = true;
                triggerType = 'mention';
              }
            }

            // Check if reply to our message
            if (!shouldReply && (lastMessage.replyTo || lastMessage.replyToMsgId)) {
              try {
                const replyMsg = await lastMessage.getReplyMessage();
                if (replyMsg && replyMsg.out === true) {
                  shouldReply = true;
                  triggerType = 'reply';
                }
              } catch (e) {}
            }

            if (shouldReply) {
              console.log(`[AUTO_REPLY] New group ${triggerType} detected for account ${accountId}`);
              await this.sendReplyWithDelay(client, chat, settings.autoReplyGroupsMessage, lastMessage, accountId, `Group (${triggerType})`);
            }
          }
        } catch (chatError) {
          // Skip errors for individual chats
          continue;
        }
      }

      // Disconnect after checking (stealth mode)
      try {
        await client.disconnect();
      } catch (e) {}

    } catch (error) {
      if (!error.message?.includes('AUTH_KEY') && 
          !error.message?.includes('SESSION')) {
        console.error(`[AUTO_REPLY] Poll error for account ${accountId}:`, error.message);
      }
      
      // Try to disconnect on error
      if (client && client.connected) {
        try { await client.disconnect(); } catch (e) {}
      }
    }
  }

  /**
   * Send reply with random delay
   */
  async sendReplyWithDelay(client, chat, replyMessage, originalMessage, accountId, type) {
    const delay = this.getRandomDelay();
    console.log(`[AUTO_REPLY] Scheduling ${type} reply for account ${accountId} in ${delay}ms`);

    // Wait for delay
    await new Promise(resolve => setTimeout(resolve, delay));

    try {
      // Reconnect if needed
      if (!client.connected) {
        await client.connect();
      }

      const options = { message: replyMessage };
      if (originalMessage) {
        options.replyTo = originalMessage;
      }

      await client.sendMessage(chat, options);
      console.log(`[AUTO_REPLY] ✅ ${type} reply sent for account ${accountId}`);

      // Log to logger bot
      this.logReply(accountId, chat, type, replyMessage).catch(() => {});

      // Disconnect after sending (stealth)
      try {
        await client.disconnect();
      } catch (e) {}

    } catch (error) {
      console.error(`[AUTO_REPLY] Error sending ${type} reply:`, error.message);
    }
  }

  /**
   * Log reply to logger bot
   */
  async logReply(accountId, chat, type, message) {
    try {
      const loggerBotService = (await import('./loggerBotService.js')).default;
      const db = (await import('../database/db.js')).default;
      const result = await db.query('SELECT user_id FROM accounts WHERE account_id = ?', [accountId]);
      
      if (result.rows && result.rows.length > 0) {
        const userId = result.rows[0].user_id;
        const chatName = chat.title || chat.firstName || chat.username || 'Unknown';
        loggerBotService.logAutoReply(userId, accountId, null, message, {
          name: chatName,
          type: type,
          id: String(chat.id)
        }).catch(() => {});
      }
    } catch (e) {}
  }

  /**
   * Start polling for an account
   */
  async startPolling(accountId) {
    const accountIdStr = accountId.toString();
    
    // Stop existing polling
    this.stopPolling(accountId);

    // Start interval
    const intervalId = setInterval(() => {
      this.pollAccount(accountId).catch(e => {
        console.error(`[AUTO_REPLY] Poll error:`, e.message);
      });
    }, this.POLL_INTERVAL);

    this.pollingAccounts.set(accountIdStr, { intervalId });
    console.log(`[AUTO_REPLY] ✅ Started polling for account ${accountId} (every ${this.POLL_INTERVAL/1000}s, stealth mode)`);

    // Poll immediately
    this.pollAccount(accountId).catch(() => {});
  }

  /**
   * Stop polling for an account
   */
  stopPolling(accountId) {
    const accountIdStr = accountId.toString();
    const polling = this.pollingAccounts.get(accountIdStr);
    
    if (polling) {
      clearInterval(polling.intervalId);
      this.pollingAccounts.delete(accountIdStr);
      console.log(`[AUTO_REPLY] Stopped polling for account ${accountId}`);
    }
  }

  /**
   * Connect account (start polling)
   */
  async connectAccount(accountId) {
    const settings = await configService.getAccountSettings(accountId);
    if (!settings) return false;

    const hasAutoReply = (settings.autoReplyDmEnabled && settings.autoReplyDmMessage) ||
                        (settings.autoReplyGroupsEnabled && settings.autoReplyGroupsMessage);
    
    if (!hasAutoReply) {
      this.stopPolling(accountId);
      return false;
    }

    await this.startPolling(accountId);
    return true;
  }

  /**
   * Disconnect account (stop polling)
   */
  disconnectAccount(accountId) {
    this.stopPolling(accountId);
  }

  /**
   * Start service
   */
  async start() {
    console.log('[AUTO_REPLY] Starting auto-reply service (stealth polling mode)...');
    
    try {
      const db = (await import('../database/db.js')).default;
      const result = await db.query(
        `SELECT account_id FROM accounts 
         WHERE (auto_reply_dm_enabled = 1 OR auto_reply_groups_enabled = 1)`
      );

      console.log(`[AUTO_REPLY] Found ${result.rows.length} accounts with auto-reply`);
      
      for (const row of result.rows) {
        await this.startPolling(row.account_id);
      }
    } catch (error) {
      console.error('[AUTO_REPLY] Error starting:', error.message);
    }

    console.log('[AUTO_REPLY] ✅ Service started (polls every 5s, 2-10s reply delay, account NOT online 24/7)');
  }

  /**
   * Stop service
   */
  stop() {
    console.log('[AUTO_REPLY] Stopping service...');
    
    for (const [accountIdStr] of this.pollingAccounts.entries()) {
      this.stopPolling(parseInt(accountIdStr));
    }

    console.log('[AUTO_REPLY] ✅ Service stopped');
  }

  /**
   * Refresh (restart polling for accounts with auto-reply)
   */
  async refresh() {
    console.log('[AUTO_REPLY] Refreshing...');
    
    try {
      const db = (await import('../database/db.js')).default;
      const result = await db.query(
        `SELECT account_id FROM accounts 
         WHERE (auto_reply_dm_enabled = 1 OR auto_reply_groups_enabled = 1)`
      );

      // Stop accounts that no longer have auto-reply
      for (const [accountIdStr] of this.pollingAccounts.entries()) {
        const accountId = parseInt(accountIdStr);
        const hasAutoReply = result.rows.some(r => r.account_id === accountId);
        if (!hasAutoReply) {
          this.stopPolling(accountId);
        }
      }

      // Start accounts with auto-reply
      for (const row of result.rows) {
        if (!this.pollingAccounts.has(row.account_id.toString())) {
          await this.startPolling(row.account_id);
        }
      }
    } catch (error) {
      console.error('[AUTO_REPLY] Refresh error:', error.message);
    }
  }
}

export default new AutoReplyRealtimeService();

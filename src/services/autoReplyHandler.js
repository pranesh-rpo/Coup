/**
 * Auto Reply Handler
 * Handles incoming messages and sends auto-replies
 */

import { NewMessage } from 'telegram/events/index.js';
import configService from './configService.js';
import { logError } from '../utils/logger.js';

class AutoReplyHandler {
  constructor() {
    // Track which chats have already received auto-replies
    // Format: "accountId_chatId" -> { lastReplyTime, processing: Set<messageId> }
    this.repliedChats = new Map();
    // Track messages currently being processed to prevent race conditions
    this.processingMessages = new Set();
  }

  /**
   * Get unique key for a chat
   */
  getChatKey(accountId, chatId) {
    return `${accountId}_${chatId}`;
  }

  /**
   * Get unique key for a message being processed
   */
  getMessageKey(accountId, chatId, messageId) {
    return `${accountId}_${chatId}_${messageId}`;
  }

  /**
   * Check if we've already replied to this chat recently (within last 30 minutes)
   */
  hasRepliedToChatRecently(accountId, chatId) {
    const key = this.getChatKey(accountId, chatId);
    const data = this.repliedChats.get(key);
    if (!data) return false;
    
    // Check if last reply was within 30 minutes
    const thirtyMinutesAgo = Date.now() - (30 * 60 * 1000);
    if (data.lastReplyTime < thirtyMinutesAgo) {
      // Cooldown expired, remove entry
      this.repliedChats.delete(key);
      return false;
    }
    
    return true;
  }

  /**
   * Mark chat as replied to (with 30-minute cooldown)
   */
  markChatAsReplied(accountId, chatId) {
    const key = this.getChatKey(accountId, chatId);
    this.repliedChats.set(key, {
      lastReplyTime: Date.now()
    });
  }

  /**
   * Check if message is currently being processed
   */
  isProcessingMessage(accountId, chatId, messageId) {
    const msgKey = this.getMessageKey(accountId, chatId, messageId);
    return this.processingMessages.has(msgKey);
  }

  /**
   * Mark message as being processed
   */
  markMessageProcessing(accountId, chatId, messageId) {
    const msgKey = this.getMessageKey(accountId, chatId, messageId);
    this.processingMessages.add(msgKey);
    
    // Auto-cleanup after 30 seconds
    setTimeout(() => {
      this.processingMessages.delete(msgKey);
    }, 30000);
  }

  /**
   * Clear message processing flag
   */
  clearMessageProcessing(accountId, chatId, messageId) {
    const msgKey = this.getMessageKey(accountId, chatId, messageId);
    this.processingMessages.delete(msgKey);
  }

  /**
   * Setup auto-reply handler for a client
   */
  async setupAutoReply(client, accountId) {
    if (!client) return;

    // Always use real-time mode (interval mode removed)
    // Remove existing handler if any (to avoid duplicates)
    this.removeAutoReply(client);

    // Add NewMessage event handler (real-time mode)
    // Note: NewMessage events are already filtered to incoming messages by default
    client.addEventHandler(
      async (event) => {
        console.log(`[AUTO_REPLY] NewMessage event received for account ${accountId}`);
        try {
          await this.handleIncomingMessage(event, accountId, client);
        } catch (error) {
          logError(`[AUTO_REPLY] Error handling message for account ${accountId}:`, error);
        }
      },
      new NewMessage({})
    );

    console.log(`[AUTO_REPLY] Real-time handler set up for account ${accountId}`);
  }

  /**
   * Remove auto-reply handler from a client
   */
  removeAutoReply(client) {
    if (!client) return;
    
    try {
      // Remove all NewMessage handlers
      const handlers = client.listEventHandlers(NewMessage);
      for (const handler of handlers) {
        client.removeEventHandler(handler);
      }
    } catch (error) {
      // Ignore errors when removing handlers
      console.log(`[AUTO_REPLY] Error removing handlers: ${error.message}`);
    }
  }

  /**
   * Check if message is a reply to the account's message
   */
  async isReplyToAccount(message, client, accountId) {
    try {
      // Check if message has a reply
      if (!message.replyTo && !message.replyToMsgId) {
        return false;
      }

      // Get the replied-to message
      let repliedToMessage = null;
      if (message.replyTo) {
        // Try to get the message from replyTo
        try {
          repliedToMessage = await message.getReplyMessage();
        } catch (e) {
          // If we can't get it, try using replyToMsgId
          if (message.replyToMsgId) {
            try {
              const chat = await message.getChat();
              const messages = await client.getMessages(chat, { ids: [message.replyToMsgId] });
              if (messages && messages.length > 0) {
                repliedToMessage = messages[0];
              }
            } catch (e2) {
              console.log(`[AUTO_REPLY] Could not fetch replied-to message for account ${accountId}: ${e2.message}`);
              return false;
            }
          }
        }
      } else if (message.replyToMsgId) {
        try {
          const chat = await message.getChat();
          const messages = await client.getMessages(chat, { ids: [message.replyToMsgId] });
          if (messages && messages.length > 0) {
            repliedToMessage = messages[0];
          }
        } catch (e) {
          console.log(`[AUTO_REPLY] Could not fetch replied-to message for account ${accountId}: ${e.message}`);
          return false;
        }
      }

      if (!repliedToMessage) {
        return false;
      }

      // Get the account's user ID to check if the replied-to message is from the account
      const me = await client.getMe();
      
      // Check if the replied-to message is from the account
      const isFromAccount = this.isMessageFromSelf(repliedToMessage, me.id);
      if (isFromAccount) {
        console.log(`[AUTO_REPLY] Message is a reply to account's message (message ID: ${repliedToMessage.id})`);
      }
      return isFromAccount;
    } catch (error) {
      console.log(`[AUTO_REPLY] Error checking if message is reply to account: ${error.message}`);
      // If we can't determine, assume it's not a reply to account
      return false;
    }
  }

  /**
   * Check if message mentions the account
   */
  async isAccountMentioned(message, meId, meUsername = null) {
    // Check message entities for mentions
    if (message.entities && Array.isArray(message.entities)) {
      for (const entity of message.entities) {
        // Check for mention entities
        if (entity.className === 'MessageEntityMentionName' || 
            entity.className === 'MessageEntityMention' ||
            (entity.userId !== undefined && entity.userId !== null)) {
          
          let mentionedUserId = null;
          if (entity.userId !== undefined && entity.userId !== null) {
            mentionedUserId = entity.userId;
          }
          
          if (mentionedUserId !== null) {
            const mentionedIdNum = typeof mentionedUserId === 'bigint' ? Number(mentionedUserId) : mentionedUserId;
            const meIdNum = typeof meId === 'bigint' ? Number(meId) : meId;
            if (mentionedIdNum === meIdNum) {
              return true;
            }
          }
        }
      }
    }

    // Also check if message text contains @username mention
    if (message.text && meUsername) {
      const mentionPattern = new RegExp(`@${meUsername}\\b`, 'i');
      if (mentionPattern.test(message.text)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if message sender is a bot
   */
  async isSenderBot(message, client) {
    try {
      // Try to get the sender entity
      if (message.sender) {
        return message.sender.bot === true;
      }
      
      // Try to get sender from fromId
      if (message.fromId) {
        let senderId = null;
        if (message.fromId.className === 'PeerUser') {
          senderId = message.fromId.userId;
        } else if (message.fromId && typeof message.fromId === 'object' && message.fromId.userId) {
          senderId = message.fromId.userId;
        }
        
        if (senderId !== null && senderId !== undefined) {
          try {
            const senderIdNum = typeof senderId === 'bigint' ? Number(senderId) : senderId;
            const sender = await client.getEntity(senderIdNum);
            if (sender && sender.bot === true) {
              return true;
            }
          } catch (e) {
            // If we can't get the entity, assume it's not a bot
            return false;
          }
        }
      }
      
      // Check senderId directly
      if (message.senderId) {
        let senderId = null;
        if (message.senderId.className === 'PeerUser') {
          senderId = message.senderId.userId;
        } else if (message.senderId && typeof message.senderId === 'object' && message.senderId.userId) {
          senderId = message.senderId.userId;
        }
        
        if (senderId !== null && senderId !== undefined) {
          try {
            const senderIdNum = typeof senderId === 'bigint' ? Number(senderId) : senderId;
            const sender = await client.getEntity(senderIdNum);
            if (sender && sender.bot === true) {
              return true;
            }
          } catch (e) {
            // If we can't get the entity, assume it's not a bot
            return false;
          }
        }
      }
      
      return false;
    } catch (error) {
      // If we can't determine, assume it's not a bot (to avoid blocking legitimate users)
      return false;
    }
  }

  /**
   * Check if message is from ourselves
   */
  isMessageFromSelf(message, meId) {
    // Check senderId first (alternative way to identify sender)
    if (message.senderId) {
      let senderId = null;
      if (message.senderId.className === 'PeerUser') {
        senderId = message.senderId.userId;
      } else if (message.senderId && typeof message.senderId === 'object' && message.senderId.userId) {
        senderId = message.senderId.userId;
      }
      
      if (senderId !== null && senderId !== undefined) {
        const senderIdNum = typeof senderId === 'bigint' ? Number(senderId) : senderId;
        const meIdNum = typeof meId === 'bigint' ? Number(meId) : meId;
        if (senderIdNum === meIdNum) return true;
      }
    }
    
    // Check fromId
    if (!message.fromId) return false;
    
    // Try using equals method if available
    if (typeof message.fromId.equals === 'function') {
      try {
        return message.fromId.equals(meId);
      } catch (e) {
        // Fall through to other methods
      }
    }
    
    // Extract userId from PeerUser object
    let senderId = null;
    if (message.fromId.className === 'PeerUser') {
      senderId = message.fromId.userId;
    } else if (message.fromId && typeof message.fromId === 'object' && message.fromId.userId) {
      senderId = message.fromId.userId;
    }
    
    // Compare IDs (handle BigInt and number types)
    if (senderId !== null && senderId !== undefined) {
      const senderIdNum = typeof senderId === 'bigint' ? Number(senderId) : senderId;
      const meIdNum = typeof meId === 'bigint' ? Number(meId) : meId;
      return senderIdNum === meIdNum;
    }
    
    return false;
  }

  /**
   * Handle incoming message and send auto-reply if needed
   */
  async handleIncomingMessage(event, accountId, client) {
    try {
      const message = event.message;
      if (!message) {
        console.log(`[AUTO_REPLY] No message in event for account ${accountId}`);
        return;
      }

      // Skip outgoing messages (messages sent by the bot itself)
      if (message.out === true) {
        return;
      }

      console.log(`[AUTO_REPLY] Received message event for account ${accountId}, message ID: ${message.id}`);

      // Skip if message is from ourselves (additional check)
      const me = await client.getMe();
      if (this.isMessageFromSelf(message, me.id)) {
        return;
      }

      // Skip if message is from a bot
      const isBot = await this.isSenderBot(message, client);
      if (isBot) {
        console.log(`[AUTO_REPLY] Message from bot, skipping auto-reply for account ${accountId}`);
        return;
      }

      // Skip if message is empty or not text
      if (!message.text || message.text.trim().length === 0) {
        return;
      }

      // Get chat information
      const chat = await message.getChat();
      if (!chat) return;

      // Get chat ID for tracking (handle BigInt and number types)
      let chatId = null;
      if (chat.id !== null && chat.id !== undefined) {
        if (typeof chat.id === 'bigint') {
          chatId = chat.id.toString();
        } else {
          chatId = String(chat.id);
        }
      }
      if (!chatId) {
        console.log(`[AUTO_REPLY] Could not extract chat ID for account ${accountId}`);
        return;
      }

      // Get message ID for tracking
      const messageId = message.id ? String(message.id) : null;
      if (!messageId) {
        console.log(`[AUTO_REPLY] Could not extract message ID for account ${accountId}`);
        return;
      }

      // Check if this message is already being processed (prevent race conditions)
      if (this.isProcessingMessage(accountId, chatId, messageId)) {
        console.log(`[AUTO_REPLY] Message ${messageId} already being processed, skipping for account ${accountId}`);
        return;
      }

      // Determine if it's a DM or group
      // Check chat type using className
      const chatType = chat.className || '';
      const isDM = chatType === 'User';
      // Groups are Chat, Channel, or have megagroup/gigagroup flags
      const isGroup = chatType === 'Chat' || chatType === 'Channel' || chat.megagroup || chat.gigagroup;

      console.log(`[AUTO_REPLY] Chat type: ${chatType}, isDM: ${isDM}, isGroup: ${isGroup}, chatId: ${chatId}`);

      // Get auto-reply settings
      const settings = await configService.getAccountSettings(accountId);
      if (!settings) {
        console.log(`[AUTO_REPLY] No settings found for account ${accountId}`);
        return;
      }

      console.log(`[AUTO_REPLY] Settings for account ${accountId}: DM=${settings.autoReplyDmEnabled}, Groups=${settings.autoReplyGroupsEnabled}, DMMessage=${settings.autoReplyDmMessage ? 'set' : 'not set'}`);

      // Handle DM auto-reply
      if (isDM && settings.autoReplyDmEnabled && settings.autoReplyDmMessage) {
        console.log(`[AUTO_REPLY] Processing DM auto-reply for account ${accountId}`);
        // Check if we've already replied to this chat recently (30-minute cooldown)
        if (this.hasRepliedToChatRecently(accountId, chatId)) {
          console.log(`[AUTO_REPLY] Already replied to DM from ${chat.firstName || 'Unknown'} recently (30min cooldown), skipping for account ${accountId}`);
          return;
        }

        // Mark message as being processed
        this.markMessageProcessing(accountId, chatId, messageId);

        console.log(`[AUTO_REPLY] Received DM from ${chat.firstName || 'Unknown'}, sending auto-reply for account ${accountId}`);
        try {
          await client.sendMessage(chat, {
            message: settings.autoReplyDmMessage,
          });
          // Mark this chat as replied to (30-minute cooldown)
          this.markChatAsReplied(accountId, chatId);
          console.log(`[AUTO_REPLY] ✅ DM auto-reply sent successfully for account ${accountId}`);
        } catch (sendError) {
          logError(`[AUTO_REPLY] Error sending DM auto-reply:`, sendError);
        } finally {
          // Clear processing flag
          this.clearMessageProcessing(accountId, chatId, messageId);
        }
        return;
      }

      // Handle group auto-reply (only if account is mentioned OR message is reply to account's message)
      if (isGroup && settings.autoReplyGroupsEnabled && settings.autoReplyGroupsMessage) {
        // Check if account is mentioned in the message
        const isMentioned = await this.isAccountMentioned(message, me.id, me.username);
        
        // Check if message is a reply to account's message
        const isReplyToAccount = await this.isReplyToAccount(message, client, accountId);
        
        // Only reply if account is mentioned OR message is a reply to account's message
        if (!isMentioned && !isReplyToAccount) {
          return; // Don't reply if not mentioned and not a reply to account
        }
        
        // No cooldown for groups - reply to every mention/reply
        // Mark message as being processed
        this.markMessageProcessing(accountId, chatId, messageId);
        
        const triggerType = isMentioned ? 'mention' : 'reply to account message';
        console.log(`[AUTO_REPLY] Received ${triggerType} in group "${chat.title || 'Unknown'}", sending auto-reply for account ${accountId}`);
        try {
          await client.sendMessage(chat, {
            message: settings.autoReplyGroupsMessage,
          });
          console.log(`[AUTO_REPLY] ✅ Group auto-reply sent successfully for account ${accountId} (triggered by ${triggerType})`);
        } catch (sendError) {
          logError(`[AUTO_REPLY] Error sending group auto-reply:`, sendError);
        } finally {
          // Clear processing flag
          this.clearMessageProcessing(accountId, chatId, messageId);
        }
        return;
      }
    } catch (error) {
      // Don't log errors for messages we can't process (e.g., deleted chats, etc.)
      if (error.message && (
        error.message.includes('CHAT_ID_INVALID') ||
        error.message.includes('USER_DEACTIVATED') ||
        error.message.includes('PEER_ID_INVALID')
      )) {
        return; // Silently ignore these common errors
      }
      logError(`[AUTO_REPLY] Error processing message for account ${accountId}:`, error);
    }
  }
}

export default new AutoReplyHandler();


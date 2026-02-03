/**
 * Auto Reply Service (Event-Driven with Offline Status)
 * Uses event handlers for instant response - account appears OFFLINE
 * No polling - reacts immediately to messages
 */

import accountLinker from './accountLinker.js';
import configService from './configService.js';
import autoReplyHandler from './autoReplyHandler.js';
import { Api } from 'telegram/tl/index.js';

class AutoReplyRealtimeService {
  constructor() {
    // Track connected accounts for auto-reply
    this.connectedAccounts = new Map(); // accountId -> { client, userId, lastHealthCheck }
    
    // Interval to keep accounts appearing offline
    this.offlineInterval = null;
    // Set offline status every 8-12 seconds with randomization to avoid detection
    // More frequent updates = better stealth (but slightly more API calls)
    this.OFFLINE_INTERVAL_MIN = 8000; // 8 seconds minimum
    this.OFFLINE_INTERVAL_MAX = 12000; // 12 seconds maximum
    
    // Health check interval (every 2 minutes)
    this.healthCheckInterval = null;
    this.HEALTH_CHECK_INTERVAL = 120000; // 2 minutes
    
    // Track last successful message processing per account (for health monitoring)
    this.lastActivity = new Map(); // accountId -> timestamp
  }

  /**
   * Set account to appear offline (while still receiving messages)
   * This is critical to prevent Telegram from detecting the account as "always online"
   * Uses multiple attempts to ensure the status sticks
   */
  async setOfflineStatus(client, accountId) {
    try {
      if (client && client.connected) {
        // Set offline status multiple times to ensure it sticks (some clients may override it)
        await client.invoke(new Api.account.UpdateStatus({ offline: true }));
        // Small delay then set again
        await new Promise(resolve => setTimeout(resolve, 100));
        await client.invoke(new Api.account.UpdateStatus({ offline: true }));
        // One more time after another delay to be extra sure
        await new Promise(resolve => setTimeout(resolve, 50));
        await client.invoke(new Api.account.UpdateStatus({ offline: true }));
      }
    } catch (error) {
      // Silently ignore errors - some accounts may not support this
      // Only log unexpected errors that aren't related to auth or connection
      if (!error.message?.includes('AUTH_KEY') && 
          !error.message?.includes('not connected') &&
          !error.message?.includes('FLOOD_WAIT')) {
        // Suppress most errors to avoid log spam
      }
    }
  }

  /**
   * Connect an account for auto-reply (event-driven, appears offline)
   * Handles both new connections and re-registering handlers for existing connections
   */
  async connectAccount(accountId) {
    const accountIdStr = accountId.toString();
    
    try {
      // Get settings
      const settings = await configService.getAccountSettings(accountId);
      if (!settings) {
        await this.disconnectAccount(accountId);
        return false;
      }

      // Check if auto-reply is enabled AND has a message set
      const hasDmAutoReply = settings.autoReplyDmEnabled && 
                            settings.autoReplyDmMessage && 
                            settings.autoReplyDmMessage.trim().length > 0;
      const hasGroupsAutoReply = settings.autoReplyGroupsEnabled && 
                                settings.autoReplyGroupsMessage && 
                                settings.autoReplyGroupsMessage.trim().length > 0;
      const hasAutoReply = hasDmAutoReply || hasGroupsAutoReply;
      
      if (!hasAutoReply) {
        await this.disconnectAccount(accountId);
        return false;
      }

      // Get user ID
      const db = (await import('../database/db.js')).default;
      const result = await db.query('SELECT user_id FROM accounts WHERE account_id = ?', [accountId]);
      if (!result.rows || result.rows.length === 0) {
        await this.disconnectAccount(accountId);
        return false;
      }
      const userId = result.rows[0]?.user_id;

      // Check if already connected
      const existingAccount = this.connectedAccounts.get(accountIdStr);
      let client = null;
      
      if (existingAccount && existingAccount.client && existingAccount.client.connected) {
        // Already connected - just re-register handler to ensure it's active
        client = existingAccount.client;
        console.log(`[AUTO_REPLY] Account ${accountId} already connected, re-registering handler...`);
        
        // Remove old handler first to avoid duplicates
        try {
          autoReplyHandler.removeAutoReply(client);
        } catch (e) {
          // Ignore errors when removing
        }
      } else {
        // Need to connect
        client = await accountLinker.getClientAndConnect(userId, accountId);
        if (!client || !client.connected) {
          console.error(`[AUTO_REPLY] Could not connect account ${accountId}`);
          return false;
        }
      }

      // Set offline status BEFORE setting up handler to ensure we start offline
      await this.setOfflineStatus(client, accountId);

      // Remove any existing handlers first to avoid duplicates
      try {
        autoReplyHandler.removeAutoReply(client);
        // Small delay to ensure removal completes
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (e) {
        // Ignore errors when removing (handler might not exist)
      }

      // Set up event handler for auto-reply
      await autoReplyHandler.setupAutoReply(client, accountId);
      
      // Verify handler was registered (with retry)
      let handlerExists = await this.verifyHandlerRegistered(client, accountId);
      if (!handlerExists) {
        console.error(`[AUTO_REPLY] ⚠️ Handler registration failed for account ${accountId}, retrying...`);
        // Wait a bit before retry
        await new Promise(resolve => setTimeout(resolve, 200));
        // Retry handler registration
        await autoReplyHandler.setupAutoReply(client, accountId);
        // Verify again
        handlerExists = await this.verifyHandlerRegistered(client, accountId);
        if (!handlerExists) {
          console.error(`[AUTO_REPLY] ❌ Handler registration failed after retry for account ${accountId}`);
          throw new Error('Failed to register auto-reply handler after retry');
        }
      }
      
      // Set offline status again after handler setup
      await this.setOfflineStatus(client, accountId);
      
      // Track this account with health check timestamp
      this.connectedAccounts.set(accountIdStr, { 
        client, 
        userId, 
        accountId,
        lastHealthCheck: Date.now(),
        lastActivity: Date.now()
      });
      
      console.log(`[AUTO_REPLY] ✅ Account ${accountId} connected (event-driven, appears OFFLINE)`);
      return true;
    } catch (error) {
      console.error(`[AUTO_REPLY] Error connecting account ${accountId}:`, error.message);
      // Try to clean up on error
      try {
        await this.disconnectAccount(accountId);
      } catch (e) {
        // Ignore cleanup errors
      }
      return false;
    }
  }

  /**
   * Disconnect an account from auto-reply
   */
  async disconnectAccount(accountId) {
    const accountIdStr = accountId.toString();
    const account = this.connectedAccounts.get(accountIdStr);
    
    if (account) {
      try {
        autoReplyHandler.removeAutoReply(account.client);
      } catch (e) {}
      
      this.connectedAccounts.delete(accountIdStr);
      console.log(`[AUTO_REPLY] 🛑 Account ${accountId} disconnected from auto-reply`);
    }
  }

  /**
   * Get random interval for offline status updates (to avoid predictable patterns)
   */
  getRandomOfflineInterval() {
    return Math.floor(Math.random() * (this.OFFLINE_INTERVAL_MAX - this.OFFLINE_INTERVAL_MIN + 1)) + this.OFFLINE_INTERVAL_MIN;
  }

  /**
   * Check if event handler is still registered for a client
   */
  async verifyHandlerRegistered(client, accountId) {
    try {
      const { NewMessage } = await import('telegram/events/index.js');
      const handlers = client.listEventHandlers(NewMessage);
      return handlers && handlers.length > 0;
    } catch (error) {
      return false;
    }
  }

  /**
   * Health check: Verify connections and handlers are still active
   */
  async performHealthCheck() {
    const now = Date.now();
    
    for (const [accountIdStr, account] of this.connectedAccounts.entries()) {
      try {
        const accountId = parseInt(accountIdStr);
        let needsReconnect = false;
        let needsHandlerReRegister = false;

        // Check if client is connected
        if (!account.client || !account.client.connected) {
          console.log(`[AUTO_REPLY] ⚠️ Health check: Account ${accountIdStr} client disconnected`);
          needsReconnect = true;
        } else {
          // Check if handler is still registered
          const handlerExists = await this.verifyHandlerRegistered(account.client, accountId);
          if (!handlerExists) {
            console.log(`[AUTO_REPLY] ⚠️ Health check: Account ${accountIdStr} handler missing, re-registering...`);
            needsHandlerReRegister = true;
          }
        }

        // Reconnect if needed
        if (needsReconnect) {
          console.log(`[AUTO_REPLY] 🔄 Health check: Reconnecting account ${accountIdStr}...`);
          await this.connectAccount(accountId);
        } else if (needsHandlerReRegister) {
          // Re-register handler without full reconnect
          try {
            await autoReplyHandler.setupAutoReply(account.client, accountId);
            await this.setOfflineStatus(account.client, accountId);
            account.lastHealthCheck = now;
            console.log(`[AUTO_REPLY] ✅ Health check: Re-registered handler for account ${accountIdStr}`);
          } catch (error) {
            console.error(`[AUTO_REPLY] ❌ Health check: Failed to re-register handler for ${accountIdStr}:`, error.message);
            // If re-registration fails, try full reconnect
            await this.connectAccount(accountId);
          }
        } else {
          // Everything is good, update health check timestamp
          account.lastHealthCheck = now;
        }
      } catch (error) {
        console.error(`[AUTO_REPLY] ❌ Health check error for account ${accountIdStr}:`, error.message);
        // Try to reconnect on health check error
        try {
          await this.connectAccount(parseInt(accountIdStr));
        } catch (e) {
          // Ignore reconnect errors, will retry on next health check
        }
      }
    }
  }

  /**
   * Start health check monitoring
   */
  startHealthCheckLoop() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    
    this.healthCheckInterval = setInterval(async () => {
      await this.performHealthCheck();
    }, this.HEALTH_CHECK_INTERVAL);
    
    console.log(`[AUTO_REPLY] 🏥 Health check monitoring started (every ${this.HEALTH_CHECK_INTERVAL/1000}s)`);
  }

  /**
   * Periodically set offline status for all connected accounts
   * Uses randomized intervals to avoid detection patterns
   * Also performs basic connection checks
   */
  startOfflineStatusLoop() {
    if (this.offlineInterval) {
      clearTimeout(this.offlineInterval);
    }
    
    const scheduleNext = () => {
      const nextInterval = this.getRandomOfflineInterval();
      this.offlineInterval = setTimeout(async () => {
        for (const [accountIdStr, account] of this.connectedAccounts.entries()) {
          try {
            if (account.client && account.client.connected) {
              await this.setOfflineStatus(account.client, account.accountId);
            } else {
              // Client disconnected - try to reconnect
              console.log(`[AUTO_REPLY] Account ${accountIdStr} disconnected, reconnecting...`);
              await this.connectAccount(parseInt(accountIdStr));
            }
          } catch (e) {
            // Ignore individual account errors, will retry on next cycle
            console.log(`[AUTO_REPLY] Error in offline status loop for ${accountIdStr}:`, e.message);
          }
        }
        // Schedule next update with random interval
        scheduleNext();
      }, nextInterval);
    };
    
    // Start the first update
    scheduleNext();
  }

  /**
   * Start the auto-reply service
   */
  async start() {
    console.log('[AUTO_REPLY] 🚀 Starting auto-reply service (event-driven mode)...');
    console.log('[AUTO_REPLY] ⚙️  Mode: Event-driven (instant response), Account appears OFFLINE');
    console.log('[AUTO_REPLY] 🥷 Stealth: Account stays connected but appears offline to others');
    
    try {
      const db = (await import('../database/db.js')).default;
      const result = await db.query(
        `SELECT account_id FROM accounts 
         WHERE (auto_reply_dm_enabled = 1 OR auto_reply_groups_enabled = 1)`
      );

      if (result.rows.length === 0) {
        console.log(`[AUTO_REPLY] ℹ️  No accounts with auto-reply enabled`);
      } else {
        console.log(`[AUTO_REPLY] 📋 Found ${result.rows.length} account(s) with auto-reply enabled`);
        
        for (const row of result.rows) {
          await this.connectAccount(row.account_id);
        }
      }
      
      // Start the offline status maintenance loop
      this.startOfflineStatusLoop();
      
      // Start health check monitoring
      this.startHealthCheckLoop();
      
    } catch (error) {
      console.error('[AUTO_REPLY] ❌ Error starting service:', error.message);
    }

    console.log('[AUTO_REPLY] ✅ Service started (event-driven, accounts appear OFFLINE)');
  }

  /**
   * Stop the auto-reply service
   */
  stop() {
    console.log('[AUTO_REPLY] 🛑 Stopping service...');
    
    if (this.offlineInterval) {
      clearTimeout(this.offlineInterval);
      this.offlineInterval = null;
    }
    
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    
    const accountCount = this.connectedAccounts.size;
    
    for (const [accountIdStr] of this.connectedAccounts.entries()) {
      this.disconnectAccount(parseInt(accountIdStr));
    }
    
    this.connectedAccounts.clear();
    this.lastActivity.clear();
    console.log(`[AUTO_REPLY] ✅ Service stopped (${accountCount} account(s) were connected)`);
  }

  /**
   * Refresh auto-reply connections
   * Also verifies existing connections are still valid
   * This is the main method to call after any settings change
   */
  async refresh() {
    console.log('[AUTO_REPLY] 🔄 Refreshing auto-reply connections...');
    
    try {
      const db = (await import('../database/db.js')).default;
      const result = await db.query(
        `SELECT account_id FROM accounts 
         WHERE (auto_reply_dm_enabled = 1 OR auto_reply_groups_enabled = 1)
         AND (auto_reply_dm_message IS NOT NULL AND auto_reply_dm_message != '' 
              OR auto_reply_groups_message IS NOT NULL AND auto_reply_groups_message != '')`
      );

      const enabledIds = new Set(result.rows.map(r => r.account_id.toString()));
      
      // Disconnect accounts that no longer have auto-reply enabled or have no message
      for (const [accountIdStr] of this.connectedAccounts.entries()) {
        if (!enabledIds.has(accountIdStr)) {
          console.log(`[AUTO_REPLY] 🔄 Refresh: Disconnecting account ${accountIdStr} (auto-reply disabled or no message)`);
          await this.disconnectAccount(parseInt(accountIdStr));
        }
      }

      // Verify and reconnect existing accounts
      for (const [accountIdStr, account] of this.connectedAccounts.entries()) {
        if (enabledIds.has(accountIdStr)) {
          try {
            // Verify connection is still valid
            if (!account.client || !account.client.connected) {
              console.log(`[AUTO_REPLY] 🔄 Refresh: Reconnecting account ${accountIdStr}...`);
              await this.connectAccount(parseInt(accountIdStr));
            } else {
              // Verify handler is still registered
              const handlerExists = await this.verifyHandlerRegistered(account.client, parseInt(accountIdStr));
              if (!handlerExists) {
                console.log(`[AUTO_REPLY] 🔄 Refresh: Re-registering handler for account ${accountIdStr}...`);
                try {
                  // Remove old handler first to avoid duplicates
                  try {
                    autoReplyHandler.removeAutoReply(account.client);
                  } catch (e) {
                    // Ignore removal errors
                  }
                  
                  await autoReplyHandler.setupAutoReply(account.client, parseInt(accountIdStr));
                  
                  // Verify handler was registered
                  const verified = await this.verifyHandlerRegistered(account.client, parseInt(accountIdStr));
                  if (!verified) {
                    throw new Error('Handler verification failed after registration');
                  }
                  
                  await this.setOfflineStatus(account.client, parseInt(accountIdStr));
                  account.lastHealthCheck = Date.now();
                  console.log(`[AUTO_REPLY] ✅ Refresh: Handler re-registered for account ${accountIdStr}`);
                } catch (error) {
                  console.error(`[AUTO_REPLY] ❌ Refresh: Failed to re-register handler for ${accountIdStr}:`, error.message);
                  // If re-registration fails, try full reconnect
                  await this.connectAccount(parseInt(accountIdStr));
                }
              } else {
                // Handler exists, just update offline status and timestamp
                await this.setOfflineStatus(account.client, parseInt(accountIdStr));
                account.lastHealthCheck = Date.now();
              }
            }
          } catch (error) {
            console.error(`[AUTO_REPLY] ❌ Refresh: Error processing account ${accountIdStr}:`, error.message);
            // Try to reconnect on error
            try {
              await this.connectAccount(parseInt(accountIdStr));
            } catch (e) {
              console.error(`[AUTO_REPLY] ❌ Refresh: Failed to reconnect account ${accountIdStr}`);
            }
          }
        }
      }

      // Connect new accounts with auto-reply enabled
      for (const row of result.rows) {
        const accountIdStr = row.account_id.toString();
        if (!this.connectedAccounts.has(accountIdStr)) {
          console.log(`[AUTO_REPLY] 🔄 Refresh: Connecting new account ${accountIdStr}...`);
          await this.connectAccount(row.account_id);
        }
      }
      
      console.log(`[AUTO_REPLY] ✅ Refresh complete: ${this.connectedAccounts.size} account(s) connected`);
      return true;
    } catch (error) {
      console.error('[AUTO_REPLY] ❌ Refresh error:', error.message);
      return false;
    }
  }

  // Legacy methods for compatibility
  async startPolling(accountId) {
    return this.connectAccount(accountId);
  }

  stopPolling(accountId) {
    return this.disconnectAccount(accountId);
  }

  get pollingAccounts() {
    return this.connectedAccounts;
  }
}

export default new AutoReplyRealtimeService();

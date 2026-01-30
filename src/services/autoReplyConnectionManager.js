/**
 * Auto Reply Connection Manager
 * Keeps clients connected when auto-reply is enabled
 */

import accountLinker from './accountLinker.js';
import configService from './configService.js';
import autoReplyHandler from './autoReplyHandler.js';
import { logError } from '../utils/logger.js';

class AutoReplyConnectionManager {
  constructor() {
    this.connectedAccounts = new Set(); // accountId -> true
    this.connectionCheckInterval = null;
  }

  /**
   * Start keeping account connected for auto-reply
   */
  async keepAccountConnected(accountId) {
    try {
      const settings = await configService.getAccountSettings(accountId);
      if (!settings) return;

      // Always use real-time mode (interval mode removed)
      const hasAutoReply = (settings.autoReplyDmEnabled && settings.autoReplyDmMessage) ||
                          (settings.autoReplyGroupsEnabled && settings.autoReplyGroupsMessage);

      if (!hasAutoReply) {
        // Auto-reply not enabled - don't keep connected
        this.disconnectAccount(accountId);
        return;
      }

      // Get account info from database
      const db = (await import('../database/db.js')).default;
      const result = await db.query('SELECT user_id FROM accounts WHERE account_id = $1', [accountId]);
      if (!result.rows || result.rows.length === 0) return;
      
      const userId = result.rows[0].user_id;
      const client = await accountLinker.getClientAndConnect(userId, accountId);
      if (client && client.connected) {
        this.connectedAccounts.add(accountId.toString());
        await autoReplyHandler.setupAutoReply(client, accountId);
        console.log(`[AUTO_REPLY_CONN] Keeping account ${accountId} connected for real-time auto-reply`);
      }
    } catch (error) {
      logError(`[AUTO_REPLY_CONN] Error keeping account ${accountId} connected:`, error);
    }
  }

  /**
   * Disconnect account if no longer needed for auto-reply
   */
  async disconnectAccount(accountId) {
    const accountIdStr = accountId.toString();
    if (!this.connectedAccounts.has(accountIdStr)) return;

    try {
      const account = accountLinker.linkedAccounts?.get(accountIdStr);
      if (account && account.client && account.client.connected) {
        // Don't disconnect if it's being used for broadcasting
        // Just remove from our tracking
        this.connectedAccounts.delete(accountIdStr);
        console.log(`[AUTO_REPLY_CONN] Stopped tracking account ${accountId} for auto-reply`);
      }
    } catch (error) {
      logError(`[AUTO_REPLY_CONN] Error disconnecting account ${accountId}:`, error);
    }
  }

  /**
   * Check all accounts and keep them connected if needed
   */
  async checkAllAccounts() {
    try {
      const db = (await import('../database/db.js')).default;
      const result = await db.query(
        `SELECT account_id FROM accounts 
         WHERE (auto_reply_dm_enabled = 1 OR auto_reply_groups_enabled = 1)`
      );

      console.log(`[AUTO_REPLY_CONN] Found ${result.rows.length} accounts with auto-reply enabled`);
      
      for (const row of result.rows) {
        console.log(`[AUTO_REPLY_CONN] Checking account ${row.account_id}...`);
        await this.keepAccountConnected(row.account_id);
      }

      // Check connected accounts and reconnect if disconnected
      for (const accountIdStr of this.connectedAccounts) {
        const accountId = parseInt(accountIdStr);
        const settings = await configService.getAccountSettings(accountId);
        if (!settings) {
          this.connectedAccounts.delete(accountIdStr);
          continue;
        }

        const hasAutoReply = (settings.autoReplyDmEnabled && settings.autoReplyDmMessage) ||
                            (settings.autoReplyGroupsEnabled && settings.autoReplyGroupsMessage);

        if (!hasAutoReply) {
          await this.disconnectAccount(accountId);
          continue;
        }

        // Check if client is still connected, reconnect if needed
        const account = accountLinker.linkedAccounts?.get(accountIdStr);
        if (!account || !account.client || !account.client.connected) {
          console.log(`[AUTO_REPLY_CONN] Client disconnected for account ${accountId}, reconnecting...`);
          await this.keepAccountConnected(accountId);
        }
      }
    } catch (error) {
      logError('[AUTO_REPLY_CONN] Error checking all accounts:', error);
    }
  }

  /**
   * Start periodic checking
   */
  start() {
    if (this.connectionCheckInterval) return;

    // Check immediately
    console.log('[AUTO_REPLY_CONN] Checking all accounts for auto-reply...');
    this.checkAllAccounts().catch(error => {
      logError('[AUTO_REPLY_CONN] Error in initial checkAllAccounts:', error);
    });

    // Check every 30 seconds
    this.connectionCheckInterval = setInterval(() => {
      this.checkAllAccounts().catch(error => {
        logError('[AUTO_REPLY_CONN] Error in periodic checkAllAccounts:', error);
      });
    }, 30000);

    console.log('[AUTO_REPLY_CONN] Started connection manager');
  }

  /**
   * Stop periodic checking
   */
  stop() {
    if (this.connectionCheckInterval) {
      clearInterval(this.connectionCheckInterval);
      this.connectionCheckInterval = null;
    }
    this.connectedAccounts.clear();
    console.log('[AUTO_REPLY_CONN] Stopped connection manager');
  }
}

export default new AutoReplyConnectionManager();


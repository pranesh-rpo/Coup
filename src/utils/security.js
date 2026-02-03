/**
 * Security Utilities
 * Input validation, sanitization, and security helpers
 */

/**
 * Sanitize string input to prevent injection attacks
 * @param {string} input - Input string to sanitize
 * @param {number} maxLength - Maximum allowed length
 * @returns {string} Sanitized string
 */
export function sanitizeString(input, maxLength = 1000) {
  if (typeof input !== 'string') {
    return '';
  }
  
  // Remove null bytes and control characters (except newlines and tabs)
  let sanitized = input.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');
  
  // Trim whitespace
  sanitized = sanitized.trim();
  
  // Limit length
  if (sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength);
  }
  
  return sanitized;
}

/**
 * Validate and sanitize user ID
 * @param {any} userId - User ID to validate
 * @returns {number|null} Validated user ID or null
 */
export function validateUserId(userId) {
  if (userId === null || userId === undefined) {
    return null;
  }
  
  const userIdNum = typeof userId === 'string' ? parseInt(userId, 10) : Number(userId);
  
  if (isNaN(userIdNum) || userIdNum <= 0 || !Number.isInteger(userIdNum)) {
    return null;
  }
  
  // Telegram user IDs are typically 32-bit integers, but can be larger
  // Check reasonable bounds (1 to 2^53 - 1, JavaScript's safe integer limit)
  if (userIdNum > Number.MAX_SAFE_INTEGER) {
    return null;
  }
  
  return userIdNum;
}

/**
 * Validate and sanitize account ID
 * @param {any} accountId - Account ID to validate
 * @returns {number|null} Validated account ID or null
 */
export function validateAccountId(accountId) {
  if (accountId === null || accountId === undefined) {
    return null;
  }
  
  const accountIdNum = typeof accountId === 'string' ? parseInt(accountId, 10) : Number(accountId);
  
  if (isNaN(accountIdNum) || accountIdNum <= 0 || !Number.isInteger(accountIdNum)) {
    return null;
  }
  
  return accountIdNum;
}

/**
 * Validate phone number format (E.164)
 * @param {string} phone - Phone number to validate
 * @returns {boolean} True if valid
 */
export function validatePhoneNumber(phone) {
  if (typeof phone !== 'string') {
    return false;
  }
  
  // E.164 format: + followed by 1-15 digits
  const phoneRegex = /^\+[1-9]\d{1,14}$/;
  return phoneRegex.test(phone.trim());
}

/**
 * Sanitize callback data to prevent injection
 * @param {string} data - Callback data
 * @returns {string} Sanitized callback data
 */
export function sanitizeCallbackData(data) {
  if (typeof data !== 'string') {
    return '';
  }
  
  // Only allow alphanumeric, underscore, dash, and specific prefixes
  // Max length 64 bytes (Telegram limit)
  const sanitized = data.replace(/[^a-zA-Z0-9_\-]/g, '').substring(0, 64);
  
  return sanitized;
}

/**
 * Validate callback data format
 * @param {string} data - Callback data to validate
 * @returns {boolean} True if valid format
 */
export function validateCallbackData(data) {
  if (typeof data !== 'string' || data.length === 0 || data.length > 64) {
    return false;
  }
  
  // Only allow safe characters
  return /^[a-zA-Z0-9_\-]+$/.test(data);
}

/**
 * Sanitize SQL limit value to prevent injection
 * @param {any} limit - Limit value
 * @param {number} maxLimit - Maximum allowed limit
 * @returns {number} Validated limit
 */
export function sanitizeLimit(limit, maxLimit = 1000) {
  const limitNum = typeof limit === 'string' ? parseInt(limit, 10) : Number(limit);
  
  if (isNaN(limitNum) || limitNum <= 0 || !Number.isInteger(limitNum)) {
    return 100; // Default limit
  }
  
  // Ensure limit doesn't exceed maximum
  return Math.min(limitNum, maxLimit);
}

/**
 * Validate table name against whitelist (prevents SQL injection)
 * @param {string} tableName - Table name to validate
 * @param {string[]} allowedTables - Whitelist of allowed table names
 * @returns {boolean} True if valid
 */
export function validateTableName(tableName, allowedTables) {
  if (typeof tableName !== 'string') {
    return false;
  }
  
  // Only allow alphanumeric and underscore
  if (!/^[a-zA-Z0-9_]+$/.test(tableName)) {
    return false;
  }
  
  // Check against whitelist
  return allowedTables.includes(tableName);
}

/**
 * Get user-friendly error message (never shows technical details)
 * @returns {string} Generic error message for users
 */
export function getUserFriendlyErrorMessage() {
  return 'An error occurred. Please try again later or contact support if the problem persists.';
}

/**
 * Sanitize error message to prevent information leakage
 * @param {Error|string} error - Error object or message
 * @param {boolean} includeDetails - Whether to include error details (for admin/internal use)
 * @param {boolean} forUser - If true, always return generic message (default: false for backward compatibility)
 * @returns {string} Sanitized error message
 */
export function sanitizeErrorMessage(error, includeDetails = false, forUser = false) {
  // If this is for a user, always return generic message
  if (forUser || !includeDetails) {
    return getUserFriendlyErrorMessage();
  }
  
  let message = '';
  
  if (error instanceof Error) {
    message = error.message || 'An error occurred';
  } else if (typeof error === 'string') {
    message = error;
  } else {
    return 'An unknown error occurred';
  }
  
  // Remove sensitive information patterns
  const sensitivePatterns = [
    /password/gi,
    /token/gi,
    /secret/gi,
    /api[_-]?key/gi,
    /auth[_-]?key/gi,
    /session/gi,
    /private[_-]?key/gi,
  ];
  
  let sanitized = message;
  for (const pattern of sensitivePatterns) {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }
  
  // Remove file paths that might expose system structure
  sanitized = sanitized.replace(/\/[^\s]+/g, '[PATH]');
  
  // Remove code snippets, stack traces, and technical details
  sanitized = sanitized.replace(/at\s+.*?\(.*?\)/g, '[STACK]');
  sanitized = sanitized.replace(/Error:\s*/gi, '');
  sanitized = sanitized.replace(/TypeError|ReferenceError|SyntaxError/gi, 'Error');
  
  // Limit length
  if (sanitized.length > 200) {
    sanitized = sanitized.substring(0, 197) + '...';
  }
  
  // For user-facing errors, be generic
  if (sanitized.toLowerCase().includes('sql') || sanitized.toLowerCase().includes('database')) {
    return 'Database error occurred. Please try again.';
  }
  if (sanitized.toLowerCase().includes('connection') || sanitized.toLowerCase().includes('network')) {
    return 'Connection error occurred. Please try again.';
  }
  
  return sanitized;
}

/**
 * Rate limiting tracker for commands
 */
class RateLimiter {
  constructor() {
    this.attempts = new Map(); // userId -> { count, resetTime }
  }
  
  /**
   * Check if user has exceeded rate limit
   * @param {number} userId - User ID
   * @param {number} maxAttempts - Maximum attempts allowed
   * @param {number} windowMs - Time window in milliseconds
   * @returns {Object} { allowed: boolean, remaining: number, resetIn: number }
   */
  checkRateLimit(userId, maxAttempts = 10, windowMs = 60000) {
    const now = Date.now();
    const userAttempts = this.attempts.get(userId);
    
    if (!userAttempts || now > userAttempts.resetTime) {
      // Reset or initialize
      this.attempts.set(userId, {
        count: 1,
        resetTime: now + windowMs
      });
      return { allowed: true, remaining: maxAttempts - 1, resetIn: windowMs };
    }
    
    if (userAttempts.count >= maxAttempts) {
      const resetIn = userAttempts.resetTime - now;
      return { allowed: false, remaining: 0, resetIn: Math.max(0, resetIn) };
    }
    
    userAttempts.count++;
    return { 
      allowed: true, 
      remaining: maxAttempts - userAttempts.count, 
      resetIn: userAttempts.resetTime - now 
    };
  }
  
  /**
   * Reset rate limit for user
   * @param {number} userId - User ID
   */
  reset(userId) {
    this.attempts.delete(userId);
  }
  
  /**
   * Cleanup old entries
   */
  cleanup() {
    const now = Date.now();
    for (const [userId, attempts] of this.attempts.entries()) {
      if (now > attempts.resetTime) {
        this.attempts.delete(userId);
      }
    }
  }
}

// Global rate limiters for different command types
export const commandRateLimiter = new RateLimiter();
export const adminCommandRateLimiter = new RateLimiter();
export const broadcastRateLimiter = new RateLimiter();

// Cleanup rate limiters every 5 minutes
setInterval(() => {
  commandRateLimiter.cleanup();
  adminCommandRateLimiter.cleanup();
  broadcastRateLimiter.cleanup();
}, 5 * 60 * 1000);

/**
 * Verify account ownership
 * @param {number} userId - User ID
 * @param {number} accountId - Account ID
 * @param {Function} dbQuery - Database query function
 * @returns {Promise<boolean>} True if user owns the account
 */
export async function verifyAccountOwnership(userId, accountId, dbQuery) {
  try {
    const validatedUserId = validateUserId(userId);
    const validatedAccountId = validateAccountId(accountId);
    
    if (!validatedUserId || !validatedAccountId) {
      return false;
    }
    
    const result = await dbQuery(
      'SELECT user_id FROM accounts WHERE account_id = $1 AND user_id = $2',
      [validatedAccountId, validatedUserId]
    );
    
    return result.rows.length > 0;
  } catch (error) {
    console.error('[SECURITY] Error verifying account ownership:', error);
    return false;
  }
}

/**
 * Validate HTML content to prevent XSS
 * @param {string} html - HTML string to validate
 * @returns {string} Sanitized HTML
 */
export function sanitizeHTML(html) {
  if (typeof html !== 'string') {
    return '';
  }
  
  // Remove script tags and event handlers
  let sanitized = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/on\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/on\w+\s*=\s*[^\s>]*/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/data:text\/html/gi, '');
  
  // Limit length
  if (sanitized.length > 4096) {
    sanitized = sanitized.substring(0, 4093) + '...';
  }
  
  return sanitized;
}


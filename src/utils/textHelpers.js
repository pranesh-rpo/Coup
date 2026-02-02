/**
 * Text and HTML helper utilities
 * Shared across the application to avoid code duplication
 */

/**
 * Escape HTML entities in text to prevent HTML tags from being rendered
 * @param {string} text - Text to escape
 * @returns {string} - Escaped text
 */
export function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Strip HTML tags from text to convert HTML formatted messages to plain text
 * This is useful when users forward messages with Telegram formatting
 * @param {string} text - Text with HTML tags
 * @returns {string} - Plain text without HTML tags
 */
export function stripHtmlTags(text) {
  if (!text) return '';
  
  // Ensure we're working with a string
  let workingText = String(text);
  
  // First decode HTML entities
  let decoded = workingText
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
  
  // Then strip HTML tags (including Telegram-specific formatting)
  // Remove common HTML tags like <b>, </b>, <i>, </i>, <code>, </code>, <pre>, </pre>, <a>, etc.
  let stripped = decoded.replace(/<[^>]+>/g, '');
  
  // Decode any remaining HTML entities (in case some were nested)
  stripped = stripped
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
  
  return stripped.trim();
}

/**
 * Truncate text to a maximum length with ellipsis
 * @param {string} text - Text to truncate
 * @param {number} maxLength - Maximum length (default: 100)
 * @param {string} suffix - Suffix to add when truncated (default: '...')
 * @returns {string} - Truncated text
 */
export function truncateText(text, maxLength = 100, suffix = '...') {
  if (!text) return '';
  const str = String(text);
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength - suffix.length) + suffix;
}

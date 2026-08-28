/**
 * Flowback — Context Utilities
 * Handles validation, sanitization, and truncation of captured context
 * before sending to AI. Privacy-focused: no sensitive data logging.
 */

// Maximum lengths for AI input (to control cost, latency, privacy)
const LIMITS = {
  title: 500,
  url: 2000,
  selectedText: 1500,
  visibleText: 3500,
  focusedElement: 300,
  inputContext: 1500,
  totalPayload: 8000
};

// Sensitive patterns that should never be sent to AI or logged
const SENSITIVE_PATTERNS = [
  /password/i,
  /passwd/i,
  /credit.*card/i,
  /card.*number/i,
  /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/, // credit card numbers
  /\b\d{3}[-]?\d{2}[-]?\d{4}\b/, // SSN
  /cvv/i,
  /cvc/i
];

function truncate(text, maxLength) {
  if (typeof text !== 'string') return '';
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return trimmed.slice(0, maxLength).trimEnd() + '…';
}

function containsSensitiveData(text) {
  if (typeof text !== 'string' || !text) return false;
  return SENSITIVE_PATTERNS.some(pattern => pattern.test(text));
}

function sanitizeField(text, maxLength, fieldName) {
  if (typeof text !== 'string') return '';
  // If sensitive, return empty or redacted
  if (containsSensitiveData(text)) {
    return `[${fieldName} redacted for privacy]`;
  }
  return truncate(text, maxLength);
}

/**
 * Validates and sanitizes incoming context from extension
 * Returns { valid: boolean, sanitized: object, error?: string }
 */
function validateAndSanitizeContext(rawContext) {
  if (!rawContext || typeof rawContext !== 'object' || Array.isArray(rawContext)) {
    return { valid: false, error: 'Invalid context: must be an object' };
  }

  const sanitized = {
    title: sanitizeField(rawContext.title, LIMITS.title, 'title'),
    url: sanitizeField(rawContext.url, LIMITS.url, 'url'),
    selectedText: sanitizeField(rawContext.selectedText, LIMITS.selectedText, 'selected'),
    visibleText: sanitizeField(rawContext.visibleText, LIMITS.visibleText, 'visible'),
    focusedElement: sanitizeField(rawContext.focusedElement, LIMITS.focusedElement, 'focused'),
    inputContext: sanitizeField(rawContext.inputContext, LIMITS.inputContext, 'input')
  };

  // Check if at least one field has meaningful content
  const hasContent = Object.values(sanitized).some(v => v && v.length > 0 && !v.includes('redacted'));
  
  // Even empty context is valid - AI will return "Not enough context."
  // We only reject completely malformed payloads
  
  // Enforce total payload size
  const totalLength = Object.values(sanitized).reduce((sum, v) => sum + (v ? v.length : 0), 0);
  if (totalLength > LIMITS.totalPayload) {
    // Further truncate visibleText which is usually the largest
    const excess = totalLength - LIMITS.totalPayload;
    sanitized.visibleText = truncate(sanitized.visibleText, Math.max(500, sanitized.visibleText.length - excess));
  }

  return {
    valid: true,
    sanitized,
    hasContent,
    totalLength: Object.values(sanitized).reduce((sum, v) => sum + (v ? v.length : 0), 0)
  };
}

/**
 * Builds the user prompt for AI from sanitized context
 */
function buildUserPrompt(context) {
  const parts = [];

  if (context.title) parts.push(`Title: ${context.title}`);
  if (context.url) parts.push(`URL: ${context.url}`);
  if (context.selectedText) parts.push(`Selected Text: "${context.selectedText}"`);
  if (context.visibleText) parts.push(`Visible Text: ${context.visibleText.slice(0, 2000)}`);
  if (context.focusedElement) parts.push(`Focused Element: ${context.focusedElement}`);
  if (context.inputContext) parts.push(`Input Context: "${context.inputContext}"`);

  if (parts.length === 0) {
    return 'No context captured. All fields empty.';
  }

  return parts.join('\n\n');
}

/**
 * Validates AI response structure
 */
function validateAIResponse(response) {
  if (!response || typeof response !== 'object') {
    return { valid: false, error: 'Response not an object' };
  }

  const { task, tried, next } = response;

  if (typeof task !== 'string' || typeof tried !== 'string' || typeof next !== 'string') {
    return { valid: false, error: 'Missing or invalid fields: task, tried, next must be strings' };
  }

  // Check not empty (allow "Not enough context." as valid)
  if (!task.trim() || !tried.trim() || !next.trim()) {
    return { valid: false, error: 'Fields cannot be empty' };
  }

  // Enforce max ~30 words per field (allow some buffer over 20)
  const wordCount = (str) => str.trim().split(/\s+/).length;
  const MAX_WORDS = 35;

  if (wordCount(task) > MAX_WORDS || wordCount(tried) > MAX_WORDS || wordCount(next) > MAX_WORDS) {
    return { valid: false, error: `Fields exceed ${MAX_WORDS} words` };
  }

  return { valid: true, sanitized: { task: task.trim(), tried: tried.trim(), next: next.trim() } };
}

module.exports = {
  LIMITS,
  truncate,
  containsSensitiveData,
  sanitizeField,
  validateAndSanitizeContext,
  buildUserPrompt,
  validateAIResponse
};

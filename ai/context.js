/**
 * Flowback — Context Utilities
 * Handles validation, sanitization, truncation, and deterministic fallback
 * Privacy-focused: no sensitive data logging.
 */

const LIMITS = {
  title: 500,
  url: 2000,
  selectedText: 1500,
  visibleText: 3500,
  focusedElement: 300,
  inputContext: 1500,
  totalPayload: 8000
};

const SENSITIVE_PATTERNS = [
  /password/i,
  /passwd/i,
  /credit.*card/i,
  /card.*number/i,
  /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/,
  /\b\d{3}[-]?\d{2}[-]?\d{4}\b/,
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
  if (containsSensitiveData(text)) {
    return `[${fieldName} redacted for privacy]`;
  }
  return truncate(text, maxLength);
}

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

  const hasContent = Object.values(sanitized).some(v => v && v.length > 0 && !v.includes('redacted'));
  
  const totalLength = Object.values(sanitized).reduce((sum, v) => sum + (v ? v.length : 0), 0);
  if (totalLength > LIMITS.totalPayload) {
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

function buildUserPrompt(context) {
  const parts = [];
  if (context.title) parts.push(`Title: ${context.title}`);
  if (context.url) parts.push(`URL: ${context.url}`);
  if (context.selectedText) parts.push(`Selected Text: "${context.selectedText}"`);
  if (context.visibleText) parts.push(`Visible Text: ${context.visibleText.slice(0, 2000)}`);
  if (context.focusedElement) parts.push(`Focused Element: ${context.focusedElement}`);
  if (context.inputContext) parts.push(`Input Context: "${context.inputContext}"`);
  if (parts.length === 0) return 'No context captured. All fields empty.';
  return parts.join('\n\n');
}

function validateAIResponse(response) {
  if (!response || typeof response !== 'object') {
    return { valid: false, error: 'Response not an object' };
  }
  const { task, tried, next } = response;
  if (typeof task !== 'string' || typeof tried !== 'string' || typeof next !== 'string') {
    return { valid: false, error: 'Missing or invalid fields: task, tried, next must be strings' };
  }
  if (!task.trim() || !tried.trim() || !next.trim()) {
    return { valid: false, error: 'Fields cannot be empty' };
  }
  const wordCount = (str) => str.trim().split(/\s+/).length;
  const MAX_WORDS = 35;
  if (wordCount(task) > MAX_WORDS || wordCount(tried) > MAX_WORDS || wordCount(next) > MAX_WORDS) {
    return { valid: false, error: `Fields exceed ${MAX_WORDS} words` };
  }
  return { valid: true, sanitized: { task: task.trim(), tried: tried.trim(), next: next.trim() } };
}

/**
 * Deterministic fallback reconstruction - NO AI required
 * Builds TASK/TRIED/NEXT from raw captured context
 * This is the core MVP that works without AI
 */
function deterministicReconstruct(context) {
  if (!context || typeof context !== 'object') {
    return {
      task: "Not enough context.",
      tried: "Not enough context.",
      next: "Not enough context."
    };
  }

  const title = (context.title || '').trim();
  const url = (context.url || '').trim();
  const selected = (context.selectedText || '').trim();
  const visible = (context.visibleText || '').trim();
  const input = (context.inputContext || '').trim();
  const focused = (context.focusedElement || '').trim();

  // TASK: What was user working on?
  let task = "Not enough context.";
  if (selected) {
    // If selected text, use it as primary task indicator
    const shortSelected = selected.slice(0, 80).replace(/\s+/g, ' ').trim();
    if (shortSelected.length > 10) {
      task = `Working on: "${shortSelected}"`;
    } else if (title) {
      task = `Working on ${title.slice(0, 60)}`;
    }
  } else if (title) {
    // Clean title: remove common suffixes like " - Stack Overflow", " - GitHub"
    const cleanTitle = title.split(' - ')[0].split(' | ')[0].trim().slice(0, 70);
    task = cleanTitle || "Browsing webpage";
  } else if (url) {
    try {
      const domain = new URL(url).hostname.replace('www.', '');
      task = `Browsing ${domain}`;
    } catch {
      task = "Browsing webpage";
    }
  } else if (visible) {
    const firstSentence = visible.split(/[.!?]/)[0]?.trim().slice(0, 80) || '';
    task = firstSentence ? `Reading: ${firstSentence}` : "Working on webpage";
  }

  // TRIED: What had user attempted?
  let tried = "Not enough context.";
  if (input) {
    const shortInput = input.slice(0, 80).replace(/\s+/g, ' ').trim();
    tried = `Typed: "${shortInput}"`;
  } else if (selected && visible) {
    tried = `Selected text and reviewed page content`;
  } else if (selected) {
    tried = `Selected: "${selected.slice(0, 60)}"`;
  } else if (focused) {
    tried = `Focused on ${focused}`;
  } else if (visible) {
    // Extract some context from visible text
    const words = visible.split(/\s+/).slice(0, 20).join(' ');
    tried = words.length > 20 ? `Reviewed: ${words.slice(0, 80)}…` : "Reviewed page content";
  }

  // NEXT: Most likely next action
  let next = "Resume from your captured context";
  if (url) {
    next = "Continue where you left off";
  }
  if (input && input.length > 0) {
    next = "Continue typing and complete your work";
  } else if (selected) {
    next = "Continue working with selected content";
  } else if (title && title.toLowerCase().includes('stackoverflow')) {
    next = "Continue debugging and test the solution";
  } else if (title && title.toLowerCase().includes('github')) {
    next = "Continue coding and review changes";
  } else if (title && title.toLowerCase().includes('docs')) {
    next = "Continue reading documentation";
  }

  // Ensure max ~20 words per field
  const limitWords = (str, max = 20) => {
    const words = str.trim().split(/\s+/);
    if (words.length <= max) return str;
    return words.slice(0, max).join(' ') + '…';
  };

  return {
    task: limitWords(task, 20),
    tried: limitWords(tried, 20),
    next: limitWords(next, 20)
  };
}

module.exports = {
  LIMITS,
  truncate,
  containsSensitiveData,
  sanitizeField,
  validateAndSanitizeContext,
  buildUserPrompt,
  validateAIResponse,
  deterministicReconstruct
};

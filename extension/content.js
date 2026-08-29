/**
 * Flowback — content.js
 * Reactive context capture + scroll viewport positioning + secret filtering.
 * Privacy: filters sensitive fields, tokens, passwords, limits length.
 */

const MAX_VISIBLE_TEXT_LENGTH = 3500;
const MAX_INPUT_TEXT_LENGTH = 1000;

const CONTENT_SELECTORS = [
  '#mw-content-text .mw-parser-output',
  '#bodyContent',
  'article',
  'main article',
  '[role="main"] article',
  'main',
  '[role="main"]',
  '.post-content',
  '.markdown-body',
  '#content'
];

const SENSITIVE_TOKEN_PATTERNS = [
  /password/i,
  /passwd/i,
  /credit.*card/i,
  /card.*number/i,
  /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/,
  /\b\d{3}[-]?\d{2}[-]?\d{4}\b/,
  /bearer\s+[a-zA-Z0-9_\-\.=:_+/]+/i,
  /\bey[a-zA-Z0-9_\-]{10,}\.ey[a-zA-Z0-9_\-]{10,}\.[a-zA-Z0-9_\-]{10,}\b/,
  /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{30,}\b/,
  /\bsk-[a-zA-Z0-9_\-]{20,}\b/,
  /\bAIzaSy[A-Za-z0-9_\-]{33}\b/
];

function redactSecrets(text) {
  if (!text || typeof text !== 'string') return '';
  let clean = text;
  for (const pattern of SENSITIVE_TOKEN_PATTERNS) {
    clean = clean.replace(pattern, '[REDACTED]');
  }
  return clean;
}

function isSensitiveField(el) {
  if (!el) return false;
  try {
    const type = ((el.getAttribute && el.getAttribute('type')) || el.type || '').toLowerCase();
    if (type === 'password') return true;
    const autocomplete = ((el.getAttribute && el.getAttribute('autocomplete')) || '').toLowerCase();
    const sensitiveAutocomplete = [
      'cc-number', 'cc-name', 'cc-exp', 'cc-exp-month', 'cc-exp-year',
      'cc-csc', 'cc-type', 'current-password', 'new-password'
    ];
    if (sensitiveAutocomplete.some(key => autocomplete.includes(key))) return true;
    const hints = [
      el.name,
      el.id,
      el.getAttribute && el.getAttribute('placeholder'),
      el.getAttribute && el.getAttribute('aria-label')
    ].filter(Boolean).join(' ').toLowerCase();
    const sensitiveKeywords = [
      'password', 'passwd', 'pwd', 'credit', 'card', 'cvv', 'cvc', 'cvv2',
      'ccv', 'cardnumber', 'card-number', 'expiry', 'exp-date', 'ssn',
      'social security', 'security code', 'cardholder', 'payment', 'pin',
      'apikey', 'api-key', 'secret', 'token', 'auth'
    ];
    return sensitiveKeywords.some(key => hints.includes(key));
  } catch {
    return true;
  }
}

function getSelectedText() {
  try {
    const selection = window.getSelection ? window.getSelection() : null;
    const text = selection ? selection.toString().trim() : '';
    return redactSecrets(text.slice(0, 1500));
  } catch {
    return '';
  }
}

function getVisibleText() {
  try {
    if (!document.body) return '';
    let text = '';
    for (const selector of CONTENT_SELECTORS) {
      const container = document.querySelector(selector);
      if (!container) continue;
      const candidate = (container.innerText || container.textContent || '')
        .replace(/\s+/g, ' ')
        .trim();
      if (candidate && candidate.length > 50) {
        text = candidate;
        break;
      }
    }
    if (!text) {
      text = (document.body.innerText || document.body.textContent || '')
        .replace(/\s+/g, ' ')
        .trim();
    }
    text = text.replace(/\n{3,}/g, '\n\n').trim();
    const truncated = text.length > MAX_VISIBLE_TEXT_LENGTH ? text.slice(0, MAX_VISIBLE_TEXT_LENGTH) + '…' : text;
    return redactSecrets(truncated);
  } catch {
    return '';
  }
}

function getHeadings() {
  try {
    const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
      .slice(0, 5)
      .map(h => (h.innerText || '').trim())
      .filter(Boolean)
      .join(' | ');
    return redactSecrets(headings.slice(0, 500));
  } catch {
    return '';
  }
}

function describeElement(el) {
  try {
    if (!el || el === document.body || !el.tagName) return '';
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : '';
    const classes = (typeof el.className === 'string' && el.className.trim())
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
      : '';
    return `${tag}${id}${classes}`.slice(0, 200);
  } catch {
    return '';
  }
}

function getInputContext(el) {
  try {
    if (!el || !el.tagName) return '';
    const tag = el.tagName.toLowerCase();
    const isEditable = el.isContentEditable === true;
    if (tag !== 'input' && tag !== 'textarea' && !isEditable) return '';
    if (isSensitiveField(el)) return '';
    let text = '';
    if (tag === 'input' || tag === 'textarea') {
      text = el.value || '';
    } else {
      text = el.innerText || el.textContent || '';
    }
    text = text.trim();
    if (!text) return '';
    const limited = text.length > MAX_INPUT_TEXT_LENGTH ? text.slice(0, MAX_INPUT_TEXT_LENGTH) + '…' : text;
    return redactSecrets(limited);
  } catch {
    return '';
  }
}

function getScrollPosition() {
  return {
    scrollX: Math.round(window.scrollX || window.pageXOffset || 0),
    scrollY: Math.round(window.scrollY || window.pageYOffset || 0)
  };
}

function captureContext() {
  const scroll = getScrollPosition();
  const context = {
    title: '',
    url: '',
    selectedText: '',
    visibleText: '',
    focusedElement: '',
    inputContext: '',
    headings: '',
    scrollX: scroll.scrollX,
    scrollY: scroll.scrollY
  };

  try { context.title = document.title || ''; } catch {}
  try { context.url = window.location.href || ''; } catch {}
  try { context.selectedText = getSelectedText(); } catch {}
  try { context.visibleText = getVisibleText(); } catch {}
  try { context.headings = getHeadings(); } catch {}

  let activeEl = null;
  try { activeEl = document.activeElement; } catch {}
  try { context.focusedElement = describeElement(activeEl); } catch {}
  try { context.inputContext = getInputContext(activeEl); } catch {}

  return context;
}

// Listen for background messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return false;

  if (message.type === 'CAPTURE_CONTEXT') {
    try {
      const context = captureContext();
      sendResponse(context);
    } catch (error) {
      console.warn('[Flowback] Capture failed:', error.message);
      const scroll = getScrollPosition();
      sendResponse({
        title: document.title || '',
        url: window.location.href || '',
        selectedText: '',
        visibleText: '',
        focusedElement: '',
        inputContext: '',
        headings: '',
        scrollX: scroll.scrollX,
        scrollY: scroll.scrollY,
        error: 'capture_failed'
      });
    }
    return false;
  }

  if (message.type === 'RESTORE_SCROLL') {
    try {
      const targetX = typeof message.scrollX === 'number' ? message.scrollX : 0;
      const targetY = typeof message.scrollY === 'number' ? message.scrollY : 0;
      window.scrollTo({ left: targetX, top: targetY, behavior: 'smooth' });
      sendResponse({ status: 'scrolled', scrollX: targetX, scrollY: targetY });
    } catch (e) {
      sendResponse({ status: 'error', error: e.message });
    }
    return false;
  }

  return false;
});


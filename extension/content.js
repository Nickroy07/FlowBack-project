/**
 * Flowback — content.js
 * Reactive context capture - no continuous monitoring, only on CAPTURE_CONTEXT
 * Privacy: filters sensitive fields, limits length
 */

const MAX_VISIBLE_TEXT_LENGTH = 4000;
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
      'social security', 'security code', 'cardholder', 'payment', 'pin'
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
    return text.slice(0, 1500);
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
    // Remove excessive whitespace and limit
    text = text.replace(/\n{3,}/g, '\n\n').trim();
    return text.length > MAX_VISIBLE_TEXT_LENGTH ? text.slice(0, MAX_VISIBLE_TEXT_LENGTH) + '…' : text;
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
    return headings.slice(0, 500);
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
    return text.length > MAX_INPUT_TEXT_LENGTH ? text.slice(0, MAX_INPUT_TEXT_LENGTH) + '…' : text;
  } catch {
    return '';
  }
}

function captureContext() {
  const context = {
    title: '',
    url: '',
    selectedText: '',
    visibleText: '',
    focusedElement: '',
    inputContext: '',
    headings: ''
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'CAPTURE_CONTEXT') {
    return false;
  }

  try {
    const context = captureContext();
    console.log('[Flowback] Context captured:', {
      title: context.title?.slice(0, 50),
      url: context.url?.slice(0, 50),
      hasSelected: !!context.selectedText,
      visibleLength: context.visibleText?.length || 0,
      hasInput: !!context.inputContext
    });
    sendResponse(context);
  } catch (error) {
    console.warn('[Flowback] Capture failed:', error.message);
    sendResponse({
      title: document.title || '',
      url: window.location.href || '',
      selectedText: '',
      visibleText: '',
      focusedElement: '',
      inputContext: '',
      error: 'capture_failed'
    });
  }

  return true; // Keep channel open for async response
});

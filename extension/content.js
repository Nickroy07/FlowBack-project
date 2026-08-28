/**
 * Flowback — content.js
 * -------------------------------------------------------------
 * Runs on the page. Sits idle and does nothing until the
 * background service worker sends { type: "CAPTURE_CONTEXT" }.
 *
 * On request, it grabs a small, useful snapshot of what the user
 * was working on (title, url, selection, visible text, focused
 * field) and sends it back via sendResponse.
 *
 * No AI calls, no storage, no external requests, no continuous
 * monitoring — purely reactive to one message type.
 * -------------------------------------------------------------
 */

const MAX_VISIBLE_TEXT_LENGTH = 4000;
const MAX_INPUT_TEXT_LENGTH = 1000;

// Prefer actual page/article content before generic page containers.
const CONTENT_SELECTORS = [
  '#mw-content-text .mw-parser-output',
  '#bodyContent',
  'article',
  'main article',
  '[role="main"] article',
  'main',
  '[role="main"]'
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

    if (sensitiveAutocomplete.some((key) => autocomplete.includes(key))) {
      return true;
    }

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

    return sensitiveKeywords.some((key) => hints.includes(key));
  } catch (error) {
    return true;
  }
}

function getSelectedText() {
  try {
    const selection = window.getSelection ? window.getSelection() : null;
    return selection ? selection.toString().trim() : '';
  } catch (error) {
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

      if (candidate) {
        text = candidate;
        break;
      }
    }

    if (!text) {
      text = (document.body.innerText || document.body.textContent || '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    return text.length > MAX_VISIBLE_TEXT_LENGTH
      ? text.slice(0, MAX_VISIBLE_TEXT_LENGTH) + '…'
      : text;
  } catch (error) {
    return '';
  }
}

function describeElement(el) {
  try {
    if (!el || el === document.body || !el.tagName) return null;

    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : '';
    const classes = (typeof el.className === 'string' && el.className.trim())
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
      : '';

    return `${tag}${id}${classes}`;
  } catch (error) {
    return null;
  }
}

function getInputContext(el) {
  try {
    if (!el || !el.tagName) return null;

    const tag = el.tagName.toLowerCase();
    const isEditable = el.isContentEditable === true;

    if (tag !== 'input' && tag !== 'textarea' && !isEditable) return null;
    if (isSensitiveField(el)) return null;

    let text = '';

    if (tag === 'input' || tag === 'textarea') {
      text = el.value || '';
    } else {
      text = el.innerText || el.textContent || '';
    }

    text = text.trim();

    if (!text) return '';

    return text.length > MAX_INPUT_TEXT_LENGTH
      ? text.slice(0, MAX_INPUT_TEXT_LENGTH) + '…'
      : text;
  } catch (error) {
    return null;
  }
}

function captureContext() {
  const context = {
    title: '',
    url: '',
    selectedText: '',
    visibleText: '',
    focusedElement: null,
    inputContext: null
  };

  try { context.title = document.title || ''; } catch (error) {}
  try { context.url = window.location.href || ''; } catch (error) {}
  try { context.selectedText = getSelectedText(); } catch (error) {}
  try { context.visibleText = getVisibleText(); } catch (error) {}

  let activeEl = null;

  try { activeEl = document.activeElement; } catch (error) {}
  try { context.focusedElement = describeElement(activeEl); } catch (error) {}
  try { context.inputContext = getInputContext(activeEl); } catch (error) {}

  return context;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'CAPTURE_CONTEXT') {
    return false;
  }

  try {
    const context = captureContext();
    console.log('[Flowback] Context captured', context);
    sendResponse(context);
  } catch (error) {
    console.log('[Flowback] Failed to capture context:', error && error.message);

    sendResponse({
      title: '',
      url: '',
      selectedText: '',
      visibleText: '',
      focusedElement: null,
      inputContext: null,
      error: 'capture_failed'
    });
  }

  return false;
});

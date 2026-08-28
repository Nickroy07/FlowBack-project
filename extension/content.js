
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

// ---- Sensitive-field detection (never capture these) ----

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
    if (sensitiveAutocomplete.some((k) => autocomplete.includes(k))) return true;

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

    return sensitiveKeywords.some((k) => hints.includes(k));
  } catch (e) {
    // If we can't tell, err on the side of caution.
    return true;
  }
}

// ---- Individual capture helpers (each fails safe, never throws upward) ----

function getSelectedText() {
  try {
    const selection = window.getSelection ? window.getSelection() : null;
    return selection ? selection.toString().trim() : '';
  } catch (e) {
    return '';
  }
}

function getVisibleText() {
  try {
    if (!document.body) return '';

    // Prefer the main content area over nav/header/footer noise, when present.
    const container =
      document.querySelector('main') ||
      document.querySelector('article') ||
      document.querySelector('[role="main"]') ||
      document.body;

    let text = container.innerText || container.textContent || '';
    text = text.replace(/\s+/g, ' ').trim();

    return text.length > MAX_VISIBLE_TEXT_LENGTH
      ? text.slice(0, MAX_VISIBLE_TEXT_LENGTH) + '…'
      : text;
  } catch (e) {
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
  } catch (e) {
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
  } catch (e) {
    return null;
  }
}

// ---- Main capture ----

function captureContext() {
  const context = {
    title: '',
    url: '',
    selectedText: '',
    visibleText: '',
    focusedElement: null,
    inputContext: null
  };

  try { context.title = document.title || ''; } catch (e) {}
  try { context.url = window.location.href || ''; } catch (e) {}
  try { context.selectedText = getSelectedText(); } catch (e) {}
  try { context.visibleText = getVisibleText(); } catch (e) {}

  let activeEl = null;
  try { activeEl = document.activeElement; } catch (e) {}

  try { context.focusedElement = describeElement(activeEl); } catch (e) {}
  try { context.inputContext = getInputContext(activeEl); } catch (e) {}

  return context;
}

// ---- Message listener ----

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'CAPTURE_CONTEXT') {
    return false; // not for us, don't keep the channel open
  }

  try {
    const context = captureContext();
    console.log('[Flowback] Context captured', context);
    sendResponse(context);
  } catch (e) {
    console.log('[Flowback] Failed to capture context:', e && e.message);
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

  // Everything above is synchronous, so sendResponse has already fired.
  // No need to `return true` (that's only for async responses).
  return false;
});

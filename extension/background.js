// Flowback — background.js
// Manifest V3 service worker: interruption detection engine.
//
// Design principle: the service worker can be suspended and restarted
// at ANY time (Chrome does this aggressively to save memory). So this
// file treats chrome.storage.session as the single source of truth,
// never in-memory variables or setTimeout(), for anything that has to
// survive across an "away" period.
//
// chrome.storage.session is memory-backed (never written to disk) and
// is cleared automatically when the browser closes — so it satisfies
// "no permanent browsing history" while still surviving service worker
// suspend/restart within the same browser session.
//
// Required manifest.json permissions: "storage", "tabs".
// ("tabs" is needed so chrome.tabs.get() can read tab.url, which is
// used only to filter out devtools/chrome-internal pages.)

const LOG_PREFIX = '[Flowback]';
const INTERRUPTION_THRESHOLD_MS = 10 * 1000; // 10 seconds
const STORAGE_KEY = 'flowbackState';

// Pages we never want to treat as "the working tab" or count as a
// genuine leave/return (devtools, internal chrome pages, etc.).
const IGNORED_URL_PREFIXES = [
  'chrome://',
  'chrome-extension://',
  'devtools://',
  'edge://',
  'about:'
];

// In-memory cache of state, ONLY used to avoid redundant storage reads
// within a single still-alive service worker instance. It is never
// trusted as the source of truth — loadState() always falls back to
// chrome.storage.session, which is what actually survives suspension.
let cachedState = null;

function defaultState() {
  return {
    workingTabId: null,      // the tab we consider "work"
    workingWindowId: null,   // the window that tab lives in
    currentTabId: null,      // last tab we know is active anywhere
    currentWindowId: null,   // last window we know is focused
    awayTimestamp: null,     // Date.now() when we first left the working tab
    interruptionPending: false
  };
}

async function loadState() {
  if (cachedState) return cachedState;
  const result = await chrome.storage.session.get(STORAGE_KEY);
  cachedState = result[STORAGE_KEY] || defaultState();
  return cachedState;
}

// Mutates the shared state object, persists it, and keeps the
// in-memory cache pointed at the same object.
async function saveState(partial) {
  const state = await loadState();
  Object.assign(state, partial);
  cachedState = state;
  await chrome.storage.session.set({ [STORAGE_KEY]: state });
  return state;
}

async function resetInterruptionState() {
  return saveState({ awayTimestamp: null, interruptionPending: false });
}

// Returns true if the tab is a devtools/internal page we should
// ignore for leave/return purposes. Fails "open" (returns false) if
// we can't read the URL, so we never accidentally swallow a real event.
async function isIgnorableTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || !tab.url) return false;
    return IGNORED_URL_PREFIXES.some((prefix) => tab.url.startsWith(prefix));
  } catch (err) {
    return false; // tab gone, or no permission to read url — don't ignore
  }
}

async function setWorkingTab(tabId, windowId) {
  await saveState({
    workingTabId: tabId,
    workingWindowId: windowId,
    currentTabId: tabId,
    currentWindowId: windowId,
    awayTimestamp: null,
    interruptionPending: false
  });
  console.log(`${LOG_PREFIX} Working context started (tab ${tabId}, window ${windowId})`);
}

// Records the FIRST moment we left the working tab. If we're already
// away (interruptionPending), this is a no-op — the original
// awayTimestamp is preserved even if the user bounces through several
// other tabs before finally returning.
async function handleLeave(state, reason) {
  if (state.interruptionPending) return;

  await saveState({
    awayTimestamp: Date.now(),
    interruptionPending: true
  });
  console.log(`${LOG_PREFIX} Context left (${reason})`);
  console.log(`${LOG_PREFIX} Waiting for return`);
}

// Called when we detect the user is back on the working tab/window.
// Timestamps, not timers, decide the outcome.
async function handleReturn(state) {
  if (!state.interruptionPending || state.awayTimestamp === null) return;

  const durationMs = Date.now() - state.awayTimestamp;
  const durationSec = (durationMs / 1000).toFixed(1);

  console.log(`${LOG_PREFIX} User returned`);
  console.log(`${LOG_PREFIX} Interruption duration: ${durationSec} seconds`);

  if (durationMs >= INTERRUPTION_THRESHOLD_MS) {
    console.log(`${LOG_PREFIX} Confirmed interruption`);
    console.log(`${LOG_PREFIX} Requesting context capture`);
    requestContextCapture(state.workingTabId, durationSec);
  } else {
    console.log(`${LOG_PREFIX} Normal navigation (${durationSec}s < 10s threshold)`);
  }

  await resetInterruptionState();
}

// Stub only — actual capture / Resume Card logic is out of scope for
// this MVP. Wire this up to whatever downstream module needs it.
function requestContextCapture(tabId, durationSec) {
  console.log(`${LOG_PREFIX} [stub] would capture context for tab ${tabId} after ${durationSec}s`);
}

// --- Bootstrap ------------------------------------------------------
// Establish an initial working tab on browser startup / extension
// install so we're not waiting on the user's first tab switch.
async function bootstrapFromCurrentTab() {
  const state = await loadState();
  if (state.workingTabId !== null) return; // already tracking something

  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab && !(tab.url && IGNORED_URL_PREFIXES.some((p) => tab.url.startsWith(p)))) {
      await setWorkingTab(tab.id, tab.windowId);
    }
  } catch (err) {
    console.log(`${LOG_PREFIX} Could not bootstrap working tab:`, err);
  }
}

chrome.runtime.onStartup.addListener(bootstrapFromCurrentTab);
chrome.runtime.onInstalled.addListener(bootstrapFromCurrentTab);

// --- Tab switches within Chrome --------------------------------------

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const { tabId, windowId } = activeInfo;

  if (await isIgnorableTab(tabId)) {
    console.log(`${LOG_PREFIX} Ignoring devtools/internal tab activation (${tabId})`);
    return;
  }

  const state = await loadState();

  // No working tab tracked yet at all — bootstrap on this one.
  if (state.workingTabId === null) {
    await setWorkingTab(tabId, windowId);
    return;
  }

  if (tabId === state.workingTabId) {
    // Back on the original working tab.
    if (state.interruptionPending) {
      await handleReturn(state);
    }
    await saveState({ currentTabId: tabId, currentWindowId: windowId });
    return;
  }

  // Activated some other tab — we've left the working tab.
  await handleLeave(state, 'switched tab');
  await saveState({ currentTabId: tabId, currentWindowId: windowId });
});

// --- Cross-window / cross-application focus changes -------------------

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  const state = await loadState();
  if (state.workingTabId === null) return; // nothing tracked yet

  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    // Chrome itself lost OS-level focus (user switched to another app).
    if (state.currentTabId === state.workingTabId) {
      await handleLeave(state, 'switched application');
    }
    return;
  }

  if (windowId === state.workingWindowId && state.currentTabId === state.workingTabId) {
    // Chrome regained focus and the working tab is still the active
    // tab in that window — onActivated won't fire in this case since
    // the active tab never changed, so the return check has to happen
    // here instead.
    if (state.interruptionPending) {
      await handleReturn(state);
    }
    return;
  }

  // Focus moved to a different Chrome window than the working one.
  if (state.currentTabId === state.workingTabId) {
    await handleLeave(state, 'switched window');
  }
});

// --- Working tab closed -----------------------------------------------

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await loadState();
  if (tabId === state.workingTabId) {
    console.log(`${LOG_PREFIX} Previous working tab closed`);
    await saveState(defaultState());
  }
});


/**
 * Flowback — background.js
 * -------------------------------------------------------------
 * Manifest V3 service worker.
 *
 * MVP goal: detect when the user leaves their current "working
 * context" (active tab) and, if they stay away 10+ seconds,
 * treat their return as an interruption — then ask that tab's
 * content script to capture what was being worked on.
 *
 * No AI calls, no Firebase, no persistent storage, no UI here.
 * Just interruption detection.
 * -------------------------------------------------------------
 */

const INTERRUPTION_THRESHOLD_MS = 10 * 1000; // 10 seconds

// ---- In-memory state (cleared whenever the service worker restarts) ----

// The tab we consider the user's current "working context".
let workingContext = null; // { tabId, windowId, url, title, timestamp }

// Snapshot of workingContext at the moment the user left it.
// Non-null while we're waiting to see whether this is a real interruption.
let leftContext = null;

// When the user left leftContext (ms since epoch).
let awayTimestamp = null;

// setTimeout handle for the 10s threshold check.
let interruptionTimerId = null;

// Becomes true once the user has been away 10+ seconds.
let isPossibleInterruption = false;

// ---- Helpers ----

function snapshotTab(tab) {
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    url: tab.url || null,
    title: tab.title || null,
    timestamp: Date.now()
  };
}

function startWorkingContext(tab) {
  clearPendingInterruption();
  workingContext = snapshotTab(tab);
  console.log("[Flowback] Working context started", workingContext);
}

function clearPendingInterruption() {
  if (interruptionTimerId !== null) {
    clearTimeout(interruptionTimerId);
    interruptionTimerId = null;
  }
  leftContext = null;
  awayTimestamp = null;
  isPossibleInterruption = false;
}

function handleLeave() {
  if (!workingContext || leftContext) return; // nothing to leave, or already tracking a leave

  leftContext = workingContext;
  awayTimestamp = Date.now();
  isPossibleInterruption = false;

  console.log("[Flowback] Context left", leftContext);

  interruptionTimerId = setTimeout(() => {
    isPossibleInterruption = true;
    interruptionTimerId = null;
    console.log("[Flowback] Possible interruption");
  }, INTERRUPTION_THRESHOLD_MS);
}

function handleReturn(tab) {
  if (!leftContext) {
    startWorkingContext(tab);
    return;
  }

  const returningContext = leftContext;
  const awayDuration = Date.now() - awayTimestamp;
  const wasRealInterruption = isPossibleInterruption || awayDuration >= INTERRUPTION_THRESHOLD_MS;

  clearPendingInterruption(); // clear before async work, avoids duplicate handling

  if (!wasRealInterruption) {
    console.log("[Flowback] Returned quickly — treating as normal navigation, not an interruption");
    startWorkingContext(tab);
    return;
  }

  console.log("[Flowback] User returned");
  console.log(`[Flowback] Interruption duration: ${Math.round(awayDuration / 1000)} seconds`);

  requestContextCapture(returningContext.tabId);

  startWorkingContext(tab);
}

function requestContextCapture(tabId) {
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab) {
      console.log("[Flowback] Previous tab no longer exists, skipping context capture");
      return;
    }

    console.log("[Flowback] Requesting context capture");

    chrome.tabs.sendMessage(tabId, { type: "CAPTURE_CONTEXT" }, () => {
      if (chrome.runtime.lastError) {
        // Content script may not be injected on this page (chrome://, web store, etc.)
        console.log("[Flowback] Could not reach content script:", chrome.runtime.lastError.message);
      }
    });
  });
}

function initializeWorkingContext() {
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    if (chrome.runtime.lastError || !tabs || tabs.length === 0) return;
    startWorkingContext(tabs[0]);
  });
}

// ---- Event listeners ----

chrome.runtime.onInstalled.addListener(initializeWorkingContext);
chrome.runtime.onStartup.addListener(initializeWorkingContext);
initializeWorkingContext(); // covers the service worker waking back up mid-session

chrome.tabs.onActivated.addListener((activeInfo) => {
  const { tabId } = activeInfo;

  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab) return; // tab closed already, ignore

    if (!workingContext) {
      startWorkingContext(tab);
      return;
    }

    if (tabId === workingContext.tabId) {
      // Re-activation of the tab we already consider "current" — no-op.
      return;
    }

    if (leftContext && tabId === leftContext.tabId) {
      handleReturn(tab);
      return;
    }

    if (!leftContext) {
      handleLeave();
      return;
    }

    // Already away, and the user hopped to a third tab — keep waiting
    // for them to come back to the original working context.
  });
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    // Chrome lost OS focus entirely (user switched to another app).
    if (workingContext && !leftContext) {
      handleLeave();
    }
    return;
  }

  chrome.tabs.query({ active: true, windowId }, (tabs) => {
    if (chrome.runtime.lastError || !tabs || tabs.length === 0) return;
    const tab = tabs[0];

    if (!workingContext) {
      startWorkingContext(tab);
      return;
    }

    if (leftContext && tab.id === leftContext.tabId) {
      handleReturn(tab);
      return;
    }

    if (!leftContext && tab.id !== workingContext.tabId) {
      startWorkingContext(tab);
    }
    // else: same tab as before, or still away on a different tab — nothing to do.
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (workingContext && workingContext.tabId === tabId) {
    console.log("[Flowback] Working tab closed, clearing context");
    workingContext = null;
  }

  if (leftContext && leftContext.tabId === tabId) {
    console.log("[Flowback] Previous working tab closed, cancelling interruption tracking");
    clearPendingInterruption();
  }
});

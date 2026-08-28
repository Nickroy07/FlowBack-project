// Flowback — background.js
// MV3 service worker: robust interruption detection + reliable capsule storage
// Core works WITHOUT AI - AI is optional enhancement
// Design: storage.session for ephemeral state (survives SW suspend), storage.local for capsule (persisted)

const LOG_PREFIX = '[Flowback]';
const INTERRUPTION_THRESHOLD_MS = 10 * 1000;
const STORAGE_KEY = 'flowbackState';
const CAPSULE_STORAGE_KEY = 'activeCapsule';
const CAPSULE_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24h expiry

const IGNORED_URL_PREFIXES = [
  'chrome://',
  'chrome-extension://',
  'devtools://',
  'edge://',
  'about:',
  'chrome-search://'
];

const BACKEND_URL = 'http://localhost:3000/api/reconstruct';
const AI_REQUEST_TIMEOUT_MS = 8000;

const FALLBACK_AI = {
  task: "Captured context available",
  tried: "AI reconstruction unavailable",
  next: "Resume from your captured context"
};

const AI_LIMITS = {
  title: 500,
  url: 2000,
  selectedText: 1500,
  visibleText: 3500,
  focusedElement: 300,
  inputContext: 1500
};

let cachedState = null;

function defaultState() {
  return {
    workingTabId: null,
    workingWindowId: null,
    currentTabId: null,
    currentWindowId: null,
    awayTimestamp: null,
    interruptionPending: false,
    lastActiveAt: Date.now()
  };
}

async function loadState() {
  if (cachedState) return cachedState;
  try {
    const result = await chrome.storage.session.get(STORAGE_KEY);
    cachedState = result[STORAGE_KEY] || defaultState();
  } catch {
    cachedState = defaultState();
  }
  return cachedState;
}

async function saveState(partial) {
  const state = await loadState();
  Object.assign(state, partial);
  cachedState = state;
  try {
    await chrome.storage.session.set({ [STORAGE_KEY]: state });
  } catch (e) {
    console.warn(`${LOG_PREFIX} Failed to save session state:`, e.message);
  }
  return state;
}

async function resetInterruptionState() {
  return saveState({ awayTimestamp: null, interruptionPending: false });
}

async function isIgnorableTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || !tab.url) return false;
    return IGNORED_URL_PREFIXES.some(prefix => tab.url.startsWith(prefix));
  } catch {
    return true; // If can't get tab, treat as ignorable to be safe
  }
}

async function isIgnorableUrl(url) {
  if (!url || typeof url !== 'string') return true;
  return IGNORED_URL_PREFIXES.some(prefix => url.startsWith(prefix));
}

async function setWorkingTab(tabId, windowId) {
  await saveState({
    workingTabId: tabId,
    workingWindowId: windowId,
    currentTabId: tabId,
    currentWindowId: windowId,
    awayTimestamp: null,
    interruptionPending: false,
    lastActiveAt: Date.now()
  });
  console.log(`${LOG_PREFIX} Working context: tab ${tabId}, window ${windowId}`);
}

async function handleLeave(state, reason) {
  if (state.interruptionPending) return;
  await saveState({
    awayTimestamp: Date.now(),
    interruptionPending: true
  });
  console.log(`${LOG_PREFIX} Left working context (${reason}), waiting for return`);
}

async function handleReturn(state) {
  if (!state.interruptionPending || state.awayTimestamp === null) return;

  const durationMs = Date.now() - state.awayTimestamp;
  const durationSec = (durationMs / 1000).toFixed(1);

  console.log(`${LOG_PREFIX} Returned after ${durationSec}s`);

  if (durationMs >= INTERRUPTION_THRESHOLD_MS) {
    console.log(`${LOG_PREFIX} Interruption confirmed (${durationSec}s >= 10s)`);
    requestContextCapture(state.workingTabId, durationMs);
  } else {
    console.log(`${LOG_PREFIX} Short navigation (${durationSec}s < 10s), no capture`);
  }

  await resetInterruptionState();
}

// --- Capsule helpers ---

function generateCapsuleId() {
  return `capsule_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function sanitizeUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return rawUrl || '';
  }
}

function isValidContext(context) {
  return context && typeof context === 'object';
}

function truncateForAI(text, maxLength) {
  if (typeof text !== 'string') return '';
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return trimmed.slice(0, maxLength).trimEnd();
}

function buildAIPayload(context) {
  return {
    title: truncateForAI(context.title || '', AI_LIMITS.title),
    url: truncateForAI(context.url || '', AI_LIMITS.url),
    selectedText: truncateForAI(context.selectedText || '', AI_LIMITS.selectedText),
    visibleText: truncateForAI(context.visibleText || '', AI_LIMITS.visibleText),
    focusedElement: truncateForAI(context.focusedElement || '', AI_LIMITS.focusedElement),
    inputContext: truncateForAI(context.inputContext || '', AI_LIMITS.inputContext)
  };
}

function isValidAIResponse(ai) {
  return ai && typeof ai === 'object' &&
    typeof ai.task === 'string' && ai.task.trim() &&
    typeof ai.tried === 'string' && ai.tried.trim() &&
    typeof ai.next === 'string' && ai.next.trim();
}

function deterministicReconstruct(context) {
  const title = (context.title || '').trim();
  const url = (context.url || '').trim();
  const selected = (context.selectedText || '').trim();
  const visible = (context.visibleText || '').trim();
  const input = (context.inputContext || '').trim();

  let task = "Working on webpage";
  if (selected && selected.length > 5) {
    task = selected.slice(0, 80).replace(/\s+/g, ' ').trim();
    if (task.length < 15 && title) task = title.slice(0, 70);
  } else if (title) {
    task = title.split(' - ')[0].split(' | ')[0].trim().slice(0, 80) || "Browsing webpage";
  } else if (url) {
    try {
      const domain = new URL(url).hostname.replace('www.', '');
      task = `Browsing ${domain}`;
    } catch {
      task = "Browsing webpage";
    }
  }

  let tried = "Reviewed page content";
  if (input) {
    tried = `Typed: "${input.slice(0, 70).replace(/\s+/g, ' ')}"`;
  } else if (selected) {
    tried = `Selected text and reviewed content`;
  } else if (visible) {
    tried = `Reviewed page content`;
  }

  let next = "Resume where you left off";
  if (input) next = "Continue typing";
  else if (selected) next = "Continue with selected content";
  else if (title?.toLowerCase().includes('stackoverflow')) next = "Continue debugging";
  else if (title?.toLowerCase().includes('github')) next = "Continue coding";

  const limitWords = (str, max = 18) => {
    const words = str.trim().split(/\s+/);
    return words.length <= max ? str : words.slice(0, max).join(' ') + '…';
  };

  return {
    task: limitWords(task, 20),
    tried: limitWords(tried, 20),
    next: limitWords(next, 20)
  };
}

async function fetchAIReconstruction(context) {
  const payload = buildAIPayload(context);
  const hasContent = Object.values(payload).some(v => v && v.length > 0);
  
  if (!hasContent) {
    console.log(`${LOG_PREFIX} Empty context, using deterministic`);
    return deterministicReconstruct(context);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS);

  try {
    console.log(`${LOG_PREFIX} Trying AI backend ${BACKEND_URL}`);
    const response = await fetch(BACKEND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      try {
        const errorData = await response.json();
        // Backend always returns task/tried/next even on error now (200 with fallback)
        if (isValidAIResponse(errorData)) {
          console.log(`${LOG_PREFIX} Backend returned valid reconstruction (status ${response.status})`);
          return errorData;
        }
        if (errorData.fallback && isValidAIResponse(errorData.fallback)) {
          return errorData.fallback;
        }
      } catch {}
      console.warn(`${LOG_PREFIX} Backend error ${response.status}, using deterministic`);
      return deterministicReconstruct(context);
    }

    const data = await response.json();
    if (isValidAIResponse(data)) {
      console.log(`${LOG_PREFIX} AI reconstruction received`);
      return data;
    }
    if (data.fallback && isValidAIResponse(data.fallback)) {
      return data.fallback;
    }
    
    console.warn(`${LOG_PREFIX} Invalid AI response, using deterministic`);
    return deterministicReconstruct(context);

  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      console.warn(`${LOG_PREFIX} AI timeout, using deterministic`);
    } else {
      console.warn(`${LOG_PREFIX} AI failed (${err.message}), using deterministic`);
    }
    return deterministicReconstruct(context);
  }
}

function saveActiveCapsule(capsule) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [CAPSULE_STORAGE_KEY]: capsule }, () => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve();
      }
    });
  });
}

async function getTabInfo(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return {
      title: tab.title || '',
      url: tab.url || '',
      windowId: tab.windowId || null
    };
  } catch {
    return null;
  }
}

async function handleCapturedContext(context, tabId, durationMs) {
  if (!isValidContext(context)) {
    console.warn(`${LOG_PREFIX} Invalid context, trying fallback from tab info`);
    const tabInfo = await getTabInfo(tabId);
    if (!tabInfo) {
      console.warn(`${LOG_PREFIX} No tab info, skipping save`);
      return;
    }
    context = {
      title: tabInfo.title,
      url: tabInfo.url,
      selectedText: '',
      visibleText: '',
      focusedElement: '',
      inputContext: ''
    };
  }

  const now = Date.now();
  const tabInfo = await getTabInfo(tabId);

  // Build deterministic task/tried/next immediately (core works without AI)
  const deterministic = deterministicReconstruct(context);

  const capsule = {
    id: generateCapsuleId(),
    tabId: tabId,
    windowId: tabInfo?.windowId || null,
    url: sanitizeUrl(context.url || tabInfo?.url || ''),
    title: (context.title || tabInfo?.title || '').slice(0, 500),
    capturedAt: now,
    lastActiveAt: now - durationMs,
    interruptedAt: now - durationMs,
    durationAway: durationMs,
    visibleText: (context.visibleText || '').slice(0, 4000),
    selectedText: (context.selectedText || '').slice(0, 1500),
    focusedElement: (context.focusedElement || '').slice(0, 300),
    inputContext: (context.inputContext || '').slice(0, 1500),
    // Deterministic core fields - always present
    task: deterministic.task,
    tried: deterministic.tried,
    next: deterministic.next,
    source: 'content-script',
    status: 'captured',
    // AI optional
    ai: null
  };

  try {
    // Save immediately with deterministic values - core flow works without AI
    await saveActiveCapsule(capsule);
    console.log(`${LOG_PREFIX} Capsule saved (deterministic) ID: ${capsule.id}, task: ${capsule.task}`);

    // Try AI enhancement in background - optional, non-blocking for core
    const aiResult = await fetchAIReconstruction(context);
    
    if (aiResult && isValidAIResponse(aiResult)) {
      const isDifferent = aiResult.task !== deterministic.task || aiResult.tried !== deterministic.tried;
      const enriched = {
        ...capsule,
        task: aiResult.task,
        tried: aiResult.tried,
        next: aiResult.next,
        ai: {
          task: aiResult.task,
          tried: aiResult.tried,
          next: aiResult.next
        },
        source: isDifferent ? 'ai' : 'deterministic',
        status: 'enriched'
      };
      await saveActiveCapsule(enriched);
      console.log(`${LOG_PREFIX} Capsule enriched with AI: ${aiResult.task}`);
    } else {
      // Even without AI, ensure ai field has fallback for UI compatibility
      const withFallback = {
        ...capsule,
        ai: { ...FALLBACK_AI, task: capsule.task, tried: capsule.tried, next: capsule.next }
      };
      await saveActiveCapsule(withFallback);
      console.log(`${LOG_PREFIX} Capsule finalised with deterministic (AI unavailable)`);
    }

  } catch (err) {
    console.error(`${LOG_PREFIX} Failed to save capsule:`, err);
  }
}

function requestContextCapture(tabId, durationMs) {
  console.log(`${LOG_PREFIX} Requesting capture for tab ${tabId} after ${durationMs}ms`);

  chrome.tabs.sendMessage(tabId, { type: 'CAPTURE_CONTEXT' }, async (response) => {
    if (chrome.runtime.lastError) {
      console.warn(`${LOG_PREFIX} Content script not reachable (${chrome.runtime.lastError.message}), using tab info fallback`);
      // Fallback: capture from tab info directly
      const tabInfo = await getTabInfo(tabId);
      if (tabInfo && !await isIgnorableUrl(tabInfo.url)) {
        handleCapturedContext({
          title: tabInfo.title,
          url: tabInfo.url,
          selectedText: '',
          visibleText: '',
          focusedElement: '',
          inputContext: ''
        }, tabId, durationMs);
      } else {
        console.warn(`${LOG_PREFIX} Tab info not available or ignorable, skipping`);
      }
      return;
    }

    if (!response) {
      console.warn(`${LOG_PREFIX} No context from content script, using fallback`);
      const tabInfo = await getTabInfo(tabId);
      if (tabInfo) {
        handleCapturedContext({
          title: tabInfo.title,
          url: tabInfo.url,
          selectedText: '',
          visibleText: '',
          focusedElement: '',
          inputContext: ''
        }, tabId, durationMs);
      }
      return;
    }

    console.log(`${LOG_PREFIX} Context received from content script`);
    handleCapturedContext(response, tabId, durationMs);
  });
}

// --- Bootstrap ---

async function bootstrapFromCurrentTab() {
  const state = await loadState();
  if (state.workingTabId !== null) return;

  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab && !await isIgnorableUrl(tab.url)) {
      await setWorkingTab(tab.id, tab.windowId);
    }
  } catch (err) {
    console.log(`${LOG_PREFIX} Bootstrap failed:`, err.message);
  }
}

chrome.runtime.onStartup.addListener(bootstrapFromCurrentTab);
chrome.runtime.onInstalled.addListener(bootstrapFromCurrentTab);

// --- Event handlers ---

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const { tabId, windowId } = activeInfo;

  if (await isIgnorableTab(tabId)) {
    console.log(`${LOG_PREFIX} Ignoring internal tab ${tabId}`);
    return;
  }

  const state = await loadState();

  if (state.workingTabId === null) {
    await setWorkingTab(tabId, windowId);
    return;
  }

  if (tabId === state.workingTabId) {
    if (state.interruptionPending) {
      await handleReturn(state);
    }
    await saveState({ currentTabId: tabId, currentWindowId: windowId, lastActiveAt: Date.now() });
    return;
  }

  await handleLeave(state, 'switched tab');
  await saveState({ currentTabId: tabId, currentWindowId: windowId, lastActiveAt: Date.now() });
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  const state = await loadState();
  if (state.workingTabId === null) return;

  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    if (state.currentTabId === state.workingTabId) {
      await handleLeave(state, 'switched application');
    }
    return;
  }

  if (windowId === state.workingWindowId && state.currentTabId === state.workingTabId) {
    if (state.interruptionPending) {
      await handleReturn(state);
    }
    await saveState({ currentWindowId: windowId, lastActiveAt: Date.now() });
    return;
  }

  if (state.currentTabId === state.workingTabId) {
    await handleLeave(state, 'switched window');
  }
  await saveState({ currentWindowId: windowId });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await loadState();
  if (tabId === state.workingTabId) {
    console.log(`${LOG_PREFIX} Working tab closed, resetting`);
    await saveState(defaultState());
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tabId) {
    const state = await loadState();
    if (state.workingTabId === tabId) {
      await saveState({ lastActiveAt: Date.now() });
    }
  }
});

// Cleanup expired capsules on startup
(async () => {
  try {
    const result = await chrome.storage.local.get(CAPSULE_STORAGE_KEY);
    const capsule = result[CAPSULE_STORAGE_KEY];
    if (capsule && capsule.capturedAt && (Date.now() - capsule.capturedAt > CAPSULE_EXPIRY_MS)) {
      console.log(`${LOG_PREFIX} Clearing expired capsule`);
      await chrome.storage.local.remove(CAPSULE_STORAGE_KEY);
    }
  } catch {}
})();

console.log(`${LOG_PREFIX} Service worker started, threshold ${INTERRUPTION_THRESHOLD_MS}ms`);

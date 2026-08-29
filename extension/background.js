// Flowback — background.js
// Work Session Timeline Engine & Robust Context Recovery
// Observes high-level tab switches, captures leave-time context & scroll positions,
// detects interruptions (>= 10s away), creates deterministic & AI-enriched recovery capsules.

const LOG_PREFIX = '[Flowback]';
const INTERRUPTION_THRESHOLD_MS = 10 * 1000; // 10 seconds
const SESSION_STATE_KEY = 'flowbackSessionState';
const CAPSULE_STORAGE_KEY = 'activeCapsule';
const CAPSULE_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_TIMELINE_EVENTS = 50;

const IGNORED_URL_PREFIXES = [
  'chrome://',
  'chrome-extension://',
  'devtools://',
  'edge://',
  'about:',
  'chrome-search://',
  'view-source:'
];

const BACKEND_URL = 'http://localhost:3000/api/reconstruct';
const AI_REQUEST_TIMEOUT_MS = 8000;

const SENSITIVE_QUERY_PARAMS = [
  'token', 'auth', 'access_token', 'id_token', 'refresh_token',
  'api_key', 'apikey', 'key', 'secret', 'password', 'pwd',
  'session_id', 'sessionid', 'bearer'
];

let cachedSessionState = null;

function defaultSessionState() {
  return {
    currentTabId: null,
    currentWindowId: null,
    currentUrl: '',
    currentTitle: '',
    currentTabActivatedAt: Date.now(),
    lastWorkingTabId: null,
    lastWorkingUrl: '',
    lastWorkingTitle: '',
    awayTimestamp: null,
    interruptionPending: false,
    interruptionReason: null,
    timeline: [],
    tabSnapshots: {}
  };
}

async function loadSessionState() {
  if (cachedSessionState) return cachedSessionState;
  try {
    const result = await chrome.storage.session.get(SESSION_STATE_KEY);
    cachedSessionState = result[SESSION_STATE_KEY] || defaultSessionState();
    if (!cachedSessionState.tabSnapshots) cachedSessionState.tabSnapshots = {};
    if (!Array.isArray(cachedSessionState.timeline)) cachedSessionState.timeline = [];
  } catch {
    cachedSessionState = defaultSessionState();
  }
  return cachedSessionState;
}

async function saveSessionState(partial) {
  const state = await loadSessionState();
  Object.assign(state, partial);
  cachedSessionState = state;
  try {
    await chrome.storage.session.set({ [SESSION_STATE_KEY]: state });
  } catch (e) {
    console.warn(`${LOG_PREFIX} Failed to save session state:`, e.message);
  }
  return state;
}

function sanitizeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  try {
    const parsed = new URL(rawUrl);
    for (const param of Array.from(parsed.searchParams.keys())) {
      if (SENSITIVE_QUERY_PARAMS.includes(param.toLowerCase())) {
        parsed.searchParams.delete(param);
      }
    }
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return rawUrl.slice(0, 2000);
  }
}

function cleanPageTitle(rawTitle, domain = '', url = '') {
  if (!rawTitle || typeof rawTitle !== 'string') {
    if (domain) return domain;
    return 'Working context';
  }
  let title = rawTitle.trim();

  // Strip notification badges & internal counters (e.g., (9), [12], (99+), {2}, (1 unread))
  title = title.replace(/^[\(\[\{]\s*\d+\+?(?:\s+[a-zA-Z]+)?\s*[\)\]\}]\s*[-–—·•:|]?\s*/i, '');
  
  // Strip trailing application suffixes e.g. " - Google Chrome", " · GitHub", " | Slack", " - Google Search", " - Inbox"
  title = title.replace(/\s*[-–—·•|:]\s*(?:Inbox|Google Search|Google Chrome|GitHub|Slack|YouTube|Figma|Notion|Linear|Reddit|Twitter|X|ChatGPT|Claude|Arena|Gmail|Outlook|WhatsApp|Discord)$/i, '');

  // Strip leading prefixes e.g. "Inbox - "
  title = title.replace(/^(?:Inbox|Gmail|Mail)\s*[-–—·•:|]\s*/i, '');

  title = title.trim();

  // If title was stripped completely or is empty or generic
  if (!title || title.toLowerCase() === 'untitled' || title.toLowerCase() === 'new tab' || title.toLowerCase() === 'home') {
    if (url) {
      try {
        const parsed = new URL(url);
        const pathSegments = parsed.pathname.split('/').filter(Boolean);
        if (pathSegments.length > 0) {
          const lastSeg = decodeURIComponent(pathSegments[pathSegments.length - 1]).replace(/[-_]/g, ' ');
          if (lastSeg.length > 2) {
            return `${domain || parsed.hostname}: ${lastSeg}`;
          }
        }
      } catch {}
    }
    return domain || 'Webpage';
  }

  return title;
}

function getDomain(url) {
  if (!url || typeof url !== 'string') return 'Webpage';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'Webpage';
  }
}

function formatDuration(ms) {
  if (!ms || typeof ms !== 'number' || ms < 0) return 'Duration unavailable';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 5) return '< 5s';
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function generateCapsuleId() {
  return `capsule_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function isIgnorableUrl(url) {
  if (!url || typeof url !== 'string') return true;
  return IGNORED_URL_PREFIXES.some(prefix => url.startsWith(prefix));
}

async function isIgnorableTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || !tab.url) return false;
    return isIgnorableUrl(tab.url);
  } catch {
    return true;
  }
}

/**
 * Filter rapid bounces (< 1500ms) and aggregate tab timeline into meaningful journey steps
 */
function buildJourneyFromTimeline(events, maxSteps = 8) {
  if (!Array.isArray(events) || events.length === 0) {
    return [];
  }

  const rawSteps = [];
  let currentStep = null;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev || !ev.url || isIgnorableUrl(ev.url)) continue;

    const url = sanitizeUrl(ev.url);
    const domain = getDomain(url);
    const rawTitle = ev.title || domain || 'Webpage';
    const title = cleanPageTitle(rawTitle, domain, url).slice(0, 120);
    const timestamp = ev.timestamp || Date.now();
    const duration = typeof ev.duration === 'number' && ev.duration >= 0 ? ev.duration : 0;

    if (currentStep && (currentStep.tabId === ev.tabId || (currentStep.url === url && currentStep.tabId === null))) {
      currentStep.duration = (currentStep.duration || 0) + duration;
      currentStep.endTime = timestamp + duration;
      currentStep.eventCount = (currentStep.eventCount || 1) + 1;
      if (title && title !== domain) currentStep.title = title;
    } else {
      if (currentStep) {
        rawSteps.push(currentStep);
      }
      currentStep = {
        tabId: ev.tabId || null,
        url,
        domain,
        title,
        startTime: timestamp,
        endTime: timestamp + duration,
        duration: Math.max(duration, 0),
        eventCount: 1
      };
    }
  }

  if (currentStep) {
    rawSteps.push(currentStep);
  }

  // Filter out noisy flickering steps (< 1500ms) unless only step or latest
  const filtered = rawSteps.filter((step, idx) => {
    if (rawSteps.length <= 1) return true;
    if (idx === rawSteps.length - 1) return true;
    return step.duration >= 1500;
  });

  return filtered.slice(-maxSteps);
}

/**
 * Deterministic scoring to identify primary work context
 */
function scorePrimaryContext(journeySteps, activeContext = null) {
  if (!Array.isArray(journeySteps) || journeySteps.length === 0) {
    if (activeContext && (activeContext.title || activeContext.url)) {
      const dom = getDomain(activeContext.url || '');
      return {
        url: sanitizeUrl(activeContext.url || ''),
        title: cleanPageTitle(activeContext.title, dom, activeContext.url),
        domain: dom,
        tabId: activeContext.tabId || null,
        score: 100,
        reason: 'Active context snapshot'
      };
    }
    return null;
  }

  const scores = new Map();
  const totalSteps = journeySteps.length;

  journeySteps.forEach((step, idx) => {
    const key = step.url || step.domain;
    const existing = scores.get(key) || {
      url: step.url,
      title: step.title,
      domain: step.domain,
      tabId: step.tabId,
      totalDuration: 0,
      visitCount: 0,
      recencyScore: 0
    };

    existing.totalDuration += step.duration || 0;
    existing.visitCount += 1;
    existing.recencyScore = Math.max(existing.recencyScore, ((idx + 1) / totalSteps) * 40);
    if (step.title && step.title !== step.domain) {
      existing.title = step.title;
    }

    scores.set(key, existing);
  });

  let best = null;
  let highestScore = -1;

  for (const item of scores.values()) {
    const durationScore = Math.min(50, Math.round(item.totalDuration / 3000));
    const visitScore = Math.min(20, (item.visitCount - 1) * 10);
    const activeBonus = activeContext && activeContext.url && sanitizeUrl(activeContext.url) === item.url ? 20 : 0;
    const totalScore = durationScore + item.recencyScore + visitScore + activeBonus;

    if (totalScore > highestScore) {
      highestScore = totalScore;
      best = {
        url: item.url,
        title: cleanPageTitle(item.title, item.domain, item.url),
        domain: item.domain,
        tabId: item.tabId,
        totalDuration: item.totalDuration,
        score: totalScore,
        reason: `Spent ${formatDuration(item.totalDuration)} over ${item.visitCount} visits`
      };
    }
  }

  return best;
}

/**
 * Deterministic reconstruction of recovery summary
 */
function deterministicReconstruct(context, journey = [], interruption = {}) {
  const safeContext = context || {};
  const rawTitle = (safeContext.title || '').trim();
  const url = (safeContext.url || '').trim();
  const domain = getDomain(url);
  const title = cleanPageTitle(rawTitle, domain, url);
  const selected = (safeContext.selectedText || '').trim();
  const visible = (safeContext.visibleText || '').trim();
  const input = (safeContext.inputContext || '').trim();
  const focused = (safeContext.focusedElement || '').trim();
  const headings = (safeContext.headings || '').trim();

  let journeySummary = "Single page session.";
  if (Array.isArray(journey) && journey.length > 0) {
    const domainChain = journey.map(j => j.domain || getDomain(j.url)).filter(Boolean);
    if (domainChain.length > 1) {
      journeySummary = domainChain.join(' → ');
    } else if (domainChain.length === 1) {
      journeySummary = `Working on ${domainChain[0]}`;
    }
  }

  let task = "Not enough context.";
  if (selected && selected.length > 8) {
    const cleanSelected = selected.slice(0, 90).replace(/\s+/g, ' ').trim();
    task = `Working on: "${cleanSelected}"`;
  } else if (input && input.length > 3) {
    const cleanInput = input.slice(0, 70).replace(/\s+/g, ' ').trim();
    task = `Drafting: "${cleanInput}" on ${title}`;
  } else if (headings) {
    const firstHeading = headings.split(' | ')[0].trim().slice(0, 80);
    task = `Working on: ${firstHeading} (${title})`;
  } else if (title && title !== domain && title !== 'Webpage') {
    if (url.includes('/pull/') || url.includes('/issues/')) {
      task = `Reviewing GitHub issue/PR: ${title}`;
    } else if (url.includes('/chat') || domain.includes('arena') || domain.includes('claude') || domain.includes('chatgpt')) {
      task = `Consulting AI model on ${title}`;
    } else if (url.includes('docs') || url.includes('developer')) {
      task = `Reviewing documentation for ${title}`;
    } else {
      task = `Working on ${title}`;
    }
  } else if (url) {
    task = `Researching on ${domain}`;
  } else if (visible) {
    const firstSentence = visible.split(/[.!?\n]/)[0]?.trim().slice(0, 80) || '';
    task = firstSentence ? `Reviewing: ${firstSentence}` : "Reviewing page content";
  }

  let tried = "Not enough context.";
  if (input) {
    const cleanInput = input.slice(0, 80).replace(/\s+/g, ' ').trim();
    tried = `Drafted input: "${cleanInput}" in ${focused || 'form field'}`;
  } else if (selected) {
    tried = `Inspected and selected specific text on ${title}`;
  } else if (journey && journey.length > 1) {
    const distinctSites = Array.from(new Set(journey.map(j => j.domain).filter(Boolean)));
    tried = `Referenced ${distinctSites.slice(0, 3).join(', ')} while navigating the session`;
  } else if (headings) {
    const headingList = headings.split(' | ').slice(0, 2).join(' and ');
    tried = `Consulted sections on ${headingList}`;
  } else if (focused) {
    tried = `Interacted with ${focused} on ${title}`;
  } else if (visible) {
    tried = `Reviewed technical specifications and documentation on ${title}`;
  } else {
    tried = `Explored ${title || domain}`;
  }

  let whereYouLeftOff = "Not enough context.";
  if (input) {
    whereYouLeftOff = `In the middle of typing into ${focused || 'input field'}: "${input.slice(0, 50).replace(/\s+/g, ' ')}"`;
  } else if (selected) {
    whereYouLeftOff = `Highlighted: "${selected.slice(0, 60).replace(/\s+/g, ' ')}"`;
  } else if (safeContext.scrollY && safeContext.scrollY > 300) {
    whereYouLeftOff = `Reading ${title} (scrolled down ~${safeContext.scrollY}px)`;
  } else if (title && title !== 'Webpage') {
    whereYouLeftOff = `Viewing ${title}`;
  } else if (url) {
    whereYouLeftOff = `Active on ${domain}`;
  }

  let next = "Resume active session in " + (title || domain);
  if (input) {
    next = "Finish typing your drafted text and submit/save";
  } else if (selected) {
    next = `Apply or copy the highlighted text from ${title}`;
  } else if (url.includes('/pull/') || url.includes('/issues/')) {
    next = `Complete review and submit comments on ${title}`;
  } else if (url.includes('stackoverflow.com') || title.toLowerCase().includes('error') || title.toLowerCase().includes('bug')) {
    next = `Apply the verified solution from ${title} to your code`;
  } else if (url.includes('docs') || url.includes('developer') || title.toLowerCase().includes('guide')) {
    next = `Implement the referenced code pattern from ${title}`;
  } else if (domain.includes('arena') || domain.includes('chatgpt') || domain.includes('claude')) {
    next = `Review the AI response on ${title} and test the output`;
  } else {
    next = `Resume active work in ${title || domain}`;
  }

  const limitWords = (str, max = 25) => {
    if (!str || typeof str !== 'string') return '';
    const words = str.trim().split(/\s+/);
    return words.length <= max ? str : words.slice(0, max).join(' ') + '…';
  };

  return {
    task: limitWords(task, 22),
    tried: limitWords(tried, 22),
    next: limitWords(next, 22),
    whereYouLeftOff: limitWords(whereYouLeftOff, 22),
    journeySummary: limitWords(journeySummary, 25),
    confidence: 'high'
  };
}

/**
 * Capture context snapshot from content script with fast fallback to tab metadata
 */
function captureTabSnapshot(tabId) {
  return new Promise(async (resolve) => {
    if (!tabId) {
      resolve(null);
      return;
    }

    let tab = null;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      resolve(null);
      return;
    }

    if (!tab || !tab.url || isIgnorableUrl(tab.url)) {
      resolve(null);
      return;
    }

    const fallbackSnapshot = {
      tabId: tab.id,
      title: (tab.title || '').slice(0, 200),
      url: sanitizeUrl(tab.url || ''),
      selectedText: '',
      visibleText: '',
      headings: '',
      focusedElement: '',
      inputContext: '',
      scrollX: 0,
      scrollY: 0,
      capturedAt: Date.now()
    };

    console.log(`${LOG_PREFIX} Capture requested: Tab ${tabId} (${tab.title?.slice(0, 30)})`);

    let responded = false;
    const timeout = setTimeout(() => {
      if (!responded) {
        responded = true;
        console.log(`${LOG_PREFIX} Capture response: Timeout on tab ${tabId}, using metadata fallback`);
        resolve(fallbackSnapshot);
      }
    }, 600);

    try {
      chrome.tabs.sendMessage(tabId, { type: 'CAPTURE_CONTEXT' }, (response) => {
        if (responded) return;
        responded = true;
        clearTimeout(timeout);

        if (chrome.runtime.lastError || !response) {
          console.log(`${LOG_PREFIX} Capture response: Content script unreachable on tab ${tabId} (${chrome.runtime.lastError?.message || 'no response'}), using metadata fallback`);
          resolve(fallbackSnapshot);
          return;
        }

        console.log(`${LOG_PREFIX} Capture response: Received from tab ${tabId} (${response.title?.slice(0, 30)})`);
        resolve({
          tabId: tab.id,
          title: response.title || fallbackSnapshot.title,
          url: sanitizeUrl(response.url || fallbackSnapshot.url),
          selectedText: response.selectedText || '',
          visibleText: response.visibleText || '',
          headings: response.headings || '',
          focusedElement: response.focusedElement || '',
          inputContext: response.inputContext || '',
          scrollX: typeof response.scrollX === 'number' ? response.scrollX : 0,
          scrollY: typeof response.scrollY === 'number' ? response.scrollY : 0,
          capturedAt: Date.now()
        });
      });
    } catch (err) {
      if (!responded) {
        responded = true;
        clearTimeout(timeout);
        console.log(`${LOG_PREFIX} Capture response: Send message failed (${err.message}), using metadata fallback`);
        resolve(fallbackSnapshot);
      }
    }
  });
}

/**
 * Assembles rich work-context capsule with journey, timeline scoring, and optional AI
 */
async function assembleAndSaveCapsule(state, awayDurationMs) {
  const now = Date.now();
  const timeline = Array.isArray(state.timeline) ? state.timeline : [];
  const journey = buildJourneyFromTimeline(timeline);

  // Find most relevant snapshot from tabSnapshots
  let bestSnapshot = null;
  if (state.lastWorkingTabId && state.tabSnapshots && state.tabSnapshots[state.lastWorkingTabId]) {
    bestSnapshot = state.tabSnapshots[state.lastWorkingTabId];
  } else if (state.currentTabId && state.tabSnapshots && state.tabSnapshots[state.currentTabId]) {
    bestSnapshot = state.tabSnapshots[state.currentTabId];
  } else if (state.tabSnapshots) {
    const snapshots = Object.values(state.tabSnapshots);
    if (snapshots.length > 0) {
      bestSnapshot = snapshots[snapshots.length - 1];
    }
  }

  const primary = scorePrimaryContext(journey, bestSnapshot);
  const targetUrl = sanitizeUrl(primary?.url || bestSnapshot?.url || state.lastWorkingUrl || state.currentUrl || '');
  const targetTitle = primary?.title || bestSnapshot?.title || state.lastWorkingTitle || state.currentTitle || 'Working context';
  const targetTabId = primary?.tabId || bestSnapshot?.tabId || state.lastWorkingTabId || state.currentTabId;

  // If we have a snapshot matching primary target, use it
  let primarySnapshot = bestSnapshot;
  if (primary?.tabId && state.tabSnapshots && state.tabSnapshots[primary.tabId]) {
    primarySnapshot = state.tabSnapshots[primary.tabId];
  }

  const interruptionInfo = {
    interruptionStartedAt: state.awayTimestamp || now - awayDurationMs,
    returnedAt: now,
    awayDuration: awayDurationMs,
    interruptionReason: state.interruptionReason || 'tab_switch',
    meaningfulSwitchCount: journey.length,
    relevantTabCount: new Set(journey.map(j => j.url)).size
  };

  const deterministic = deterministicReconstruct(primarySnapshot || { url: targetUrl, title: targetTitle }, journey, interruptionInfo);

  const capsule = {
    id: generateCapsuleId(),
    tabId: targetTabId,
    windowId: state.currentWindowId,
    url: targetUrl,
    title: targetTitle.slice(0, 500),
    capturedAt: now,
    lastActiveAt: now - awayDurationMs,
    interruptedAt: state.awayTimestamp || now - awayDurationMs,
    returnedAt: now,
    awayDuration: awayDurationMs,
    interruptionReason: interruptionInfo.interruptionReason,
    meaningfulSwitchCount: interruptionInfo.meaningfulSwitchCount,
    relevantTabCount: interruptionInfo.relevantTabCount,
    scrollX: primarySnapshot?.scrollX || 0,
    scrollY: primarySnapshot?.scrollY || 0,
    visibleText: (primarySnapshot?.visibleText || '').slice(0, 3500),
    selectedText: (primarySnapshot?.selectedText || '').slice(0, 1500),
    headings: (primarySnapshot?.headings || '').slice(0, 500),
    focusedElement: (primarySnapshot?.focusedElement || '').slice(0, 300),
    inputContext: (primarySnapshot?.inputContext || '').slice(0, 1500),
    // Journey data
    journey: journey,
    primaryContext: primary,
    // Canonical summary fields
    task: deterministic.task,
    tried: deterministic.tried,
    next: deterministic.next,
    whereYouLeftOff: deterministic.whereYouLeftOff,
    journeySummary: deterministic.journeySummary,
    confidence: deterministic.confidence,
    source: 'deterministic',
    status: 'captured',
    ai: null
  };

  console.log(`${LOG_PREFIX} Capsule created: "${capsule.task}" for ${capsule.title?.slice(0, 35)}`);

  try {
    await chrome.storage.local.set({ [CAPSULE_STORAGE_KEY]: capsule });
    console.log(`${LOG_PREFIX} Capsule saved: ID ${capsule.id} (${formatDuration(awayDurationMs)} away)`);

    // Async AI enrichment
    fetchAIEnrichment(capsule).then(async (aiEnriched) => {
      if (aiEnriched && aiEnriched.task) {
        const enrichedCapsule = {
          ...capsule,
          task: aiEnriched.task,
          tried: aiEnriched.tried,
          next: aiEnriched.next,
          journeySummary: aiEnriched.journeySummary || capsule.journeySummary,
          whereYouLeftOff: aiEnriched.whereYouLeftOff || capsule.whereYouLeftOff,
          confidence: aiEnriched.confidence || 'high',
          ai: aiEnriched,
          source: 'ai',
          status: 'enriched'
        };
        await chrome.storage.local.set({ [CAPSULE_STORAGE_KEY]: enrichedCapsule });
        console.log(`${LOG_PREFIX} Capsule enriched with AI: "${enrichedCapsule.task}"`);
      }
    }).catch(() => {});

  } catch (err) {
    console.error(`${LOG_PREFIX} Failed to persist capsule:`, err);
  }

  return capsule;
}

async function fetchAIEnrichment(capsule) {
  const payload = {
    context: {
      title: capsule.title,
      url: capsule.url,
      selectedText: capsule.selectedText,
      visibleText: capsule.visibleText,
      headings: capsule.headings,
      focusedElement: capsule.focusedElement,
      inputContext: capsule.inputContext,
      scrollX: capsule.scrollX,
      scrollY: capsule.scrollY
    },
    journey: capsule.journey,
    interruption: {
      awayDuration: capsule.awayDuration,
      interruptionReason: capsule.interruptionReason,
      meaningfulSwitchCount: capsule.meaningfulSwitchCount
    }
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(BACKEND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (res.ok) {
      return await res.json();
    }
    return null;
  } catch {
    clearTimeout(timeoutId);
    return null;
  }
}

// --- Dynamic Work Session Initialization & Tracking ---

async function ensureInitialized() {
  const state = await loadSessionState();
  if (state.currentTabId !== null) return state;

  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab && !isIgnorableUrl(tab.url)) {
      const now = Date.now();
      state.currentTabId = tab.id;
      state.currentWindowId = tab.windowId;
      state.currentUrl = sanitizeUrl(tab.url);
      state.currentTitle = (tab.title || getDomain(tab.url)).slice(0, 150);
      state.currentTabActivatedAt = now;
      state.lastWorkingTabId = tab.id;
      state.lastWorkingUrl = state.currentUrl;
      state.lastWorkingTitle = state.currentTitle;

      console.log(`${LOG_PREFIX} Working tab: Tab ${tab.id} (${state.currentTitle.slice(0, 30)})`);

      // Record in timeline
      state.timeline.push({
        timestamp: now,
        type: 'tab_activated',
        tabId: tab.id,
        windowId: tab.windowId,
        url: state.currentUrl,
        title: state.currentTitle,
        duration: 0
      });

      // Capture initial snapshot in background
      captureTabSnapshot(tab.id).then(async (snap) => {
        if (snap) {
          const s = await loadSessionState();
          s.tabSnapshots[tab.id] = snap;
          await saveSessionState({ tabSnapshots: s.tabSnapshots });
        }
      });

      await saveSessionState(state);
    }
  } catch (err) {
    console.warn(`${LOG_PREFIX} Initialization error:`, err.message);
  }
  return state;
}

chrome.runtime.onStartup.addListener(ensureInitialized);
chrome.runtime.onInstalled.addListener(ensureInitialized);

// --- Tab Switching & Work Journey Lifecycle ---

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const { tabId, windowId } = activeInfo;
  if (await isIgnorableTab(tabId)) return;

  await ensureInitialized();
  const state = await loadSessionState();
  const now = Date.now();
  const prevTabId = state.currentTabId;
  const timeOnPrevTab = now - (state.currentTabActivatedAt || now);

  let newTab = null;
  try { newTab = await chrome.tabs.get(tabId); } catch {}
  if (!newTab || isIgnorableUrl(newTab.url)) return;

  const newUrl = sanitizeUrl(newTab.url);
  const newTitle = (newTab.title || getDomain(newUrl)).slice(0, 150);

  // 1. If leaving previous tab, update timeline duration and capture snapshot
  if (prevTabId && prevTabId !== tabId) {
    console.log(`${LOG_PREFIX} Leave detected: Left Tab ${prevTabId} after ${(timeOnPrevTab / 1000).toFixed(1)}s (reason: tab_switch)`);

    // Update duration on the last timeline item
    if (state.timeline.length > 0) {
      const lastEvent = state.timeline[state.timeline.length - 1];
      if (lastEvent.tabId === prevTabId) {
        lastEvent.duration = (lastEvent.duration || 0) + timeOnPrevTab;
      }
    }

    // Capture snapshot of previous tab at leave time
    const prevSnapshot = await captureTabSnapshot(prevTabId);
    if (prevSnapshot) {
      state.tabSnapshots[prevTabId] = prevSnapshot;
    }

    // Mark previous tab as last working tab if spent > 2s
    if (timeOnPrevTab >= 2000) {
      state.lastWorkingTabId = prevTabId;
      state.lastWorkingUrl = state.currentUrl;
      state.lastWorkingTitle = state.currentTitle;
    }

    // If away timer is not running, start it
    if (state.awayTimestamp === null) {
      state.awayTimestamp = now;
      state.interruptionPending = true;
      state.interruptionReason = 'tab_switch';
    }
  }

  // 2. Add new tab to timeline
  state.timeline.push({
    timestamp: now,
    type: 'tab_activated',
    tabId: tabId,
    windowId: windowId,
    url: newUrl,
    title: newTitle,
    duration: 0
  });

  if (state.timeline.length > MAX_TIMELINE_EVENTS) {
    state.timeline.splice(0, state.timeline.length - MAX_TIMELINE_EVENTS);
  }

  console.log(`${LOG_PREFIX} Timeline updated: Added Tab ${tabId} (${newTitle.slice(0, 30)})`);
  console.log(`${LOG_PREFIX} Working tab: Tab ${tabId} (${newTitle.slice(0, 30)})`);

  // 3. Check if user returned or has been away for >= 10 seconds
  if (state.awayTimestamp !== null) {
    const awayDuration = now - state.awayTimestamp;
    if (awayDuration >= INTERRUPTION_THRESHOLD_MS) {
      console.log(`${LOG_PREFIX} Interruption confirmed (${(awayDuration / 1000).toFixed(1)}s >= 10s), assembling capsule`);
      await assembleAndSaveCapsule(state, awayDuration);
    }
  }

  // 4. Update current active tab state
  state.currentTabId = tabId;
  state.currentWindowId = windowId;
  state.currentUrl = newUrl;
  state.currentTitle = newTitle;
  state.currentTabActivatedAt = now;

  await saveSessionState(state);

  // Capture snapshot of newly activated tab asynchronously
  captureTabSnapshot(tabId).then(async (snap) => {
    if (snap) {
      const s = await loadSessionState();
      s.tabSnapshots[tabId] = snap;
      await saveSessionState({ tabSnapshots: s.tabSnapshots });
    }
  });
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  await ensureInitialized();
  const state = await loadSessionState();
  const now = Date.now();

  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    // User blurred Chrome / switched to desktop app
    console.log(`${LOG_PREFIX} Leave detected: Browser lost focus (reason: browser_blur)`);
    if (state.currentTabId) {
      const snap = await captureTabSnapshot(state.currentTabId);
      if (snap) {
        state.tabSnapshots[state.currentTabId] = snap;
      }
    }
    state.awayTimestamp = now;
    state.interruptionPending = true;
    state.interruptionReason = 'browser_blur';
    await saveSessionState(state);
    return;
  }

  // User returned to a Chrome window
  if (state.awayTimestamp !== null) {
    const awayDuration = now - state.awayTimestamp;
    console.log(`${LOG_PREFIX} Returned after ${(awayDuration / 1000).toFixed(1)}s focus change`);
    if (awayDuration >= INTERRUPTION_THRESHOLD_MS) {
      console.log(`${LOG_PREFIX} Interruption confirmed (${(awayDuration / 1000).toFixed(1)}s >= 10s), assembling capsule`);
      await assembleAndSaveCapsule(state, awayDuration);
    }
    state.awayTimestamp = null;
    state.interruptionPending = false;
    state.interruptionReason = null;
  }

  state.currentWindowId = windowId;
  state.currentTabActivatedAt = now;
  await saveSessionState(state);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab && tab.url && !isIgnorableUrl(tab.url)) {
    const state = await loadSessionState();
    const cleanUrl = sanitizeUrl(tab.url);
    const title = (tab.title || getDomain(cleanUrl)).slice(0, 150);

    state.timeline.push({
      timestamp: Date.now(),
      type: 'page_navigated',
      tabId: tabId,
      windowId: tab.windowId,
      url: cleanUrl,
      title: title,
      duration: 0
    });

    if (state.currentTabId === tabId) {
      state.currentUrl = cleanUrl;
      state.currentTitle = title;
    }

    await saveSessionState(state);

    captureTabSnapshot(tabId).then(async (snap) => {
      if (snap) {
        const s = await loadSessionState();
        s.tabSnapshots[tabId] = snap;
        await saveSessionState({ tabSnapshots: s.tabSnapshots });
      }
    });
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await loadSessionState();
  if (state.tabSnapshots && state.tabSnapshots[tabId]) {
    // Keep the snapshot for recovery even if tab closed, but mark tabId as null
    state.tabSnapshots[tabId].tabId = null;
  }
  if (state.currentTabId === tabId) {
    state.currentTabId = null;
  }
  await saveSessionState(state);
});

// --- Message Listener for On-Demand Capsule Retrieval & Scroll Restoration ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return false;

  if (message.type === 'GET_OR_RECONSTRUCT_CAPSULE') {
    (async () => {
      try {
        // 1. Check stored capsule in storage.local
        const result = await chrome.storage.local.get(CAPSULE_STORAGE_KEY);
        let capsule = result[CAPSULE_STORAGE_KEY];

        if (capsule && capsule.capturedAt && (Date.now() - capsule.capturedAt < CAPSULE_EXPIRY_MS)) {
          console.log(`${LOG_PREFIX} Returning existing active capsule ID: ${capsule.id}`);
          sendResponse({ capsule });
          return;
        }

        // 2. If none exists, reconstruct on-the-fly from session timeline
        const state = await loadSessionState();
        if (state.timeline && state.timeline.length > 0) {
          const awayDuration = state.awayTimestamp ? Date.now() - state.awayTimestamp : 12000;
          capsule = await assembleAndSaveCapsule(state, Math.max(awayDuration, 5000));
          console.log(`${LOG_PREFIX} Reconstructed fresh on-demand capsule ID: ${capsule.id}`);
          sendResponse({ capsule });
          return;
        }

        sendResponse({ capsule: null });
      } catch (err) {
        console.warn(`${LOG_PREFIX} GET_OR_RECONSTRUCT_CAPSULE error:`, err);
        sendResponse({ capsule: null });
      }
    })();
    return true; // async sendResponse
  }

  return false;
});

// Top level startup execution
ensureInitialized();

console.log(`${LOG_PREFIX} Work-Context Recovery Engine started (threshold ${INTERRUPTION_THRESHOLD_MS}ms)`);


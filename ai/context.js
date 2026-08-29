/**
 * Flowback — Context Utilities & Reconstruction Engine
 * Unified canonical engine for validation, sanitization, timeline parsing,
 * primary context scoring, and deterministic work journey reconstruction.
 * Privacy-focused: strict secret redaction, no sensitive data logging.
 */

const LIMITS = {
  title: 500,
  url: 2000,
  selectedText: 1500,
  visibleText: 3500,
  focusedElement: 300,
  inputContext: 1500,
  headings: 500,
  totalPayload: 10000,
  maxJourneySteps: 8
};

const SENSITIVE_PATTERNS = [
  /password/i,
  /passwd/i,
  /credit.*card/i,
  /card.*number/i,
  /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/,
  /\b\d{3}[-]?\d{2}[-]?\d{4}\b/,
  /cvv/i,
  /cvc/i,
  // Bearer tokens & JWTs
  /bearer\s+[a-zA-Z0-9_\-\.=:_+/]+/i,
  /\bey[a-zA-Z0-9_\-]{10,}\.ey[a-zA-Z0-9_\-]{10,}\.[a-zA-Z0-9_\-]{10,}\b/,
  // Common API key formats
  /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{30,}\b/,
  /\bsk-[a-zA-Z0-9_\-]{20,}\b/,
  /\bAIzaSy[A-Za-z0-9_\-]{33}\b/,
  /\bxox[baprs]-[A-Za-z0-9_\-]{10,}\b/
];

const SENSITIVE_QUERY_PARAMS = [
  'token', 'auth', 'access_token', 'id_token', 'refresh_token',
  'api_key', 'apikey', 'key', 'secret', 'password', 'pwd',
  'session_id', 'sessionid', 'bearer'
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

function redactSensitiveData(text) {
  if (typeof text !== 'string' || !text) return '';
  let cleaned = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    cleaned = cleaned.replace(pattern, '[REDACTED]');
  }
  return cleaned;
}

function sanitizeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  try {
    const parsed = new URL(rawUrl);
    // Remove only explicitly sensitive query parameters, preserve essential navigation query params
    for (const param of Array.from(parsed.searchParams.keys())) {
      if (SENSITIVE_QUERY_PARAMS.includes(param.toLowerCase())) {
        parsed.searchParams.delete(param);
      }
    }
    // Remove auth user/password in URL authority
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return rawUrl.slice(0, LIMITS.url);
  }
}

function sanitizeField(text, maxLength, fieldName) {
  if (typeof text !== 'string') return '';
  if (containsSensitiveData(text)) {
    return redactSensitiveData(truncate(text, maxLength));
  }
  return truncate(text, maxLength);
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

/**
 * Filter rapid bounces (< 1500ms) and aggregate tab timeline into meaningful journey steps
 */
function buildJourneyFromTimeline(events, maxSteps = LIMITS.maxJourneySteps) {
  if (!Array.isArray(events) || events.length === 0) {
    return [];
  }

  const rawSteps = [];
  let currentStep = null;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev || !ev.url) continue;

    const url = sanitizeUrl(ev.url);
    const domain = getDomain(url);
    const rawTitle = ev.title || domain || 'Webpage';
    const title = cleanPageTitle(rawTitle, domain, url).slice(0, 120);
    const timestamp = ev.timestamp || Date.now();
    const duration = typeof ev.duration === 'number' && ev.duration >= 0 ? ev.duration : 0;

    // Check if continuing same tab or immediate same domain
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

  // Filter out noise steps (< 1.5s unless it's the only one or the primary work tab)
  const filtered = rawSteps.filter((step, idx) => {
    if (rawSteps.length <= 1) return true;
    if (idx === rawSteps.length - 1) return true; // keep latest
    return step.duration >= 1500;
  });

  return filtered.slice(-maxSteps);
}

/**
 * Deterministic scoring to find primary work context
 * Signals: total time spent, visit frequency, recency, presence of input/selected text
 */
function scorePrimaryContext(journeySteps, activeContext = null) {
  if (!Array.isArray(journeySteps) || journeySteps.length === 0) {
    if (activeContext && (activeContext.title || activeContext.url)) {
      const dom = getDomain(activeContext.url || '');
      return {
        url: sanitizeUrl(activeContext.url || ''),
        title: cleanPageTitle(activeContext.title, dom, activeContext.url),
        domain: dom,
        score: 100,
        reason: 'Active context snapshot'
      };
    }
    return null;
  }

  // Aggregate stats per URL / domain
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
    // More recent steps get higher recency bonus (0 to 40 points)
    existing.recencyScore = Math.max(existing.recencyScore, ((idx + 1) / totalSteps) * 40);
    if (step.title && step.title !== step.domain) {
      existing.title = step.title;
    }

    scores.set(key, existing);
  });

  let best = null;
  let highestScore = -1;

  for (const item of scores.values()) {
    // Duration score: 1 point per 3 seconds up to 50 points
    const durationScore = Math.min(50, Math.round(item.totalDuration / 3000));
    // Visit frequency score: 10 points per return up to 20 points
    const visitScore = Math.min(20, (item.visitCount - 1) * 10);
    // Active context bonus: 20 points if matches active context URL
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
 * Deterministic Work-Context Reconstruction (Core MVP - No AI needed)
 * Produces structured recovery summary: TASK, TRIED, NEXT, WHERE_YOU_LEFT_OFF, JOURNEY_SUMMARY
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

  // 1. Build Journey Summary
  let journeySummary = "Single page session.";
  if (Array.isArray(journey) && journey.length > 0) {
    const domainChain = journey.map(j => j.domain || getDomain(j.url)).filter(Boolean);
    if (domainChain.length > 1) {
      journeySummary = domainChain.join(' → ');
    } else if (domainChain.length === 1) {
      journeySummary = `Working on ${domainChain[0]}`;
    }
  }

  // 2. Determine Primary Task
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

  // 3. Determine What Was Tried & Referenced
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

  // 4. Determine Where User Left Off
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

  // 5. Determine Next Action (Concrete, evidence-grounded)
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

function validateAndSanitizeContext(rawPayload) {
  if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return { valid: false, error: 'Invalid context: must be an object' };
  }

  const rawContext = rawPayload.context || rawPayload;
  const rawJourney = Array.isArray(rawPayload.journey) ? rawPayload.journey : [];
  const rawInterruption = rawPayload.interruption || {};

  const sanitizedContext = {
    title: sanitizeField(rawContext.title, LIMITS.title, 'title'),
    url: sanitizeUrl(rawContext.url || ''),
    selectedText: sanitizeField(rawContext.selectedText, LIMITS.selectedText, 'selected'),
    visibleText: sanitizeField(rawContext.visibleText, LIMITS.visibleText, 'visible'),
    headings: sanitizeField(rawContext.headings, LIMITS.headings, 'headings'),
    focusedElement: sanitizeField(rawContext.focusedElement, LIMITS.focusedElement, 'focused'),
    inputContext: sanitizeField(rawContext.inputContext, LIMITS.inputContext, 'input'),
    scrollX: typeof rawContext.scrollX === 'number' ? Math.max(0, Math.round(rawContext.scrollX)) : 0,
    scrollY: typeof rawContext.scrollY === 'number' ? Math.max(0, Math.round(rawContext.scrollY)) : 0
  };

  const sanitizedJourney = rawJourney.slice(0, LIMITS.maxJourneySteps).map(item => ({
    title: sanitizeField(item.title, 120, 'journey_title'),
    url: sanitizeUrl(item.url || ''),
    domain: getDomain(item.url || item.domain || ''),
    duration: typeof item.duration === 'number' ? Math.max(0, item.duration) : 0,
    eventCount: typeof item.eventCount === 'number' ? item.eventCount : 1,
    startTime: item.startTime || null,
    endTime: item.endTime || null
  }));

  const sanitizedInterruption = {
    interruptionStartedAt: rawInterruption.interruptionStartedAt || null,
    returnedAt: rawInterruption.returnedAt || null,
    awayDuration: typeof rawInterruption.awayDuration === 'number' ? rawInterruption.awayDuration : null,
    interruptionReason: typeof rawInterruption.interruptionReason === 'string' ? rawInterruption.interruptionReason.slice(0, 50) : 'unknown',
    meaningfulSwitchCount: typeof rawInterruption.meaningfulSwitchCount === 'number' ? rawInterruption.meaningfulSwitchCount : 0,
    relevantTabCount: typeof rawInterruption.relevantTabCount === 'number' ? rawInterruption.relevantTabCount : 0
  };

  const hasContent = Object.values(sanitizedContext).some(v => v && typeof v === 'string' && v.length > 0 && !v.includes('REDACTED')) || sanitizedJourney.length > 0;

  return {
    valid: true,
    hasContent,
    context: sanitizedContext,
    journey: sanitizedJourney,
    interruption: sanitizedInterruption
  };
}

function buildUserPrompt(sanitizedPayload) {
  const { context, journey, interruption } = sanitizedPayload;
  const parts = [];

  if (context.title) parts.push(`Active Page Title: ${context.title}`);
  if (context.url) parts.push(`Active URL: ${context.url}`);
  if (context.selectedText) parts.push(`Selected Text: "${context.selectedText}"`);
  if (context.headings) parts.push(`Page Headings: ${context.headings}`);
  if (context.focusedElement) parts.push(`Focused Element: ${context.focusedElement}`);
  if (context.inputContext) parts.push(`Drafted Input: "${context.inputContext}"`);
  if (context.visibleText) parts.push(`Visible Content (Excerpt): ${context.visibleText.slice(0, 1500)}`);

  if (journey && journey.length > 0) {
    const journeyList = journey.map(j => `- ${j.title || j.domain} (${j.domain}) [Time spent: ${formatDuration(j.duration)}]`).join('\n');
    parts.push(`Recent Work Journey (${journey.length} tabs):\n${journeyList}`);
  }

  if (interruption && interruption.awayDuration) {
    parts.push(`Interruption: away for ${formatDuration(interruption.awayDuration)} (Reason: ${interruption.interruptionReason || 'switch'})`);
  }

  if (parts.length === 0) return 'No context captured. All fields empty.';
  return parts.join('\n\n');
}

function validateAIResponse(response) {
  if (!response || typeof response !== 'object') {
    return { valid: false, error: 'Response not an object' };
  }
  const { task, tried, next, journeySummary, whereYouLeftOff } = response;
  if (typeof task !== 'string' || typeof tried !== 'string' || typeof next !== 'string') {
    return { valid: false, error: 'task, tried, next must be strings' };
  }
  if (!task.trim() || !tried.trim() || !next.trim()) {
    return { valid: false, error: 'Required fields cannot be empty' };
  }
  const wordCount = (str) => str.trim().split(/\s+/).length;
  const MAX_WORDS = 40;
  if (wordCount(task) > MAX_WORDS || wordCount(tried) > MAX_WORDS || wordCount(next) > MAX_WORDS) {
    return { valid: false, error: `Fields exceed ${MAX_WORDS} words limit` };
  }

  return {
    valid: true,
    sanitized: {
      task: task.trim(),
      tried: tried.trim(),
      next: next.trim(),
      journeySummary: typeof journeySummary === 'string' ? journeySummary.trim() : '',
      whereYouLeftOff: typeof whereYouLeftOff === 'string' ? whereYouLeftOff.trim() : '',
      confidence: response.confidence || 'high'
    }
  };
}

module.exports = {
  LIMITS,
  truncate,
  cleanPageTitle,
  containsSensitiveData,
  redactSensitiveData,
  sanitizeUrl,
  sanitizeField,
  getDomain,
  formatDuration,
  buildJourneyFromTimeline,
  scorePrimaryContext,
  deterministicReconstruct,
  validateAndSanitizeContext,
  buildUserPrompt,
  validateAIResponse
};

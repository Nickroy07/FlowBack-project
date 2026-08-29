/**
 * Flowback — popup.js
 * Stitch-Inspired Work-Context Recovery UI Controller
 * Maps real session events, timeline journey steps, interruption diagnostics,
 * and deterministic/AI recovery cards. Supports scroll restoration & keyboard shortcuts.
 */

(function () {
  "use strict";

  const CAPSULE_KEY = "activeCapsule";
  const MAX_DISPLAY = 600;

  const STATES = {
    EMPTY: 'empty',
    CAPTURED: 'captured',
    RESTORING: 'restoring',
    SUCCESS: 'success',
    ERROR: 'error'
  };

  let els = null;
  let activeCapsule = null;
  let currentState = STATES.EMPTY;

  function getElements() {
    return {
      statusBadge: document.getElementById('statusBadge'),
      statusText: document.querySelector('.status-text'),
      
      emptyState: document.getElementById('emptyState'),
      capturedState: document.getElementById('capturedState'),
      restoringState: document.getElementById('restoringState'),
      successState: document.getElementById('successState'),
      errorState: document.getElementById('errorState'),
      
      interruptionStrip: document.getElementById('interruptionStrip'),
      metaAway: document.getElementById('metaAway'),
      interruptionReasonText: document.getElementById('interruptionReasonText'),
      switchCountText: document.getElementById('switchCountText'),

      metaSite: document.getElementById('metaSite'),
      durationBadge: document.getElementById('durationBadge'),
      totalActiveTime: document.getElementById('totalActiveTime'),
      contextTitle: document.getElementById('contextTitle'),
      contextUrl: document.getElementById('contextUrl'),
      
      journeySection: document.getElementById('journeySection'),
      journeyStepCount: document.getElementById('journeyStepCount'),
      journeyTimeline: document.getElementById('journeyTimeline'),
      
      task: document.getElementById('task'),
      tried: document.getElementById('tried'),
      whereYouLeftOff: document.getElementById('whereYouLeftOff'),
      next: document.getElementById('next'),
      
      aiNotice: document.getElementById('aiNotice'),
      aiNoticeText: document.getElementById('aiNoticeText'),
      
      resumeBtn: document.getElementById('resumeBtn'),
      dismissBtn: document.getElementById('dismissBtn'),
      retryBtn: document.getElementById('retryBtn'),
      openUrlBtn: document.getElementById('openUrlBtn'),
      
      errorTitle: document.getElementById('errorTitle'),
      errorSubtext: document.getElementById('errorSubtext')
    };
  }

  function setText(el, value, fallback = '—') {
    if (!el) return;
    const text = typeof value === 'string' ? value.trim() : '';
    el.textContent = text || fallback;
  }

  function normalizeText(value, limit = MAX_DISPLAY) {
    if (typeof value !== 'string') return '';
    const text = value.replace(/\s+/g, ' ').trim();
    if (!text) return '';
    return text.length > limit ? text.slice(0, limit - 1).trimEnd() + '…' : text;
  }

  function formatTimeOfDay(timestamp) {
    if (!timestamp) return '';
    try {
      const d = new Date(timestamp);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  }

  function formatDuration(ms) {
    if (!ms || typeof ms !== 'number' || ms < 0) return '0s';
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

  function formatInterruptionReason(reason) {
    switch (reason) {
      case 'tab_switch':
        return 'Tab Switch';
      case 'window_switch':
        return 'Window Switch';
      case 'browser_blur':
        return 'App Focus Change';
      default:
        return 'Context Switch';
    }
  }

  function isValidCapsule(capsule) {
    if (!capsule || typeof capsule !== 'object' || Array.isArray(capsule)) return false;
    
    if (capsule.capturedAt && (Date.now() - capsule.capturedAt > 24 * 60 * 60 * 1000)) {
      return false;
    }

    const hasContent = [
      capsule.title,
      capsule.url,
      capsule.task,
      capsule.visibleText,
      capsule.selectedText,
      capsule.whereYouLeftOff
    ].some(v => typeof v === 'string' && v.trim().length > 0) || (Array.isArray(capsule.journey) && capsule.journey.length > 0);

    return hasContent;
  }

  function showState(state) {
    currentState = state;
    
    if (els.emptyState) els.emptyState.hidden = true;
    if (els.capturedState) els.capturedState.hidden = true;
    if (els.restoringState) els.restoringState.hidden = true;
    if (els.successState) els.successState.hidden = true;
    if (els.errorState) els.errorState.hidden = true;

    switch (state) {
      case STATES.EMPTY:
        if (els.emptyState) els.emptyState.hidden = false;
        setText(els.statusText, 'MONITORING');
        if (els.statusBadge) {
          els.statusBadge.style.background = 'rgba(16, 185, 129, 0.1)';
          els.statusBadge.style.borderColor = 'rgba(16, 185, 129, 0.25)';
        }
        break;
      case STATES.CAPTURED:
        if (els.capturedState) els.capturedState.hidden = false;
        setText(els.statusText, 'RECOVERED');
        if (els.statusBadge) {
          els.statusBadge.style.background = 'rgba(0, 240, 255, 0.12)';
          els.statusBadge.style.borderColor = 'rgba(0, 240, 255, 0.35)';
        }
        break;
      case STATES.RESTORING:
        if (els.restoringState) els.restoringState.hidden = false;
        setText(els.statusText, 'RESTORING…');
        break;
      case STATES.SUCCESS:
        if (els.successState) els.successState.hidden = false;
        setText(els.statusText, 'RESTORED');
        if (els.statusBadge) {
          els.statusBadge.style.background = 'rgba(16, 185, 129, 0.15)';
          els.statusBadge.style.borderColor = 'rgba(16, 185, 129, 0.35)';
        }
        break;
      case STATES.ERROR:
        if (els.errorState) els.errorState.hidden = false;
        setText(els.statusText, 'ERROR');
        if (els.statusBadge) {
          els.statusBadge.style.background = 'rgba(244, 63, 94, 0.15)';
          els.statusBadge.style.borderColor = 'rgba(244, 63, 94, 0.35)';
        }
        break;
    }
  }

  function renderJourneyTimeline(journey, activeUrl, activeTabId) {
    if (!els.journeyTimeline) return;
    els.journeyTimeline.innerHTML = '';

    if (!Array.isArray(journey) || journey.length === 0) {
      if (els.journeySection) els.journeySection.hidden = true;
      return;
    }

    if (els.journeySection) els.journeySection.hidden = false;
    if (els.journeyStepCount) {
      els.journeyStepCount.textContent = `${journey.length} ${journey.length === 1 ? 'step' : 'steps'}`;
    }

    let totalMs = 0;
    const seenDomains = new Set();

    journey.forEach((step, idx) => {
      totalMs += (step.duration || 0);

      const stepDomain = step.domain || getDomain(step.url);
      const isReturn = seenDomains.has(stepDomain) && idx > 0;
      seenDomains.add(stepDomain);

      const cleanTitle = cleanPageTitle(step.title, stepDomain, step.url);

      const stepEl = document.createElement('div');
      stepEl.className = 'timeline-step';

      // Highlight the primary work tab or latest active step
      const isPrimary = (activeTabId && step.tabId === activeTabId) || (step.url === activeUrl) || (idx === journey.length - 1);
      if (isPrimary) {
        stepEl.classList.add('active-step');
      }

      const infoEl = document.createElement('div');
      infoEl.className = 'step-info';

      const headerLine = document.createElement('div');
      headerLine.className = 'step-header-line';

      const timeEl = document.createElement('span');
      timeEl.className = 'step-time';
      timeEl.textContent = formatTimeOfDay(step.startTime) || `${idx + 1}`;

      const sepEl = document.createElement('span');
      sepEl.className = 'step-sep';
      sepEl.textContent = '—';

      const siteEl = document.createElement('span');
      siteEl.className = 'step-site';
      siteEl.textContent = stepDomain;

      headerLine.appendChild(timeEl);
      headerLine.appendChild(sepEl);
      headerLine.appendChild(siteEl);

      if (isReturn && !isPrimary) {
        const returnTag = document.createElement('span');
        returnTag.className = 'step-return-tag';
        returnTag.textContent = '↩ Return';
        headerLine.appendChild(returnTag);
      } else if (isPrimary && journey.length > 1) {
        const primaryTag = document.createElement('span');
        primaryTag.className = 'step-primary-tag';
        primaryTag.textContent = '🎯 Focus';
        headerLine.appendChild(primaryTag);
      }

      const subtextEl = document.createElement('span');
      subtextEl.className = 'step-subtext';
      subtextEl.textContent = cleanTitle || stepDomain;

      infoEl.appendChild(headerLine);
      infoEl.appendChild(subtextEl);

      const durEl = document.createElement('span');
      durEl.className = 'step-duration';
      durEl.textContent = formatDuration(step.duration);

      stepEl.appendChild(infoEl);
      stepEl.appendChild(durEl);

      els.journeyTimeline.appendChild(stepEl);
    });

    if (els.totalActiveTime) {
      els.totalActiveTime.textContent = formatDuration(totalMs);
    }
  }

  function renderCaptured(capsule) {
    activeCapsule = capsule;

    const domain = getDomain(capsule.url);
    const cleanTitle = cleanPageTitle(capsule.title, domain, capsule.url);

    setText(els.metaSite, domain.toUpperCase());
    setText(els.contextTitle, normalizeText(cleanTitle || 'Working context', 90));
    setText(els.contextUrl, normalizeText(capsule.url, 70));

    // Interruption Diagnostics
    const awayMs = capsule.awayDuration || (capsule.interruptedAt ? Date.now() - capsule.interruptedAt : 12000);
    setText(els.metaAway, formatDuration(awayMs));
    setText(els.interruptionReasonText, formatInterruptionReason(capsule.interruptionReason));

    const switchCount = capsule.meaningfulSwitchCount || (Array.isArray(capsule.journey) ? capsule.journey.length : 1);
    setText(els.switchCountText, `${switchCount} ${switchCount === 1 ? 'switch' : 'switches'}`);

    // Render Timeline Journey
    renderJourneyTimeline(capsule.journey, capsule.url, capsule.tabId);

    // Task, Tried, Where Left Off, Next (Ensure high-intelligence, non-generic)
    let task = capsule.task;
    if (!task || task === 'Working on webpage' || task === 'Not enough context.') {
      task = `Working on ${cleanTitle}`;
    }
    // Clean any unread badges in task
    task = task.replace(/^[\(\[\{]\s*\d+\+?\s*[\)\]\}]\s*/i, '');

    let tried = capsule.tried;
    if (!tried || tried === 'Reviewed page documentation and context' || tried === 'Not enough context.') {
      if (Array.isArray(capsule.journey) && capsule.journey.length > 1) {
        const distinct = Array.from(new Set(capsule.journey.map(j => j.domain).filter(Boolean)));
        tried = `Referenced ${distinct.slice(0, 3).join(', ')} while navigating the session`;
      } else {
        tried = `Reviewed technical context and documentation on ${cleanTitle}`;
      }
    }

    let whereLeftOff = capsule.whereYouLeftOff;
    if (!whereLeftOff || whereLeftOff === 'Not enough context.' || whereLeftOff.startsWith('Viewing (')) {
      whereLeftOff = `Viewing ${cleanTitle}`;
    }
    whereLeftOff = whereLeftOff.replace(/\(\d+\)\s*/g, '');

    let next = capsule.next;
    if (!next || next.toLowerCase().includes('continue from where') || next.toLowerCase().includes('resume task') || next === 'Not enough context.') {
      next = `Resume active session in ${cleanTitle}`;
    }

    setText(els.task, normalizeText(task, MAX_DISPLAY));
    setText(els.tried, normalizeText(tried, MAX_DISPLAY));
    setText(els.whereYouLeftOff, normalizeText(whereLeftOff, MAX_DISPLAY));
    setText(els.next, normalizeText(next, MAX_DISPLAY));

    // AI notice badge
    if (els.aiNotice && els.aiNoticeText) {
      const source = capsule.source || 'deterministic';
      if (source === 'ai') {
        els.aiNotice.hidden = false;
        setText(els.aiNoticeText, 'AI-reconstructed context • Verified with evidence');
      } else {
        els.aiNotice.hidden = true;
      }
    }

    if (els.resumeBtn) {
      els.resumeBtn.disabled = false;
      const textSpan = els.resumeBtn.querySelector('.btn-text');
      if (textSpan) textSpan.textContent = 'Resume Work';
    }

    console.log(`[Flowback] Popup loaded capsule: ID=${capsule.id} (${cleanTitle.slice(0, 35)})`);
    showState(STATES.CAPTURED);
  }

  function renderEmpty(message) {
    activeCapsule = null;
    showState(STATES.EMPTY);
    if (message) {
      console.log('[Flowback] Empty state:', message);
    }
  }

  function getStoredCapsule() {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(CAPSULE_KEY, (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(result ? result[CAPSULE_KEY] : null);
      });
    });
  }

  function removeStoredCapsule() {
    return new Promise((resolve, reject) => {
      chrome.storage.local.remove(CAPSULE_KEY, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
      });
    });
  }

  async function loadCapsule() {
    try {
      // 1. Try reading from chrome.storage.local
      const stored = await getStoredCapsule();
      if (isValidCapsule(stored)) {
        renderCaptured(stored);
        return;
      }

      // 2. Query background to get or reconstruct fresh on-demand capsule
      chrome.runtime.sendMessage({ type: 'GET_OR_RECONSTRUCT_CAPSULE' }, (res) => {
        if (chrome.runtime.lastError) {
          console.warn('[Flowback] Background query failed:', chrome.runtime.lastError.message);
          renderEmpty('No saved context yet');
          return;
        }

        if (res && isValidCapsule(res.capsule)) {
          renderCaptured(res.capsule);
        } else {
          renderEmpty('No saved context yet');
        }
      });

    } catch (error) {
      console.warn('[Flowback] Failed to load capsule:', error);
      renderEmpty('Load failed');
    }
  }

  // --- Resume Work with Scroll Restoration ---

  async function handleResume() {
    if (!activeCapsule) {
      console.warn('[Flowback] No active capsule to resume');
      return;
    }

    if (els.resumeBtn) {
      els.resumeBtn.disabled = true;
      const textSpan = els.resumeBtn.querySelector('.btn-text');
      if (textSpan) textSpan.textContent = 'Restoring…';
    }

    showState(STATES.RESTORING);

    try {
      const capsule = activeCapsule;
      let tabExists = false;
      let tab = null;

      if (capsule.tabId) {
        try {
          tab = await chrome.tabs.get(capsule.tabId);
          tabExists = !!tab;
        } catch {
          tabExists = false;
        }
      }

      if (tabExists && tab) {
        // Activate existing tab and focus window
        if (tab.windowId) {
          try { await chrome.windows.update(tab.windowId, { focused: true }); } catch {}
        }
        await chrome.tabs.update(capsule.tabId, { active: true });

        // Restore scroll position
        if (capsule.scrollY || capsule.scrollX) {
          try {
            chrome.tabs.sendMessage(capsule.tabId, {
              type: 'RESTORE_SCROLL',
              scrollX: capsule.scrollX || 0,
              scrollY: capsule.scrollY || 0
            });
          } catch {}
        }

        showState(STATES.SUCCESS);

        // Safely clear capsule ONLY after success
        setTimeout(async () => {
          try {
            await removeStoredCapsule();
            activeCapsule = null;
          } catch (e) {
            console.warn('[Flowback] Failed to clear after restore:', e);
          }
        }, 800);

        return;
      }

      // Tab closed: open URL in new tab
      if (capsule.url) {
        const newTab = await chrome.tabs.create({ url: capsule.url, active: true });
        if (newTab.windowId) {
          try { await chrome.windows.update(newTab.windowId, { focused: true }); } catch {}
        }

        showState(STATES.SUCCESS);

        setTimeout(async () => {
          try {
            await removeStoredCapsule();
            activeCapsule = null;
          } catch {}
        }, 800);

        return;
      }

      throw new Error('No URL to restore');

    } catch (err) {
      console.error('[Flowback] Resume failed:', err);
      setText(els.errorTitle, "Couldn't restore workspace");
      setText(els.errorSubtext, err.message || 'Original tab was closed.');
      showState(STATES.ERROR);
      
      if (els.resumeBtn) {
        els.resumeBtn.disabled = false;
        const textSpan = els.resumeBtn.querySelector('.btn-text');
        if (textSpan) textSpan.textContent = 'Resume Work';
      }
    }
  }

  async function handleDismiss() {
    if (!activeCapsule) {
      renderEmpty();
      return;
    }

    try {
      await removeStoredCapsule();
      activeCapsule = null;
      renderEmpty('Dismissed');
    } catch (err) {
      console.warn('[Flowback] Failed to dismiss:', err);
      renderEmpty();
    }
  }

  async function handleOpenUrl() {
    if (!activeCapsule || !activeCapsule.url) {
      setText(els.errorSubtext, 'No URL saved in this context');
      return;
    }

    try {
      await chrome.tabs.create({ url: activeCapsule.url, active: true });
      showState(STATES.SUCCESS);
      setTimeout(async () => {
        try { await removeStoredCapsule(); } catch {}
      }, 500);
    } catch (err) {
      setText(els.errorSubtext, `Failed to open URL: ${err.message}`);
    }
  }

  function handleRetry() {
    if (activeCapsule) {
      renderCaptured(activeCapsule);
    } else {
      loadCapsule();
    }
  }

  function init() {
    els = getElements();

    if (els.resumeBtn) els.resumeBtn.addEventListener('click', handleResume);
    if (els.dismissBtn) els.dismissBtn.addEventListener('click', handleDismiss);
    if (els.retryBtn) els.retryBtn.addEventListener('click', handleRetry);
    if (els.openUrlBtn) els.openUrlBtn.addEventListener('click', handleOpenUrl);

    // Keyboard shortcuts
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && currentState === STATES.CAPTURED) {
        e.preventDefault();
        handleResume();
      } else if (e.key === 'Escape' && currentState === STATES.CAPTURED) {
        e.preventDefault();
        handleDismiss();
      }
    });

    loadCapsule();

    // Listen to storage changes
    if (chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === 'local' && changes[CAPSULE_KEY]) {
          const newCapsule = changes[CAPSULE_KEY].newValue;
          if (!newCapsule) {
            if (currentState === STATES.CAPTURED) {
              renderEmpty('Context cleared');
            }
            return;
          }

          if (isValidCapsule(newCapsule)) {
            if (currentState === STATES.EMPTY || currentState === STATES.CAPTURED) {
              renderCaptured(newCapsule);
            }
          }
        }
      });
    }

    console.log('[Flowback] Work-Context Recovery Popup initialized');
  }

  document.addEventListener('DOMContentLoaded', init);
})();



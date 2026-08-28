/**
 * Flowback — popup.js
 * Polished MVP: reliable storage, real resume, works without AI
 * Handles all UX states: empty, captured, restoring, success, error
 */

(function () {
  "use strict";

  const CAPSULE_KEY = "activeCapsule";
  const MAX_DISPLAY = 600;

  // UI States
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
      // Header
      statusBadge: document.getElementById('statusBadge'),
      statusText: document.querySelector('.status-text'),
      
      // States
      emptyState: document.getElementById('emptyState'),
      capturedState: document.getElementById('capturedState'),
      restoringState: document.getElementById('restoringState'),
      successState: document.getElementById('successState'),
      errorState: document.getElementById('errorState'),
      
      // Captured
      metaSite: document.getElementById('metaSite'),
      metaTime: document.getElementById('metaTime'),
      contextTitle: document.getElementById('contextTitle'),
      contextUrl: document.getElementById('contextUrl'),
      task: document.getElementById('task'),
      tried: document.getElementById('tried'),
      next: document.getElementById('next'),
      aiNotice: document.getElementById('aiNotice'),
      aiNoticeText: document.getElementById('aiNoticeText'),
      
      // Actions
      resumeBtn: document.getElementById('resumeBtn'),
      dismissBtn: document.getElementById('dismissBtn'),
      retryBtn: document.getElementById('retryBtn'),
      openUrlBtn: document.getElementById('openUrlBtn'),
      
      // Error
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

  function formatTimeSince(timestamp) {
    if (!timestamp) return 'Just now';
    const diff = Date.now() - timestamp;
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return 'Just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  function getDomain(url) {
    try {
      return new URL(url).hostname.replace('www.', '');
    } catch {
      return 'Web page';
    }
  }

  function isValidCapsule(capsule) {
    if (!capsule || typeof capsule !== 'object' || Array.isArray(capsule)) return false;
    
    // Check expiry (24h)
    if (capsule.capturedAt && (Date.now() - capsule.capturedAt > 24 * 60 * 60 * 1000)) {
      return false;
    }

    // Must have at least title or url or task
    const hasContent = [
      capsule.title,
      capsule.url,
      capsule.task,
      capsule.visibleText,
      capsule.selectedText
    ].some(v => typeof v === 'string' && v.trim().length > 0);

    return hasContent;
  }

  function isValidAI(ai) {
    return ai && typeof ai === 'object' &&
      typeof ai.task === 'string' && ai.task.trim() &&
      typeof ai.tried === 'string' && ai.tried.trim() &&
      typeof ai.next === 'string' && ai.next.trim();
  }

  function showState(state) {
    currentState = state;
    
    // Hide all
    if (els.emptyState) els.emptyState.hidden = true;
    if (els.capturedState) els.capturedState.hidden = true;
    if (els.restoringState) els.restoringState.hidden = true;
    if (els.successState) els.successState.hidden = true;
    if (els.errorState) els.errorState.hidden = true;

    // Show requested
    switch (state) {
      case STATES.EMPTY:
        if (els.emptyState) els.emptyState.hidden = false;
        setText(els.statusText, 'Ready');
        break;
      case STATES.CAPTURED:
        if (els.capturedState) els.capturedState.hidden = false;
        setText(els.statusText, 'Context captured');
        break;
      case STATES.RESTORING:
        if (els.restoringState) els.restoringState.hidden = false;
        setText(els.statusText, 'Restoring…');
        break;
      case STATES.SUCCESS:
        if (els.successState) els.successState.hidden = false;
        setText(els.statusText, 'Restored');
        break;
      case STATES.ERROR:
        if (els.errorState) els.errorState.hidden = false;
        setText(els.statusText, 'Error');
        break;
    }
  }

  function renderCaptured(capsule) {
    activeCapsule = capsule;

    // Meta
    const domain = getDomain(capsule.url);
    setText(els.metaSite, domain);
    setText(els.metaTime, formatTimeSince(capsule.capturedAt || capsule.createdAt));
    setText(els.contextTitle, normalizeText(capsule.title || capsule.task || 'Untitled', 80) || 'Working context');
    setText(els.contextUrl, normalizeText(capsule.url, 60) || 'No URL');

    // Task / Tried / Next - use direct fields (deterministic) or ai fallback
    const task = capsule.task || (capsule.ai && capsule.ai.task) || 'Working on webpage';
    const tried = capsule.tried || (capsule.ai && capsule.ai.tried) || 'Reviewed page content';
    const next = capsule.next || (capsule.ai && capsule.ai.next) || 'Resume where you left off';

    setText(els.task, normalizeText(task, MAX_DISPLAY));
    setText(els.tried, normalizeText(tried, MAX_DISPLAY));
    setText(els.next, normalizeText(next, MAX_DISPLAY));

    // AI notice handling
    if (els.aiNotice && els.aiNoticeText) {
      const source = capsule.source || 'deterministic';
      if (source === 'ai') {
        els.aiNotice.hidden = true;
      } else if (source === 'deterministic' || !capsule.ai) {
        // Check if AI was attempted but failed
        if (capsule.ai && capsule.ai.tried === 'AI reconstruction unavailable') {
          els.aiNotice.hidden = false;
          setText(els.aiNoticeText, 'Smart reconstruction unavailable. Using captured context.');
        } else {
          els.aiNotice.hidden = false;
          setText(els.aiNoticeText, 'Using captured context • Works without AI');
        }
      } else {
        els.aiNotice.hidden = true;
      }
    }

    // Enable resume button
    if (els.resumeBtn) {
      els.resumeBtn.disabled = false;
      els.resumeBtn.querySelector('.btn-text').textContent = 'Resume Work';
    }

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
      const capsule = await getStoredCapsule();
      console.log('[Flowback] Loaded capsule:', capsule ? { id: capsule.id, title: capsule.title?.slice(0, 30), hasTask: !!capsule.task } : null);
      
      if (!isValidCapsule(capsule)) {
        renderEmpty('No valid capsule');
        return;
      }

      renderCaptured(capsule);
    } catch (error) {
      console.warn('[Flowback] Failed to load capsule:', error);
      renderEmpty('Load failed');
    }
  }

  // --- Resume Logic - Real functionality ---

  async function handleResume() {
    if (!activeCapsule) {
      console.warn('[Flowback] No active capsule to resume');
      return;
    }

    if (els.resumeBtn) {
      els.resumeBtn.disabled = true;
      els.resumeBtn.querySelector('.btn-text').textContent = 'Restoring…';
    }

    showState(STATES.RESTORING);

    try {
      const capsule = activeCapsule;
      console.log('[Flowback] Attempting resume for:', { tabId: capsule.tabId, url: capsule.url });

      // 1. Check if tab still exists
      let tabExists = false;
      let tab = null;
      
      if (capsule.tabId) {
        try {
          tab = await chrome.tabs.get(capsule.tabId);
          tabExists = !!tab;
          console.log('[Flowback] Tab exists:', tabExists, tab ? { id: tab.id, url: tab.url?.slice(0, 50) } : null);
        } catch (e) {
          console.log('[Flowback] Tab does not exist:', e.message);
          tabExists = false;
        }
      }

      if (tabExists && tab) {
        // Tab exists: activate it and focus its window
        try {
          if (capsule.windowId && tab.windowId !== capsule.windowId) {
            await chrome.windows.update(capsule.windowId || tab.windowId, { focused: true });
          } else {
            await chrome.windows.update(tab.windowId, { focused: true });
          }
          await chrome.tabs.update(capsule.tabId, { active: true });
          
          console.log('[Flowback] Tab activated successfully');
          showState(STATES.SUCCESS);
          
          // Clear after successful restore (with small delay for UX)
          setTimeout(async () => {
            try {
              await removeStoredCapsule();
              activeCapsule = null;
            } catch (e) {
              console.warn('[Flowback] Failed to clear after restore:', e);
            }
          }, 800);
          
          return;
        } catch (activateErr) {
          console.warn('[Flowback] Failed to activate tab:', activateErr.message);
          // Fall through to open URL
        }
      }

      // 2. Tab doesn't exist or activation failed: open URL in new tab
      if (capsule.url) {
        try {
          console.log('[Flowback] Opening URL in new tab:', capsule.url);
          const newTab = await chrome.tabs.create({ url: capsule.url, active: true });
          
          // Focus window of new tab
          if (newTab.windowId) {
            try {
              await chrome.windows.update(newTab.windowId, { focused: true });
            } catch {}
          }
          
          console.log('[Flowback] New tab opened:', newTab.id);
          showState(STATES.SUCCESS);
          
          setTimeout(async () => {
            try {
              await removeStoredCapsule();
              activeCapsule = null;
            } catch {}
          }, 800);
          
          return;
        } catch (openErr) {
          console.error('[Flowback] Failed to open URL:', openErr);
          throw new Error(`Couldn't open URL: ${openErr.message}`);
        }
      }

      throw new Error('No URL to restore');

    } catch (err) {
      console.error('[Flowback] Resume failed:', err);
      setText(els.errorTitle, "Couldn't restore workspace");
      setText(els.errorSubtext, err.message.includes('No URL') ? 
        'No saved URL found. The context may be expired.' : 
        'The original tab might be closed. You can still open the URL.');
      showState(STATES.ERROR);
      
      if (els.resumeBtn) {
        els.resumeBtn.disabled = false;
        els.resumeBtn.querySelector('.btn-text').textContent = 'Resume Work';
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
      console.log('[Flowback] Capsule dismissed');
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
        try {
          await removeStoredCapsule();
        } catch {}
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

    // Bind actions
    if (els.resumeBtn) els.resumeBtn.addEventListener('click', handleResume);
    if (els.dismissBtn) els.dismissBtn.addEventListener('click', handleDismiss);
    if (els.retryBtn) els.retryBtn.addEventListener('click', handleRetry);
    if (els.openUrlBtn) els.openUrlBtn.addEventListener('click', handleOpenUrl);

    // Initial load
    loadCapsule();

    // Live updates when background saves new capsule
    if (chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === 'local' && changes[CAPSULE_KEY]) {
          const newCapsule = changes[CAPSULE_KEY].newValue;
          console.log('[Flowback] Storage changed, new capsule:', newCapsule ? 'present' : 'removed');
          
          if (!newCapsule) {
            // Capsule removed (e.g., after resume elsewhere)
            if (currentState === STATES.CAPTURED) {
              renderEmpty('Context cleared');
            }
            return;
          }

          if (isValidCapsule(newCapsule)) {
            // Only auto-update if we're in empty state or already showing a capsule
            // Don't interrupt restoring/success states
            if (currentState === STATES.EMPTY || currentState === STATES.CAPTURED) {
              renderCaptured(newCapsule);
            }
          }
        }
      });
    }

    console.log('[Flowback] Popup initialized, MVP works without AI');
  }

  document.addEventListener('DOMContentLoaded', init);
})();

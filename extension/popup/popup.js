/**
 * Flowback — popup.js
 * -------------------------------------------------------------
 * Reads the single, real interruption capsule saved by background.js.
 * Captured fields are displayed as raw context; AI reconstruction is
 * intentionally out of scope for this step.
 * -------------------------------------------------------------
 */

(function () {
  "use strict";

  const CAPSULE_STORAGE_KEY = "activeCapsule";
  const FALLBACK_NEXT = "AI reconstruction coming next.";
  const EMPTY_TITLE = "No saved context";
  const EMPTY_MESSAGE = "Flowback hasn't captured an interruption yet.";
  const SHARE_MESSAGE = "Team handoff is coming next.";
  const STORAGE_ERROR_MESSAGE = "Couldn't load saved context. Try opening Flowback again.";
  const REMOVE_ERROR_MESSAGE = "Context restored, but the saved context couldn't be cleared.";
  const SHARE_MESSAGE_DURATION_MS = 2500;
  const MAX_DISPLAY_LENGTH = 700;

  let els = null;
  let activeCapsule = null;
  let messageTimeoutId = null;
  let originalPrivacyText = "";

  function getElements() {
    return {
      task: document.getElementById("task"),
      tried: document.getElementById("tried"),
      next: document.getElementById("next"),
      resumeBtn: document.getElementById("resumeBtn"),
      shareBtn: document.getElementById("shareBtn"),
      heroTitle: document.querySelector(".hero-title"),
      heroSubtext: document.querySelector(".hero-subtext"),
      privacyNote: document.querySelector(".privacy-note"),
      statusText: document.querySelector(".status-text")
    };
  }

  function setText(el, value, fallback) {
    if (!el) return;
    const text = typeof value === "string" ? value.trim() : "";
    el.textContent = text || fallback;
  }

  function normalizeText(value, limit) {
    if (typeof value !== "string") return "";

    const text = value.replace(/\s+/g, " ").trim();
    if (!text) return "";

    return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
  }

  function isUsableCapsule(capsule) {
    if (!capsule || typeof capsule !== "object" || Array.isArray(capsule)) {
      return false;
    }

    return [
      capsule.title,
      capsule.url,
      capsule.selectedText,
      capsule.visibleText,
      capsule.focusedElement,
      capsule.inputContext
    ].some((value) => normalizeText(value, MAX_DISPLAY_LENGTH));
  }

  function getTaskText(capsule) {
    return normalizeText(capsule.selectedText, MAX_DISPLAY_LENGTH) ||
      normalizeText(capsule.title, MAX_DISPLAY_LENGTH) ||
      normalizeText(capsule.url, MAX_DISPLAY_LENGTH) ||
      "Captured page context";
  }

  function getTriedText(capsule) {
    return normalizeText(capsule.selectedText, MAX_DISPLAY_LENGTH) ||
      normalizeText(capsule.inputContext, MAX_DISPLAY_LENGTH) ||
      normalizeText(capsule.visibleText, MAX_DISPLAY_LENGTH) ||
      normalizeText(capsule.focusedElement, MAX_DISPLAY_LENGTH) ||
      "No additional captured context.";
  }

  function setResumeAvailable(isAvailable) {
    if (!els.resumeBtn) return;

    els.resumeBtn.disabled = !isAvailable;
    els.resumeBtn.textContent = isAvailable ? "Resume Work" : "No Context Saved";
    els.resumeBtn.setAttribute(
      "aria-label",
      isAvailable ? "Resume work" : "No saved context available to resume"
    );
  }

  function renderCapsule(capsule) {
    activeCapsule = capsule;

    setText(els.heroTitle, "Pick up where you left off.", EMPTY_TITLE);
    setText(els.heroSubtext, "Your train of thought is still here.", EMPTY_MESSAGE);
    setText(els.statusText, "Context preserved", "Context preserved");
    setText(els.task, getTaskText(capsule), "—");
    setText(els.tried, getTriedText(capsule), "—");
    setText(els.next, FALLBACK_NEXT, "—");
    setResumeAvailable(true);
  }

  function renderEmptyState(message) {
    activeCapsule = null;

    setText(els.heroTitle, EMPTY_TITLE, EMPTY_TITLE);
    setText(els.heroSubtext, message || EMPTY_MESSAGE, EMPTY_MESSAGE);
    setText(els.statusText, "No saved context", "No saved context");
    setText(els.task, EMPTY_TITLE, "—");
    setText(els.tried, message || EMPTY_MESSAGE, "—");
    setText(els.next, "—", "—");
    setResumeAvailable(false);
  }

  function getStoredCapsule() {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(CAPSULE_STORAGE_KEY, (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        resolve(result ? result[CAPSULE_STORAGE_KEY] : null);
      });
    });
  }

  function removeStoredCapsule() {
    return new Promise((resolve, reject) => {
      chrome.storage.local.remove(CAPSULE_STORAGE_KEY, () => {
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

      if (!isUsableCapsule(capsule)) {
        renderEmptyState();
        return;
      }

      renderCapsule(capsule);
    } catch (error) {
      console.warn("[Flowback] Failed to load activeCapsule:", error);
      renderEmptyState(STORAGE_ERROR_MESSAGE);
    }
  }

  function renderResumeSuccess() {
    setText(els.heroTitle, "Context restored.", "Context restored.");
    setText(
      els.heroSubtext,
      "You're back where you left off.",
      "You're back where you left off."
    );

    if (els.resumeBtn) {
      els.resumeBtn.disabled = true;
      els.resumeBtn.textContent = "Resumed";
      els.resumeBtn.classList.add("is-complete");
      els.resumeBtn.setAttribute("aria-label", "Context resumed");
    }
  }

  async function handleResume() {
    if (!activeCapsule || !els.resumeBtn || els.resumeBtn.disabled) return;

    // Only a deliberate Resume Work action can remove the active capsule.
    renderResumeSuccess();

    try {
      await removeStoredCapsule();
      activeCapsule = null;
    } catch (error) {
      console.warn("[Flowback] Failed to remove activeCapsule:", error);
      showTransientMessage(REMOVE_ERROR_MESSAGE);
    }
  }

  function showTransientMessage(message) {
    if (!els.privacyNote) return;

    if (messageTimeoutId === null) {
      originalPrivacyText = els.privacyNote.textContent;
    } else {
      clearTimeout(messageTimeoutId);
    }

    els.privacyNote.textContent = message;

    messageTimeoutId = setTimeout(() => {
      setText(els.privacyNote, originalPrivacyText, "");
      messageTimeoutId = null;
    }, SHARE_MESSAGE_DURATION_MS);
  }

  function handleShare() {
    showTransientMessage(SHARE_MESSAGE);
  }

  function init() {
    els = getElements();

    if (els.privacyNote) {
      els.privacyNote.setAttribute("aria-live", "polite");
    }

    if (els.resumeBtn) {
      els.resumeBtn.addEventListener("click", handleResume);
    }

    if (els.shareBtn) {
      els.shareBtn.addEventListener("click", handleShare);
    }

    loadCapsule();
  }

  document.addEventListener("DOMContentLoaded", init);
})();

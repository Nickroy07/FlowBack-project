/**
 * Flowback — popup.js
 * -------------------------------------------------------------
 * Makes the existing popup interactive using mock data.
 *
 * loadMockCapsule() returns a Promise<{ task, tried, next }> on
 * purpose — when the storage step is built, only its internals
 * change (swap in chrome.storage.local.get). Every caller stays
 * the same.
 * -------------------------------------------------------------
 */

(function () {
  "use strict";

  const MOCK_CAPSULE = {
    task: "Debugging the authentication API",
    tried: "Checked the JWT token and authorization header.",
    next: "Inspect the authentication middleware."
  };

  const SHARE_MESSAGE = "Team handoff is coming next.";
  const SHARE_MESSAGE_DURATION_MS = 2500;

  let els = null;
  let shareMessageTimeoutId = null;
  let originalPrivacyText = "";

  // ---- DOM lookup (cached once in init, checked before every use) ----

  function getElements() {
    return {
      task: document.getElementById("task"),
      tried: document.getElementById("tried"),
      next: document.getElementById("next"),
      resumeBtn: document.getElementById("resumeBtn"),
      shareBtn: document.getElementById("shareBtn"),
      heroTitle: document.querySelector(".hero-title"),
      heroSubtext: document.querySelector(".hero-subtext"),
      privacyNote: document.querySelector(".privacy-note")
    };
  }

  // ---- Data ----

  function loadMockCapsule() {
    // TODO(storage step): replace this with chrome.storage.local.get(...)
    // and resolve the same { task, tried, next } shape.
    return Promise.resolve({ ...MOCK_CAPSULE });
  }

  // ---- Rendering ----

  function setText(el, value) {
    if (!el) return;
    el.textContent = value && String(value).trim() ? value : "—";
  }

  function renderCapsule(capsule) {
    if (!capsule) return;
    setText(els.task, capsule.task);
    setText(els.tried, capsule.tried);
    setText(els.next, capsule.next);
  }

  // ---- Resume Work ----

  function handleResume() {
    if (!els.resumeBtn || els.resumeBtn.disabled) return;

    // TODO(storage step): clear the saved capsule from chrome.storage.local
    // here once real storage is wired up. Mock data only for now.

    setText(els.heroTitle, "Context restored.");
    setText(els.heroSubtext, "You're back where you left off.");

    els.resumeBtn.disabled = true;
    els.resumeBtn.textContent = "Resumed";
    els.resumeBtn.classList.add("is-complete");
    els.resumeBtn.setAttribute("aria-label", "Context resumed");
  }

  // ---- Share With Teammate ----

  function handleShare() {
    if (!els.shareBtn || !els.privacyNote) return;

    if (shareMessageTimeoutId === null) {
      originalPrivacyText = els.privacyNote.textContent;
    } else {
      clearTimeout(shareMessageTimeoutId);
    }

    els.privacyNote.textContent = SHARE_MESSAGE;

    shareMessageTimeoutId = setTimeout(() => {
      setText(els.privacyNote, originalPrivacyText);
      shareMessageTimeoutId = null;
    }, SHARE_MESSAGE_DURATION_MS);
  }

  // ---- Init ----

  function init() {
    els = getElements();

    if (els.privacyNote) {
      els.privacyNote.setAttribute("aria-live", "polite");
    }

    loadMockCapsule()
      .then(renderCapsule)
      .catch((err) => {
        console.log("[Flowback] Failed to load capsule:", err && err.message);
      });

    if (els.resumeBtn) {
      els.resumeBtn.addEventListener("click", handleResume);
    } else {
      console.log("[Flowback] resumeBtn not found in popup.html");
    }

    if (els.shareBtn) {
      els.shareBtn.addEventListener("click", handleShare);
    } else {
      console.log("[Flowback] shareBtn not found in popup.html");
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();

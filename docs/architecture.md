# Flowback Architecture — Final MVP (Works Without AI)

## Overview
Flowback is Chrome Extension + Node.js backend that captures working context on meaningful interruptions (>10s) and helps resume. Core MVP works **without AI** via deterministic reconstruction. AI is optional enhancement.

## Core Flow (Must Work Without AI)
```
User Working in Tab A
  ↓ records working context (tabId, windowId, lastActiveAt)
User leaves Tab A → Tab B or other app
  ↓ sets awayTimestamp, interruptionPending=true
User remains away >=10s
User returns to Tab A
  ↓ duration = now - awayTimestamp >= threshold
  ↓ background → content.js: CAPTURE_CONTEXT
  ↓ content.js captures title, url, visibleText, selectedText, input, headings
  ↓ background builds capsule with deterministic task/tried/next immediately
  ↓ saves to chrome.storage.local (activeCapsule) - core works
  ↓ tries backend AI optionally (8s timeout) - enriches if success
  ↓ popup detects saved context via storage.local
  ↓ displays polished card with task/tried/next, site, time
User clicks Resume Work
  ↓ checks if tabId exists
  ↓ if exists: focus window + activate tab
  ↓ if not: open url in new tab
  ↓ success → clear capsule after 800ms
  ↓ error → show error, keep context, allow retry/open URL
```

## Components

### Extension Manifest (MV3)
- permissions: storage, tabs, windows (only necessary)
- host_permissions: <all_urls> (for content script + backend fetch)
- background.service_worker: background.js
- action.default_popup: popup/popup.html
- content_scripts: <all_urls>, run_at document_idle, js content.js

### background.js — Robust Interruption Engine
- **State:** storage.session (survives SW suspend, cleared on browser close) for ephemeral: workingTabId, workingWindowId, currentTabId, currentWindowId, awayTimestamp, interruptionPending, lastActiveAt
- **Capsule:** storage.local for activeCapsule (persisted, survives restart)
- **Threshold:** INTERRUPTION_THRESHOLD_MS=10000, configurable constant
- **Leave:** tabs.onActivated to other tab, windows.onFocusChanged to NONE or other window → handleLeave sets awayTimestamp if not already pending
- **Return:** tabs.onActivated to workingTabId or windows.onFocusChanged back to working window → handleReturn checks duration, if >=10s calls requestContextCapture
- **Capture:** requestContextCapture sends CAPTURE_CONTEXT to content.js, with fallback to chrome.tabs.get if content script not reachable (fixes "No saved context" bug)
- **Capsule structure:**
  ```js
  { id, tabId, windowId, url, title, capturedAt, lastActiveAt, interruptedAt, durationAway,
    visibleText, selectedText, focusedElement, inputContext,
    task, tried, next, // deterministic core always present
    source, status, // 'content-script' | 'deterministic' | 'ai'
    ai: {task,tried,next}|null }
  ```
- **Deterministic reconstruction:** deterministicReconstruct() builds task from selected/title/url, tried from input/selected/focused, next generic resume - no AI needed
- **AI optional:** fetchAIReconstruction tries POST localhost:3000/api/reconstruct with 8s timeout, returns deterministic on failure, always saves capsule even if backend down
- **Expiry:** 24h cleanup on startup
- **No timers, no memory leaks:** timestamps only

### content.js — Useful Context Capture
- Reactive only, no continuous monitoring
- Captures: title, url, selectedText (1500), visibleText (4000, prefers article/main), headings (h1-h3), focusedElement descriptor, inputContext (1000, sensitive filtered)
- Sensitive filtering: password fields, cc, ssn, etc redacted
- Returns context via sendResponse, keeps channel open (return true)
- Logs only metadata length, not raw content

### popup/ — Polished Hackathon UI
- **HTML:** Header with brand + status badge, empty state, captured state, restoring, success, error
- **CSS:** Modern design tokens, dark theme, cards, shadows, hover/active/disabled states, animations, responsive at 400px, no external resources
- **JS:**
  - Same CAPSULE_KEY = activeCapsule
  - isValidCapsule checks expiry, hasContent (title/url/task/visible/selected)
  - Shows all states: EMPTY ("No saved context yet"), CAPTURED (title, site, time, url, task/tried/next, AI notice), RESTORING (spinner), SUCCESS (welcome back), ERROR (retry/open URL)
  - Real resume: chrome.tabs.get to check exists, windows.update + tabs.update to activate, or tabs.create to open URL, clear only after success
  - Dismiss clears capsule
  - Live updates via storage.onChanged
  - Works without AI, shows notice "Using captured context" when deterministic

### Backend — Optional AI, Core Works Without
- **server.js:**
  - GET /health → {status, aiConfigured, provider, model, mode, message} - no secrets
  - GET / → info
  - POST /api/reconstruct → Always 200 with {task,tried,next,source,aiUsed} even without AI
    - Validates via validateAndSanitizeContext
    - If empty → "Not enough context."
    - Calls reconstructContext which tries AI if configured, else deterministic
    - On AI 429/quota/auth/timeout → deterministic fallback, not error
    - Never crashes, never exposes keys, discards data, 100kb limit
- **ai.js:**
  - getConfig() fresh each call
  - isAIConfigured checks API key not placeholder
  - reconstructContext tries fetch with timeout, on any failure returns deterministicReconstruct
  - Handles 429 specifically as quota exceeded → fallback
- **ai/context.js:**
  - validateAndSanitizeContext, truncate, redaction
  - deterministicReconstruct: core MVP that builds task/tried/next from raw context without AI
- **ai/prompt.js:** System prompt for optional AI, fallback constant

## Privacy & Security
- No raw content logged, only metadata
- URL sanitization removes query/hash
- Sensitive field filtering
- .env gitignored, .env.example tracked, no secrets in repo
- API key server-side only
- No Firebase, no analytics, no history per MVP

## Failure Handling
- Content script not reachable → fallback to tab info (fixes "No saved context")
- Backend down → deterministic fallback in background.js, capsule still saved
- AI 429/quota → deterministic fallback, UI notice, not broken
- Empty context → "Not enough context."
- Long text → truncated
- Corrupted storage → isValidCapsule fails, shows empty, not crash
- Tab closed → resume opens URL in new tab
- SW restart → state from storage.session, capsule from storage.local

## MVP Scope
- ✅ Interruption detection (10s, timestamp-based, robust)
- ✅ Context capture (useful, privacy-safe)
- ✅ Reliable storage (single capsule, same key/structure)
- ✅ Popup display (polished, all states)
- ✅ Resume (real activation/open)
- ✅ Works without AI (deterministic fallback)
- ✅ Backend optional AI with graceful fallback
- ❌ Firebase, team sharing, auth, accounts, analytics, history (out of scope)

## Why Previous Bug "No saved context" Happened
- Content script not reachable on some pages or timing, requestContextCapture failed silently, no fallback, no capsule saved
- Fixed by adding fallback to chrome.tabs.get in background.js
- Also isUsableCapsule was strict, now isValidCapsule more permissive with expiry check
- Also background.js now saves deterministic capsule immediately before AI, so even if AI fails or SW suspends, capsule exists

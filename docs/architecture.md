# Flowback Architecture

## Overview
Flowback is a Chrome Extension that detects interruptions (user away >10s) and helps resume work via AI-reconstructed working memory.

## Flow
```
User working on webpage
        ↓
Interruption detection (background.js)
 - Tracks working tab via chrome.storage.session (survives service worker suspend)
 - Detects leave via tabs.onActivated + windows.onFocusChanged
 - Timestamps, not timers, decide interruption (10s threshold)
        ↓
User returns after 10+ seconds
        ↓
background.js → content.js: CAPTURE_CONTEXT
        ↓
content.js captures:
 - title
 - url (sanitized)
 - selectedText
 - visibleText (max 4000 chars, prefers article/main)
 - focusedElement descriptor
 - inputContext (max 1000, sensitive fields filtered)
        ↓
background.js builds activeCapsule
 - id, createdAt, tabId, title, url, selectedText, visibleText, focusedElement, inputContext
 - Saves raw capsule immediately to chrome.storage.local
        ↓
background.js → backend /api/reconstruct
 - Sends truncated context (privacy + cost control)
 - Timeout 10s, validates response
 - On success: enriches capsule with ai: {task, tried, next}
 - On failure: enriches with fallback AI
 - Only one activeCapsule exists (overwrites)
        ↓
popup.js displays capsule
 - If ai exists: TASK→ai.task, TRIED→ai.tried, NEXT→ai.next
 - Else: raw context fallback
 - Listens to storage.onChanged for live AI update
        ↓
User clicks Resume Work → capsule removed
```

## Components

### Extension
- **manifest.json**: MV3, permissions storage/tabs/windows, host <all_urls>, content_scripts <all_urls>
- **background.js**: Service worker, interruption detection engine + AI integration, no in-memory timers, uses chrome.storage.session as source of truth
- **content.js**: Reactive only, captures context on CAPTURE_CONTEXT message, no AI, no storage, no external requests
- **popup/**: Displays single activeCapsule, supports AI + fallback

### Backend
- **backend/server.js**: Express, CORS, 100kb JSON limit, 15s request timeout, no permanent storage, discards request data
- **backend/ai.js**: AI provider integration, OpenAI-compatible, configurable via env, strict timeout 12s, robust JSON parsing, validation
- **ai/prompt.js**: Strict system prompt, working-context reconstruction engine, rules: no markdown, no hallucination, max ~20 words, "Not enough context." fallback
- **ai/context.js**: Validation, sanitization, truncation, sensitive data redaction, prompt building

### Privacy
- Raw webpage content never permanently stored on backend
- Backend: receive → AI → return → discard
- No user history, analytics, databases
- Console logs never contain passwords, payment data, full page contents
- content.js filters sensitive fields (password, credit card, etc)
- URL sanitization removes query params and hash
- .env never committed

### Security
- AI_API_KEY never in extension code, manifest, popup, content
- Backend validates incoming data, limits context size
- Request timeout (10s extension, 12s backend, 15s server)
- Handles API failures gracefully, fallback AI
- CORS enabled for extension origins
- .env in .gitignore

## Capsule Storage
```js
{
  id,
  createdAt,
  tabId,
  title,
  url,
  selectedText,
  visibleText,
  focusedElement,
  inputContext,
  ai: {
    task,
    tried,
    next
  }
}
```
- Only one activeCapsule in chrome.storage.local
- Raw context remains for debugging
- ai field optional, added after backend success
- Overwrites on new interruption (no history per MVP)

## Failure Handling
- Backend down / timeout → fallback AI: "Captured context available" / "AI reconstruction unavailable" / "Resume from your captured context"
- Empty context → AI returns "Not enough context."
- Long text → truncated before AI call
- Malformed AI JSON → regex extraction fallback, then fallback AI
- Missing API key → 503 with fallback, extension handles
- Extension remains usable without AI (raw fallback)

## MVP Scope (Hackathon)
- ✅ Interruption detection
- ✅ Context capture
- ✅ AI reconstruction
- ✅ Resume card
- ❌ Firebase, teammate sharing, auth, accounts, analytics, databases, history (explicitly out of scope)

# Flowback — Context Recovery for Interrupted Work

> When you get interrupted, Flowback captures your train of thought and helps you resume instantly. Works beautifully **without AI** — AI is optional enhancement.

Built for **iQOO Hackathon 2026, Productivity theme**.

## The Problem
You get interrupted while working. You switch tabs, answer Slack, check email. 30 seconds later you return: *"What was I doing?"* — you lost your flow.

## The Solution
Flowback detects meaningful interruptions (>10s away), captures working context (title, URL, visible text, selection, input), and shows a polished Resume Card.

```
User Working → Leaves Tab → Away >10s → Capture Context → Returns → Popup → Resume
```

Core MVP works **without AI** via deterministic reconstruction. AI optionally enhances TASK/TRIED/NEXT.

## Architecture

### Extension (MV3)
- **manifest.json**: permissions `storage`, `tabs`, `windows`, host `<all_urls>`, content script `<all_urls>`
- **background.js**: Service worker, interruption detection engine
  - Uses `chrome.storage.session` for ephemeral state (survives SW suspend)
  - Uses `chrome.storage.local` for `activeCapsule` (persisted, survives restart)
  - Timestamps, not timers, decide interruption (robust against SW suspend)
  - Captures on return after threshold, with fallback to tab info if content script fails
  - Saves deterministic `task/tried/next` immediately, tries AI optionally
  - Only one capsule, 24h expiry, no sensitive data
- **content.js**: Reactive only, captures on `CAPTURE_CONTEXT` message
  - Title, URL, selectedText, visibleText (4000 chars, prefers article/main), headings, focused element, inputContext (1000 chars)
  - Filters sensitive fields (password, credit card, etc)
  - No AI, no storage, no external requests
- **popup/**: Polished UI, works without AI
  - Displays saved context, handles all states: empty, captured, restoring, success, error
  - Real resume: activates existing tab or opens URL in new tab
  - Live updates via `storage.onChanged`

### Backend (Node.js + Express)
- **server.js**: 
  - `GET /health` → `{status, aiConfigured, provider, model, mode}`
  - `POST /api/reconstruct` → Always returns 200 with `{task, tried, next}` even without AI
  - Deterministic fallback when AI unavailable, 429, auth error, timeout
  - No permanent storage, discards request data, 100kb limit, 15s timeout
  - Privacy: never logs raw content
- **ai.js**: AI provider integration, OpenAI-compatible, optional
  - `isAIConfigured()` checks `AI_API_KEY`
  - On 429/quota, auth fail, timeout, malformed JSON → deterministic fallback
  - Core works without AI

### Capsule Structure
```js
{
  id, tabId, windowId,
  url, title,
  capturedAt, lastActiveAt, interruptedAt, durationAway,
  visibleText, selectedText, focusedElement, inputContext,
  task, tried, next,        // deterministic core - always present
  source, status,            // 'content-script' | 'ai' | 'deterministic'
  ai: { task, tried, next } | null  // optional enhancement
}
```
- One `activeCapsule` in `chrome.storage.local`
- Same key and structure in background and popup
- Handles missing/corrupted/expired storage, duplicate interruptions, quick tab switches, SW restart

## Installation

### Backend
```bash
cd backend
npm install
cp .env.example .env
# Edit .env (optional - core works without AI):
# AI_API_KEY=sk-...  # Optional, only server-side, never in extension
# AI_PROVIDER=openai
# AI_MODEL=gpt-4o-mini
# AI_API_URL=https://api.openai.com/v1/chat/completions
npm start
# → http://localhost:3000
# → Health: http://localhost:3000/health
```

**AI Providers (any OpenAI-compatible, optional):**
- OpenAI, Groq, OpenRouter, Together, Local Ollama
- Core MVP works without any key - deterministic fallback

### Extension
1. Chrome → `chrome://extensions` → Developer Mode ON
2. Load unpacked → select `extension/` folder
3. Pin Flowback

## How to Load/Reload Extension in Chrome
- Load: `chrome://extensions` → Load unpacked → `extension/`
- Reload after changes: `chrome://extensions` → Flowback → Reload icon (↻)
- View service worker logs: Flowback → Service Worker → Inspect → Console
- View popup logs: Right-click popup → Inspect

## How to Run Backend
```bash
cd backend
npm install
npm start        # PORT 3000 default
npm run dev      # watch mode
npm test         # run tests
```

Health check:
```bash
curl http://localhost:3000/health
# {"status":"ok","aiConfigured":false,"provider":"openai","model":"gpt-4o-mini","mode":"deterministic",...}

curl -X POST http://localhost:3000/api/reconstruct \
  -H "Content-Type: application/json" \
  -d '{"title":"GitHub Issue","url":"https://github.com/...","selectedText":"fix bug"}'
# Always 200 with task/tried/next even without AI
```

## How Interruption Detection Works
- **Threshold:** `INTERRUPTION_THRESHOLD_MS = 10000` (10s), configurable constant
- **Tracks:** workingTabId, currentTabId, awayTimestamp, interruptionPending in `storage.session`
- **Leave:** On `tabs.onActivated` to other tab, or `windows.onFocusChanged` to other app/window, set `awayTimestamp` if not already pending
- **Return:** On activation of workingTabId, check duration = now - awayTimestamp
  - If >=10s → capture context via `CAPTURE_CONTEXT` message to content.js
  - If <10s → no capture (quick switch)
- **Robustness:** Timestamps not timers (survives SW suspend), handles tab close, reload, startup, multiple windows, quick switches, no memory leaks

## How Context Capture Works
- **Trigger:** Background sends `CAPTURE_CONTEXT` to content.js after confirmed interruption
- **Content.js captures:**
  - Title, URL, selectedText (1500 chars), visibleText (4000 chars, prefers article/main), headings, focusedElement, inputContext (1000 chars, sensitive filtered)
  - Limits to reasonable max, no passwords, cookies, tokens
- **Fallback:** If content script not reachable (restricted page, not injected), background uses `chrome.tabs.get` for title/URL
- **Deterministic reconstruction:** Background builds `task/tried/next` from raw context immediately (works without AI)
- **Optional AI:** Background tries `POST localhost:3000/api/reconstruct` with 8s timeout, enriches capsule if success, else keeps deterministic

## How Resume Works
When user clicks **Resume Work** in popup:
1. Check if `tabId` still exists via `chrome.tabs.get`
2. If exists: focus its window (`windows.update`) and activate tab (`tabs.update`)
3. If not exists: open `url` in new tab (`tabs.create`)
4. Show success state "Welcome back. Your workspace is ready."
5. Clear capsule only AFTER successful restore (800ms delay for UX)
6. If fails: show error "Couldn't restore workspace" with Try Again / Open URL options, do NOT silently delete context

## AI is Optional
- **AI available:** Backend tries OpenAI (or compatible), returns AI-enhanced task/tried/next
- **AI unavailable:** Deterministic fallback using captured context (core MVP)
- **429 quota:** Gracefully falls back, UI shows "Using captured context" notice, never breaks
- **Auth error/timeout:** Same fallback
- **UI:** Never shows technical errors like "AI API error 429" to normal users; shows "Smart reconstruction unavailable. Using captured context."
- **Security:** API key only in backend `.env`, never in extension, never logged, never committed

## Troubleshooting

**Popup shows "No saved context":**
- No interruption yet: Work in tab → Switch away >10s → Return → Check SW logs for "Context captured" → Open popup
- Content script not injected: Check page is not `chrome://`, `about:`, `devtools://` (ignored)
- Storage cleared: Check `chrome.storage.local.get('activeCapsule')` in popup console
- Expired: Capsule expires after 24h

**Interruption not detected:**
- Must be >10s away (not 5s)
- Must return to same working tab (not new tab)
- Check SW logs: `chrome://extensions` → Flowback → Service Worker → Inspect
- Ensure working tab not closed

**Resume fails:**
- Check if URL is valid
- Try Open URL button
- Check console for errors

**Backend not working:**
- Check Node >=18: `node --version`
- Check port 3000 free: `curl http://localhost:3000/health`
- Core works without backend: deterministic fallback in background.js

**AI 429/quota:**
- Expected if no billing, core still works
- Backend logs "Quota exceeded (429), using deterministic fallback"
- UI shows captured context, not broken

## Security Notes
- **Never commit:** `.env`, API keys, Firebase credentials, tokens
- **.gitignore:** Includes `.env`, `.env.*`, `!.env.example`, `node_modules/`, `backend/.env`
- **No secrets in tracked files:** Verified via `git diff`, `git ls-files | grep env` only shows `.env.example`
- **No sensitive capture:** content.js filters password fields, credit cards, etc
- **URL sanitization:** Removes query params and hash
- **No raw logging:** Backend and extension never log full page content, passwords, payment data
- **API key server-side only:** Only in backend `.env`, never in manifest, popup, content

## Tests

**Backend:**
```bash
cd backend
npm test
# Tests: empty context, normal, long text truncation, sensitive redaction, AI validation,
# prompt building, system prompt, fallback, deterministic reconstruction, health, reconstruct without AI,
# invalid requests, AI 429 handling
```

**Manual (from spec):**
- TEST A: Open working page, switch tab <10s, return → No capsule (expected)
- TEST B: Open working page, switch tab >10s, return → Context captured (expected)
- TEST C: Open popup → Saved context displayed (expected)
- TEST D: Click Resume → Original tab activated or URL reopened (expected)
- TEST E: Close original tab, click Resume → URL opens in new tab (expected)
- TEST F: Disable AI / stop backend → Still works with fallback (expected)

## Project Structure
```
FlowBack-project/
├── extension/
│   ├── manifest.json
│   ├── background.js      # Robust interruption + reliable storage + deterministic + optional AI
│   ├── content.js         # Useful context capture, privacy-safe
│   └── popup/
│       ├── popup.html     # Polished MVP UI
│       ├── popup.css      # Modern productivity design
│       └── popup.js       # Real resume, all states, works without AI
├── backend/
│   ├── server.js          # Always returns task/tried/next, AI optional
│   ├── ai.js              # Optional AI, 429 fallback to deterministic
│   ├── package.json
│   ├── .env.example
│   └── test.js
├── ai/
│   ├── prompt.js
│   └── context.js         # Validation + deterministicReconstruct
├── docs/
│   ├── architecture.md
│   └── demo.md
└── README.md
```

## Limitations
- Only one active capsule (no history) per MVP
- Threshold fixed at 10s (configurable constant)
- Content script not on chrome://, about:, devtools:// (expected)
- Backend must run on localhost:3000 for AI enhancement, but core works without it
- No sync across devices (local only)
- No team sharing (out of MVP scope)

## License
Hackathon project - iQOO Hackathon 2026

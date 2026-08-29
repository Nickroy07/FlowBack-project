# Flowback Demo & Testing Guide — Final MVP (Works Without AI)

## Quick Start (Core Works Without AI)

### Backend (Optional - Core Works Without It)
```bash
cd backend
npm install
# Optional: cp .env.example .env and set AI_API_KEY for AI enhancement
# Core works without .env - deterministic mode
npm start
# → http://localhost:3000
# → Health: http://localhost:3000/health
# If AI configured: "AI reconstruction enabled"
# If not: "Running deterministic mode (core works without AI)"
```

### Extension
1. Chrome → `chrome://extensions` → Developer Mode ON
2. Load unpacked → select `extension/` folder
3. Pin Flowback
4. Check service worker logs: Flowback → Service Worker → Inspect

## Manual Tests (From Spec)

### TEST A: Quick Switch (<10s) → No Capsule
1. Open working page (e.g., GitHub issue, Stack Overflow, docs)
2. Switch to another tab
3. Wait **less than 10 seconds** (e.g., 5s)
4. Return to original tab
5. Open Flowback popup
**Expected:** No saved context yet (empty state) - short navigation not considered interruption

### TEST B: Real Interruption (>10s) → Captured
1. Open working page, select some text, type in input (simulate work)
2. Switch to another tab or other app (e.g., Slack)
3. Wait **more than 10 seconds** (e.g., 12s)
4. Return to original tab
5. Check SW logs: should see "Interruption confirmed" and "Capsule saved (deterministic)"
6. Open popup
**Expected:** Context captured card with title, site, time, task/tried/next, Resume button

### TEST C: Popup Display
1. After TEST B, open popup
**Expected:** Saved context displayed with:
- Site domain and time since (e.g., "github.com • 2m ago")
- Title
- URL (sanitized)
- TASK: what you were working on (deterministic from title/selected)
- TRIED: what you attempted (from input/selected)
- NEXT: next action
- Notice "Using captured context • Works without AI" if AI unavailable

### TEST D: Resume - Tab Exists
1. After TEST B, with original tab still open, click Resume Work in popup
**Expected:**
- Popup shows "Restoring your workspace…" then "Welcome back"
- Original tab activated and window focused
- Capsule cleared after 800ms
- Reopen popup → "No saved context yet"

### TEST E: Resume - Tab Closed → Open URL
1. Do TEST B to capture context
2. Close original tab (the working tab)
3. Open popup (should still show captured context, tabId exists but tab closed)
4. Click Resume Work
**Expected:**
- New tab opens with saved URL
- Success state
- Capsule cleared

### TEST F: AI Failure → Still Works
1. Stop backend (`Ctrl+C`) or set invalid API key
2. Do TEST B (interruption >10s, return)
3. Open popup
**Expected:**
- Context captured card still shows (deterministic fallback)
- Notice "Smart reconstruction unavailable. Using captured context" or "Using captured context • Works without AI"
- Resume still works
- Core product works beautifully without AI

### Additional Edge Tests
- **Empty context:** Open `about:blank`, try interruption → should show "Not enough context" or fallback
- **Long page:** Wikipedia long article → visibleText truncated to 4000, still captures
- **Restricted page:** `chrome://extensions` → content script not injected, fallback to tab info, still saves capsule with title/URL (not "No saved context")
- **Quick tab switches:** A→B→C quickly <10s → no capsule
- **Multiple windows:** Switch to other Chrome window >10s → interruption detected
- **Dismiss:** Capture, then Dismiss button → capsule cleared, empty state
- **Expired:** Capsule older than 24h auto-cleared on startup

## Backend Tests

```bash
cd backend
npm test
```

Tests cover:
- Empty context → valid, no content, deterministic returns "Not enough context"
- Normal context → valid, hasContent, deterministic produces task/tried/next
- Long text truncation → visibleText <=4000
- Sensitive redaction → password redacted
- AI validation → valid/invalid cases
- Prompt building
- System prompt rules
- Fallback AI constants
- Deterministic reconstruction without AI (core MVP)
- Health endpoint (if running)
- Reconstruct endpoint without AI → always 200 with task/tried/next
- Invalid request handling (null, string, array)

## Backend Manual Tests

```bash
# Health - always works, reports aiConfigured false if no key
curl http://localhost:3000/health
# {"status":"ok","aiConfigured":false,"mode":"deterministic",...}

# Root
curl http://localhost:3000/

# Reconstruct without AI - should return 200 with deterministic
curl -X POST http://localhost:3000/api/reconstruct \
  -H "Content-Type: application/json" \
  -d '{"title":"GitHub Issue","url":"https://github.com/user/repo","selectedText":"fix bug"}'
# → {"task":"...","tried":"...","next":"...","source":"deterministic","aiUsed":false}

# Reconstruct empty
curl -X POST http://localhost:3000/api/reconstruct \
  -H "Content-Type: application/json" \
  -d '{}'
# → {"task":"Not enough context.",...}

# With AI configured but quota 429 - should still return 200 with deterministic fallback
# (Backend logs "Quota exceeded (429), using deterministic fallback")
```

## Troubleshooting

**No saved context after real interruption:**
- Fixed in final version: fallback to tab info when content script fails
- Check SW logs for "Capsule saved (deterministic)"
- Check storage: popup console → `chrome.storage.local.get('activeCapsule', c => console.log(c))`
- Ensure page not ignored (chrome://, about:, devtools://)
- Ensure >10s away, return to same tab

**Popup shows "Context restored" unexpectedly:**
- That's success state after Resume clicked
- If you see it without clicking Resume, may be stale state - reload extension

**Resume doesn't activate tab:**
- Check if tab still exists
- Try Open URL button in error state
- Check console for errors

**Backend 429:**
- Expected without billing, core still works
- Deterministic fallback active, not broken

**Extension not capturing:**
- Reload extension after changes
- Check content.js injected: page console → should not have errors
- Check manifest permissions: storage, tabs, windows, <all_urls>

## Demo Video Script (Polished MVP)
1. Problem: "You get interrupted, you lose your train of thought"
2. Show Flowback installed, backend running in deterministic mode (no AI needed)
3. Work on GitHub issue, select text, type comment
4. Switch to Slack/email for 12 seconds
5. Return → SW logs show capture
6. Open popup → polished card: "Context captured", site, time, task/tried/next, Resume button
7. Click Resume → tab activated, success "Welcome back"
8. Show fallback: stop backend, repeat interruption → still works, notice "Using captured context • Works without AI"
9. Show privacy: local only, temporary, no history
10. Show that AI is optional enhancement, not required

## Security Check
```bash
git diff
git ls-files | grep env  # should only show .env.example
cat .gitignore | grep env
# Should include .env, .env.*, !.env.example
# No API keys in tracked files
```

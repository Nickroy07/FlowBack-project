# Flowback Demo Guide

## Quick Start (5 minutes)

### 1. Backend Setup
```bash
cd backend
npm install
cp .env.example .env
# Edit .env and set AI_API_KEY
# Get key from OpenAI (https://platform.openai.com/api-keys) or Groq, OpenRouter, etc
# Example:
# AI_API_KEY=sk-...
# AI_PROVIDER=openai
# AI_MODEL=gpt-4o-mini
# AI_API_URL=https://api.openai.com/v1/chat/completions

npm start
# Should see:
# [Flowback Backend] Server running on http://localhost:3000
# [Flowback Backend] AI Configured: YES
```

Test health:
```bash
curl http://localhost:3000/health
```

### 2. Extension Setup
1. Open Chrome → `chrome://extensions`
2. Enable Developer Mode (top right)
3. Click "Load unpacked"
4. Select `extension/` folder from this repo
5. Pin Flowback extension

### 3. Test Complete Flow
1. Open a normal webpage (e.g., Stack Overflow question, GitHub issue, docs)
2. Select some text, type in an input, focus an element (simulate working)
3. Switch to another tab or another app for **>10 seconds** (critical!)
4. Return to original tab
5. Check background service worker logs:
   - Go to `chrome://extensions` → Flowback → Service Worker → Inspect
   - Should see:
     ```
     [Flowback] Context left (switched tab)
     [Flowback] Waiting for return
     [Flowback] User returned
     [Flowback] Interruption duration: 12.3 seconds
     [Flowback] Confirmed interruption
     [Flowback] Requesting context capture
     [Flowback] Context received
     [Flowback] Capsule saved (raw)
     [Flowback] Sending context to AI backend
     [Flowback] AI reconstruction received
     [Flowback] Capsule enriched with AI
     ```
6. Click Flowback extension icon (popup)
7. Should see AI-generated Resume Card:
   - TASK: What you were working on
   - TRIED: What you attempted
   - NEXT: Most likely next action
8. Click "Resume Work" → capsule cleared

## Testing Edge Cases

### AI API Failure
- Stop backend (`Ctrl+C`)
- Repeat interruption flow (switch away >10s, return)
- Popup should show fallback:
  - TASK: Captured context available
  - TRIED: AI reconstruction unavailable
  - NEXT: Resume from your captured context
- Raw context still saved for debugging (check chrome.storage.local)

### Empty Context
- Open `about:blank` or empty new tab
- Try to trigger capture manually via console:
  ```js
  chrome.tabs.query({active:true}, tabs => chrome.tabs.sendMessage(tabs[0].id, {type:'CAPTURE_CONTEXT'}, console.log))
  ```
- Backend should return "Not enough context."

### Long Webpage Text
- Open Wikipedia long article (e.g., "JavaScript")
- Trigger interruption
- Check that visibleText is truncated to ~3500 chars before AI call
- Should still reconstruct successfully

### Restricted Pages
- Try on `chrome://extensions` → content script won't inject (expected)
- background.js logs "Could not reach content script" and fails safely
- No capsule saved, no crash

### Malformed AI JSON
- Backend has robust parsing: strips markdown fences, regex extracts JSON
- If still fails, returns fallback AI
- Test by temporarily setting AI_MODEL to invalid model → should get 502 with fallback

### Missing API Key
- Remove AI_API_KEY from .env or set to empty
- Restart backend
- Health check shows `aiConfigured: false`
- POST /api/reconstruct returns 503 with fallback
- Extension still works with fallback

## Backend Tests
```bash
cd backend
npm test
# Runs validation tests for:
# - Empty context
# - Normal context
# - Long text truncation
# - Sensitive data redaction
# - AI response validation
# - Prompt building
# - System prompt rules
# - Fallback AI
# - Missing API key
# - Live backend health (if running)
```

## Manual Backend Test with curl
```bash
# Health
curl http://localhost:3000/health

# Reconstruct (with AI configured)
curl -X POST http://localhost:3000/api/reconstruct \
  -H "Content-Type: application/json" \
  -d '{
    "title": "React useEffect infinite loop - Stack Overflow",
    "url": "https://stackoverflow.com/questions/123",
    "selectedText": "useEffect(() => { fetchData(); }, [])",
    "visibleText": "Question about useEffect causing infinite loop...",
    "focusedElement": "textarea",
    "inputContext": "I tried adding dependency array but"
  }'

# Should return:
# {"task":"Fixing useEffect infinite loop...","tried":"Tried adding...","next":"Test dependency fix..."}
```

## Demo Video Script (for hackathon)
1. Show problem: "You get interrupted, you lose your train of thought"
2. Show Flowback installed
3. Work on a Stack Overflow page, select code, type comment
4. Switch to Slack/email for 12 seconds
5. Return → notification? (or just popup)
6. Open Flowback popup → AI reconstructed TASK/TRIED/NEXT
7. Resume work instantly
8. Show privacy: no history, no storage, raw content discarded on backend
9. Show fallback: stop backend, still works

## Troubleshooting

**Backend not starting:**
- Check Node >=18: `node --version`
- Check .env exists: `ls -la backend/.env`
- Check port 3000 free: `lsof -i :3000` or `netstat`

**Extension not capturing:**
- Check service worker logs for errors
- Ensure page is not chrome:// or devtools:// (ignored)
- Ensure content.js injected: open page console, check for [Flowback] logs
- Ensure interruption >10s (not 5s)

**AI not showing:**
- Check backend logs: `AI Configured: YES`?
- Check network tab in service worker inspector: fetch to localhost:3000
- CORS issue? Backend uses `origin: true` so should allow
- Try curl test to verify backend works

**Popup shows "No saved context":**
- No interruption captured yet - trigger one
- Check chrome.storage.local: open popup console, run `chrome.storage.local.get('activeCapsule', console.log)`

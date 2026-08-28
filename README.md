# Flowback — AI-Powered Context Recovery

> An AI-powered context recovery system that captures your train of thought during interruptions and helps you resume work instantly.

Built for **iQOO Hackathon 2026, Productivity theme**.

## The Problem
You get interrupted while working. You switch tabs, answer a Slack message, check email. 30 seconds later you return and think: *"What was I doing?"* — you lost your train of thought.

## The Solution
Flowback detects interruptions (>10s away), captures your working context (title, selection, visible text, input), reconstructs it with AI into **TASK / TRIED / NEXT**, and shows a Resume Card.

```
Interruption → Context Capture → AI Reconstruction → Resume Card
```

## Architecture

- **Extension**: Chrome MV3, interruption detection engine, context capture, single activeCapsule
- **Backend**: Node.js + Express, AI reconstruction, no permanent storage, privacy-first
- **AI**: Working-context reconstruction engine, strict JSON output, no hallucination

See [docs/architecture.md](docs/architecture.md) for full architecture.

## Quick Start

### Backend

```bash
cd backend
npm install
cp .env.example .env
# Edit .env:
# AI_API_KEY=sk-your-key
# AI_PROVIDER=openai (or groq, openrouter, etc)
# AI_MODEL=gpt-4o-mini
# AI_API_URL=https://api.openai.com/v1/chat/completions

npm start
# Health: http://localhost:3000/health
```

**Supported AI providers (any OpenAI-compatible):**
- OpenAI: `https://api.openai.com/v1/chat/completions` (gpt-4o-mini, gpt-3.5-turbo, gpt-4o)
- Groq: `https://api.groq.com/openai/v1/chat/completions` (llama-3.1-8b-instant)
- OpenRouter: `https://openrouter.ai/api/v1/chat/completions`
- Together: `https://api.together.xyz/v1/chat/completions`
- Local Ollama: `http://localhost:11434/v1/chat/completions`

### Extension

1. `chrome://extensions` → Developer Mode ON → Load unpacked → select `extension/` folder
2. Open any webpage, work on it (select text, type)
3. Switch away >10 seconds (other tab or app)
4. Return → check service worker logs for capture
5. Click Flowback icon → see AI Resume Card
6. Resume Work → capsule cleared

See [docs/demo.md](docs/demo.md) for detailed demo & testing.

## Project Structure

```
FlowBack-project/
├── extension/
│   ├── manifest.json
│   ├── background.js      # Interruption detection + AI integration
│   ├── content.js         # Context capture (reactive)
│   └── popup/
│       ├── popup.html
│       ├── popup.css
│       └── popup.js       # Displays AI or fallback
├── backend/
│   ├── server.js          # Express backend, privacy-first
│   ├── ai.js              # AI provider integration
│   ├── package.json
│   ├── .env.example
│   └── test.js
├── ai/
│   ├── prompt.js          # Strict system prompt
│   └── context.js         # Validation, sanitization, truncation
├── docs/
│   ├── architecture.md
│   └── demo.md
└── README.md
```

## Capsule Format

```js
{
  id,
  createdAt,
  tabId,
  title,
  url,              // sanitized (no query/hash)
  selectedText,
  visibleText,
  focusedElement,
  inputContext,     // sensitive fields filtered
  ai: {
    task,           // What was user working on?
    tried,          // What had they attempted?
    next            // Most likely next action?
  }
}
```

Only one activeCapsule exists. Raw context remains for debugging. AI field optional.

## Privacy & Security

- ✅ AI_API_KEY never in extension, manifest, popup, content
- ✅ .env in .gitignore, never committed
- ✅ Backend: receive → AI → return → discard (no storage)
- ✅ No user history, analytics, databases, Firebase (MVP out of scope)
- ✅ No logging of raw content, passwords, payment data
- ✅ URL sanitization, sensitive field filtering
- ✅ Context size limits before AI call
- ✅ Request timeouts (10s extension, 12s AI, 15s server)
- ✅ Validates incoming data, handles failures gracefully

## AI Prompt

System prompt defines AI as **working-context reconstruction engine, NOT chatbot**:

- Input: title, url, selected, visible, focused, inputContext
- Output: ONLY JSON `{task, tried, next}`
- Rules: No markdown, no explanation, no hallucination, max ~20 words/field, preserve technical terms, actionable, "Not enough context." if uncertain

See `ai/prompt.js` for full prompt.

## Failure Handling

- Backend down → fallback AI: "Captured context available" / "AI reconstruction unavailable" / "Resume from your captured context"
- Empty context → "Not enough context."
- Long text → truncated
- Malformed AI JSON → regex extraction → fallback
- Missing API key → 503 with fallback
- Extension remains usable without AI (raw fallback)

## Testing

```bash
cd backend
npm test          # unit tests for validation, truncation, etc
npm start         # start server, then curl http://localhost:3000/health
```

Manual test checklist in [docs/demo.md](docs/demo.md).

## Files Changed / Created

**Created:**
- backend/package.json
- backend/server.js
- backend/ai.js
- backend/.env.example
- backend/test.js
- backend/firebase.js (deprecated, MVP no Firebase)
- ai/prompt.js
- ai/context.js
- .gitignore
- docs/architecture.md
- docs/demo.md

**Changed:**
- extension/background.js (added AI integration, preserved interruption flow)
- extension/popup/popup.js (added AI display, fallback, live update)
- README.md (full docs)

**Not Changed (preserved):**
- extension/manifest.json
- extension/content.js
- extension/popup/popup.html
- extension/popup/popup.css
- extension/ui/* (placeholder)

## Install Dependencies

```bash
cd backend
npm install
```

Requires Node >=18 (native fetch).

## Configure AI_API_KEY

```bash
cd backend
cp .env.example .env
# Edit .env
nano .env
# Set:
# AI_API_KEY=your_key_here
# Optional: AI_PROVIDER, AI_MODEL, AI_API_URL, PORT
```

Never commit `.env`. It's gitignored.

## Start Backend

```bash
cd backend
npm start
# or dev mode:
npm run dev
```

Server runs on `http://localhost:3000`
- `GET /` → info
- `GET /health` → health + aiConfigured status
- `POST /api/reconstruct` → AI reconstruction

## Test Complete Flow

1. Backend running with valid API key
2. Extension loaded in Chrome
3. Open normal webpage (e.g., Stack Overflow)
4. Work: select text, type
5. Switch away >10s
6. Return → background.js captures → calls backend → enriches capsule
7. Popup displays AI Resume Card
8. Also test: backend stopped → fallback, empty page → "Not enough context.", long page → truncated but works

See [docs/demo.md](docs/demo.md) for all edge cases.

## Limitations / Known Issues

- Backend must run on localhost:3000 for extension to reach AI (configurable via BACKEND_URL constant in background.js)
- Chrome extension fetch to localhost requires backend CORS enabled (done via `origin: true`)
- AI quality depends on provider/model; gpt-4o-mini recommended for cost/latency
- No streaming, single request/response (MVP)
- Only one capsule (no history) per MVP spec
- Service worker can suspend; state stored in chrome.storage.session survives, but in-memory cache is best-effort
- Content script not injected on chrome://, devtools://, extension pages (expected, fails safely)
- VisibleText limited to 4000 chars (content.js) and 3500 chars (backend) to control cost

## Hackathon MVP Scope

**Included:**
- Interruption detection (10s threshold, timestamp-based, survives suspend)
- Context capture (title, url, selected, visible, focused, input)
- AI reconstruction (TASK/TRIED/NEXT, strict prompt, no hallucination)
- Resume Card (popup, AI or fallback)

**Explicitly NOT included (per spec):**
- Firebase, teammate sharing, auth, accounts, analytics, databases, user history

## License

Hackathon project - iQOO Hackathon 2026

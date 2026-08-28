
We are building "Flowback", a Chrome Extension for the iQOO Hackathon 2026 Productivity theme.

Already completed:

- extension/manifest.json
- extension/background.js
- extension/content.js
- extension/popup/popup.html
- extension/popup/popup.css

NOW CREATE ONLY:

`extension/popup/popup.js`

Do NOT modify any other file.

==================================================
CURRENT GOAL
==================================================

Make the existing Flowback popup interactive.

The popup currently contains:

- Task section with id="task"
- Tried section with id="tried"
- Next section with id="next"
- Resume Work button with id="resumeBtn"
- Share With Teammate button with id="shareBtn"

Use these existing elements.

==================================================
MOCK DATA
==================================================

For now, use temporary mock data:

Task:
"Debugging the authentication API"

Tried:
"Checked the JWT token and authorization header."

Next:
"Inspect the authentication middleware."

On popup load, display this data in the appropriate elements.

IMPORTANT:

Keep the code structured so that later we can replace the mock data with real data coming from Chrome Storage.

==================================================
RESUME WORK BUTTON
==================================================

When the user clicks:

"Resume Work"

do NOT close the popup immediately.

Instead:

1. Change the UI into a success/resume state.
2. Show:

"Context restored."

and:

"You're back where you left off."

3. Disable the Resume Work button after clicking.
4. Keep the UI polished and consistent with the existing CSS.

For now, do NOT actually delete Chrome Storage because storage integration will be implemented in the next step.

==================================================
SHARE BUTTON
==================================================

When the user clicks:

"Share With Teammate"

show a small non-intrusive message:

"Team handoff is coming next."

Do NOT implement Firebase.
Do NOT implement networking.

==================================================
CODE QUALITY
==================================================

Use vanilla JavaScript only.

No React.
No external libraries.
No CDN.
No TypeScript.

Use:

DOMContentLoaded

and safely check that DOM elements exist before accessing them.

Keep the code modular.

Create small functions such as:

- loadMockCapsule()
- renderCapsule()
- handleResume()
- handleShare()

Avoid unnecessary complexity.

==================================================
FUTURE COMPATIBILITY
==================================================

Design the code so the next step can easily replace:

mock capsule data

with:

chrome.storage.local

data.

For example, use a data object with:

{
  task: "...",
  tried: "...",
  next: "..."
}

Do not implement Chrome Storage yet.

==================================================
IMPORTANT
==================================================

Do NOT:

- call an AI API
- call Firebase
- modify background.js
- modify content.js
- implement authentication
- implement teammate networking
- implement real storage deletion

Only make popup.js functional with mock data.

==================================================
OUTPUT
==================================================

Give me:

1. Complete `popup.js`
2. Very short explanation
3. Exact location where the file should be placed

Nothing else.

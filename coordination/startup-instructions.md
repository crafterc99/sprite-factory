# Startup Instructions

Open 5 terminals in VS Code (Ctrl+Shift+` to open each, or use the split terminal button).
In each terminal, run `claude` then paste the prompt below.

---

## Terminal 1 — HEAD
Paste:
```
Read coordination/prompts/head-terminal.md and follow the instructions inside it exactly. Start now.
```

## Terminal 2 — UPLOAD
Paste:
```
Read coordination/prompts/upload-terminal.md and follow the instructions inside it exactly. Check coordination/task-board.md for tasks assigned to the upload terminal. Start now.
```

## Terminal 3 — ANIMATION
Paste:
```
Read coordination/prompts/animation-terminal.md and follow the instructions inside it exactly. Check coordination/task-board.md for tasks assigned to the animation terminal. Start now.
```

## Terminal 4 — REVIEW
Paste:
```
Read coordination/prompts/review-terminal.md and follow the instructions inside it exactly. Check coordination/task-board.md for tasks assigned to the review terminal. Start now.
```

## Terminal 5 — INTEGRATION
Paste:
```
Read coordination/prompts/integration-terminal.md and follow the instructions inside it exactly. Check coordination/task-board.md for tasks assigned to the integration terminal. Start now.
```

---

## Manual steps still required

1. **VS Code `code` shell command** — already installed (code 1.113.0 detected).

2. **Claude login** — if any terminal shows an auth prompt, run:
   ```
   claude
   ```
   and follow the login flow. Only needs to be done once.

3. **soul-jam repo** — export testing is blocked until the soul-jam repo is cloned:
   ```
   cd /Users/pshelley/sprite-tools
   git clone <soul-jam-repo-url> soul-jam
   ```
   Once cloned, the EXPORT-TEST-001 task can be unblocked.

4. **Start the server** before animation or review terminals run generation tasks:
   ```
   node server.js
   ```
   Server runs at http://localhost:3456

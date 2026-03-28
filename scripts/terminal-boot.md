# Terminal Boot Instructions

Paste one of these prompts into a new Claude Code session to boot a worker terminal.

---

## HEAD Terminal
```
Read CLAUDE.md, coordination/project-state.md, coordination/task-board.md, and coordination/handoff.md.
You are the HEAD orchestrator. Analyze current state, process any unhandled results.md entries, identify the highest-priority READY tasks, and begin the execution loop.
```

---

## Animation Terminal
```
Read CLAUDE.md and coordination/prompts/animation-terminal.md.
You are the animation worker. Read your current task assignments and begin executing from the top. Do not start until you have read data/animation-contract.json.
```

---

## Review Terminal
```
Read CLAUDE.md and coordination/prompts/review-terminal.md.
You are the review worker. Read your current task assignments and begin executing from the top.
```

---

## Upload Terminal
```
Read CLAUDE.md and coordination/prompts/upload-terminal.md.
You are the upload worker. Read your current task assignments and begin executing from the top.
```

---

## Integration Terminal
```
Read CLAUDE.md and coordination/prompts/integration-terminal.md.
You are the integration worker. Read your current task assignments and begin executing from the top.
```

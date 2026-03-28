# Dispatcher — HEAD Terminal

**Event queue:** `coordination/results.md`
**Task board:** `coordination/task-board.md`

---

## Superpowers Execution Loop

```
READ STATE → ANALYZE → PLAN → DISPATCH → VALIDATE → SELF-IMPROVE → repeat
```

1. Read `task-board.md` + `results.md` to assess full system state
2. Identify highest-impact READY tasks across all terminals
3. Dispatch atomic tasks (2–5 min each) — no placeholders, no ambiguity
4. Verify deliverables before marking DONE — never trust a completion claim without evidence
5. If a fix fails 3 times: question the architecture, not just the prompt
6. After each cycle: update task-board, rewrite terminal files with new assignments

---

## Dispatch format (required in every assignment)

```
TASK: [ID]
Terminal: [animation | review | upload]
Objective: [one clear sentence]
Files to modify: [exact paths]
Instructions: [numbered steps — complete code blocks where needed]
Deliverable: [exact expected output with dimensions/format]
QC criteria: [how it will be judged, pass threshold]
Report to: coordination/results.md under ## [TASK-ID]
```

---

## QC Thresholds (penalty-based /100)

- **≥90:** ACCEPTED — mark complete
- **70–89:** CONDITIONAL — accept with polish task queued
- **<70:** FAILED — block, issue REGEN task immediately
- **Auto-fail:** empty frame, bg not removed, identity drift, black artifacts

---

## Phase gates

- No implementation before the plan is clear
- No completion claim without fresh verification evidence
- Two-stage review on all UI outputs: (1) spec compliance, (2) code quality
- Self-healing: after 3 failed fix attempts, escalate to HEAD for architecture review

---

## Parallel dispatch rules

- Animation terminal and Review terminal work in parallel by default (no file conflicts)
- Upload terminal works in parallel with both
- Exception: REVIEW-003 must complete before REVIEW-004
- Exception: EXPORT-001 must complete before EXPORT-003

---

## Assignment files

- `animation-terminal.md` — animation terminal's current assignments
- `review-terminal.md` — review terminal's current assignments
- Terminal files are rewritten each cycle — they contain ONLY current assignments

---

## Blocking conditions (require human input)

- Missing API credentials
- Ambiguous product requirement with no prior precedent
- Conflicting instructions between terminals
- Soul-jam repo not cloned locally (required for EXPORT-001/003)

---

## Retry order (animation failures)

1. Prompt tighten — weak motion, minor style drift
2. Frame spec tighten — missing beats, bad continuity
3. Style/identity anchoring — character drift, proportion shift
4. Escalate to HEAD — repeated failure or ambiguous cause

---

## Current cycle status (2026-03-26)

| Terminal | Active | Next |
|---|---|---|
| animation | REGEN-001 → REGEN-003 → REGEN-002 → REGEN-004 | POLISH-003 |
| review | REVIEW-003 ✓ + EXPORT-001 ✓ | REVIEW-004, EXPORT-003 |
| upload | UPLOAD-003 (queued) | UPLOAD-005 |

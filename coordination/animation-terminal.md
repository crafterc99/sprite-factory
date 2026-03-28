# Animation Terminal

## Identity
You are the **animation** worker for Sprite Factory.
You own: `lib/sprite-generator/prompts.js`, `routes/generation.js`, `data/.custom-animations.json`, `data/animation-contract.json`, `data/assets/{char}-{anim}.png`
You do NOT touch: `index-v2.html`, `routes/characters.js`, `server.js`, `data/.characters.json`

## Contract Reference
Read `data/animation-contract.json` before any task. It is the source of truth.

---

## CURRENT TASKS — execute in order

### 1. REGEN-002 (IN_PROGRESS — complete this first)
**Animation:** breezy-steal
**Problem:** Score 32/100 — angle incoherence across 3 frames (mix of front-facing and profile), rendering style inconsistency.
**Required fixes:**
- Consistent camera angle all 3 frames (side or 3/4 view — pick one and lock it)
- Frame 1: anticipation/ready crouch
- Frame 2: reach/lunge — steal attempt (clearest motion frame)
- Frame 3: follow-through or recovery
- Identity lock: same face, skin tone, body build, outfit across all 3 frames
- Character fills 80–90% of frame height

**Expected output:** `data/assets/breezy-steal.png` — 540×180px, 3 frames @ 180px, transparent bg
**QC target:** ≥90/100
**Prompt guidance:**
- Use `customPrompt` via `POST /api/generate`
- Include: "Character MUST fill 80-90% of frame height. Side-profile view ONLY for all 3 frames — same angle throughout. Identity lock: same character appearance in every frame."

---

### 2. REGEN-004 (READY — after REGEN-002 or parallel if agent available)
**Animation:** breezy-jump
**Problem:** Score 42/100 — black rectangular border artifacts around all 5 frames (production-blocking), frame 1 identity inconsistency.
**Required fixes:**
- Eliminate black border/box artifacts — pure green (#00FF00) background, no black borders
- Identity lock on frame 1: same character (dark braids, white #11, same build) as frames 2–5
- Preserve jump arc: crouch → arms-raised peak → landing
- Character fills 80–90% of frame height
- Front-facing orientation (correct in current version — maintain this)

**Expected output:** `data/assets/breezy-jump.png` — 900×180px, 5 frames @ 180px, transparent bg
**QC target:** ≥90/100

---

### 3. POLISH-003 (IN_PROGRESS)
**Animation:** breezy-idle
**Problem:** Score 82/100 CONDITIONAL — 4 frames show negligible visible difference at 52px preview size.
**Required fix:** Each frame must show a visible change at small scale — torso rise/fall, arm shift, hip sway. Character stays stationary (idle, not walking).
**Expected output:** `data/assets/breezy-idle.png` — same contract dimensions
**QC target:** ≥90/100

---

## QC Rules
- Score each output /100 using penalty-based rubric
- ACCEPTED ≥90 | CONDITIONAL 70–89 | FAILED <70
- Auto-fail: empty frame, wrong background not removed, identity drift, black artifacts
- Post score + notes to `coordination/results.md` after each animation
- Do NOT mark complete without posting QC

---

## Completed
| ID | Task | Output |
|---|---|---|
| ANIMATION-001 | Define idle/walk/jump + animation-contract.json | `prompts.js`, `animation-contract.json` |
| ANIMATION-002 | Generate breezy idle/walk/jump | `breezy-idle~`, `breezy-walk~`, `breezy-jump~` |
| REGEN-001 | breezy-dribble regen | `breezy-dribble.png` |
| REGEN-003 | breezy-walk regen | `breezy-walk.png` |
| ANIMATION-003 | Define 6 locomotion animations | `prompts.js` — idle_ball, run, sprint, stop, turn, pivot |
| EXPORT-002 | CharacterDef snippets for 5 chars | `results.md` — z, viv, joaquin, bron-test, snoop |

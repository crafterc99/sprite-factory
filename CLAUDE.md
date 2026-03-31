# Project Rules

You are working inside a multi-terminal Claude Code workflow.

Global operating rules:
- coordination/task-board.md is the source of truth for assigned work
- coordination/results.md is the source of truth for completed work
- coordination/project-state.md tracks the current known state of the repo
- coordination/blockers.md tracks blocking issues
- coordination/handoff.md tracks cross-terminal dependencies

Behavior rules for every terminal:
- read the coordination files before acting
- keep tasks small, explicit, and testable
- do not overwrite another terminal's assigned task unless task-board says reassigned
- when work is complete, write a concise result entry to coordination/results.md
- when blocked, write a blocker entry to coordination/blockers.md
- prefer minimal targeted edits over large rewrites
- preserve working behavior unless task explicitly requires architectural changes
- always report exact files changed
- always report validation performed
- if you make assumptions, state them in results.md

Assignment model:
- Head terminal plans, dispatches, reprioritizes, and closes tasks
- Upload terminal owns ingestion, source prep, file normalization, and asset intake
- Animation terminal owns prompt building, generation logic, motion assets, and animation contracts
- Review terminal owns QA, UX review, acceptance criteria, bug validation, and regression checks
- Integration terminal owns API wiring, data contracts, exports, persistence, and pipeline connections

Completion format:
- Task ID
- Status: DONE | BLOCKED | NEEDS_REVIEW
- Files changed
- What changed
- Validation
- Next dependency or follow-up

Do not treat these rules as optional.

---

# Mac Workflow Rules

These rules apply when running Claude Code on the Mac (local development).

## Git discipline
- After EVERY change that works, commit and push to the `main` branch on GitHub
- Commit messages must be descriptive (what changed and why)
- Never leave working changes uncommitted — the Railway deployment and other devices depend on main being up to date
- Use: `git add <files> && git commit -m "..." && git push origin main`

## Testing URL
- The live test environment is Railway: **https://sprite-factory-production.up.railway.app**
- Railway auto-deploys from the `main` branch within ~2 minutes of a push
- Local dev runs on http://localhost:3456 via `bash mac-dev.sh`

## Project tracking
- Every active project has a file in `projects/`
- Before starting work on a project, read its file to understand current state and goals
- After completing any work on a project, update its file:
  - Set `last_updated` to today's date
  - Update `status` if it changed
  - Check off completed milestones
  - Add a log entry describing what was done
- If a project file doesn't exist yet, create one using `projects/_template.md`
- Project files are committed alongside code changes


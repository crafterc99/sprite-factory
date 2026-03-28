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

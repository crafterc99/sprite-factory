# Worker Poll Loop

Instructions for a worker that continuously polls for new tasks.

## Poll cycle
Every cycle a worker should:
1. Read `coordination/task-board.md` — find tasks assigned to your terminal with status READY
2. If a task is READY: execute it, append result to `coordination/results.md`, update task status to DONE
3. If nothing is READY: read `coordination/blockers.md` — if blocked, stop. Otherwise write WAITING to your terminal file.
4. Repeat

## HEAD poll cycle
1. Read tail of `coordination/results.md` for new entries since last check
2. For each new entry: verify deliverable, update QC table, unlock dependents
3. Identify next highest-priority READY tasks per terminal
4. Dispatch: rewrite `coordination/prompts/{terminal}-terminal.md` with new assignment
5. Repeat

## Coordination invariants
- Only HEAD writes to task-board.md status fields
- Only workers write to results.md (append only)
- Terminal prompt files are owned by HEAD — workers read them, HEAD writes them
- No worker touches another terminal's files

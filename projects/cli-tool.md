# Project: CLI Tool (sf command)

| Field | Value |
|---|---|
| **Status** | IN_PROGRESS |
| **Last Updated** | 2026-03-31 |
| **Owner** | Claude Code |

## Goal
A `sf` CLI command that lets Claude Code (and the owner) control the sprite factory programmatically from the terminal — without needing to interact with the web UI. Supports targeting both local dev and Railway.

## Milestones
- [x] Scaffold CLI with commander (cli.js)
- [x] `sf status` — server health check
- [x] `sf chars list/get/roster/contract` — character management
- [x] `sf generate strip/fbf/angles/frame` — generation commands
- [x] `sf pipeline run/status/fill-gaps/bulk` — pipeline control
- [x] `sf evaluate animation/audit` — evaluation commands
- [x] `sf export soul-jam` — export commands
- [x] `sf jobs list/get` — job tracking
- [x] `sf costs` — cost reporting
- [x] `--url` flag and `SF_URL` env var for targeting Railway
- [x] `npm link` / `npm install -g` support (bin field in package.json)
- [ ] `sf project list/update` — read and update project tracking files
- [ ] Test all commands against Railway URL end-to-end
- [ ] Add `sf deploy status` to poll Railway build state

## Current State
`cli.js` is implemented (338 lines) with all major commands. Install with:
```
cd sprite-factory && npm link
sf status                        # test local
SF_URL=https://sprite-factory-production.up.railway.app sf status  # test Railway
```

## Next Steps
1. Verify CLI works against Railway once deployment is stable
2. Add `sf project` subcommands for reading/updating project files
3. Add `sf deploy status` to check if the latest push has deployed

## Blockers
None currently.

## Log

| Date | What happened |
|---|---|
| 2026-03-31 | CLI implemented, npm link configured, all core commands added |
| 2026-03-31 | Added SF_URL env var and --url flag for Railway targeting |

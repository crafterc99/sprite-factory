# Project: Railway Deployment

| Field | Value |
|---|---|
| **Status** | IN_PROGRESS |
| **Last Updated** | 2026-03-31 |
| **Owner** | Claude Code |

## Goal
Get the sprite factory running at a persistent, public URL that auto-updates whenever Claude Code pushes to the GitHub main branch. This lets the owner test from iPad, Mac, or any device without running the local server.

## Milestones
- [x] Connect GitHub repo to Railway
- [x] Fix ERR_REQUIRE_ESM crash (chalk v5 incompatible with CommonJS)
- [x] Fix port mismatch (domain routed to 3456, Railway injected PORT=8080 — fixed by forcing PORT=3456 in startCommand)
- [ ] Confirm deployment is stable and serving the studio UI
- [ ] Verify generation endpoints work end-to-end from Railway URL
- [ ] Set up health check / uptime monitoring (optional)

## Current State
Railway is configured to auto-deploy from the `main` branch. The last two deploys fixed:
1. A crash caused by `chalk` (ESM-only package) being `require()`'d in `strip-builder.js` and `smart-selector.js`
2. A port mismatch where the Railway-assigned PORT=8080 conflicted with the domain configured for 3456

The current `railway.json` forces `PORT=3456` in the start command so the server binds on the port the domain expects.

A new build is in progress as of 2026-03-31.

## Next Steps
1. Wait for current Railway build to complete (~2 min after last push)
2. Load https://sprite-factory-production.up.railway.app and confirm the studio UI appears
3. Try generating one animation to verify the full pipeline works on Railway
4. If 502 persists, check Railway logs for new crash reasons

## Blockers
- Railway project token has limited API scope — cannot update domain port via GraphQL (worked around by changing the start command instead)

## Log

| Date | What happened |
|---|---|
| 2026-03-31 | Fixed ERR_REQUIRE_ESM crash (chalk), fixed port mismatch via startCommand, pushed to main |
| 2026-03-31 | Discovered Railway injects PORT=8080, domain was set to 3456 — worked around in railway.json |
| 2026-03-31 | Initial Railway deployment set up, GitHub auto-deploy connected |

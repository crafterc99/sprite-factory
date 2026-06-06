# Project: Railway Deployment

| Field | Value |
|---|---|
| **Status** | IN_PROGRESS |
| **Last Updated** | 2026-06-06 |
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
- **ACTIVE:** Cloudflare R2 env vars (`R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`) are not set in Railway Variables. The red "DATA PERSISTENCE BROKEN" banner shows on every page load and characters do not persist across redeploys. Owner must complete the R2 setup below — Claude Code cannot set Railway Variables from CLI.

## Cloudflare R2 setup (required to clear persistence banner)

The studio uses Cloudflare R2 as the durable backing store for `_meta/*.json` (characters, anim-lib, wardrobe, etc.) and full-resolution PNG assets. `lib/supabase-storage.js` is a runtime router that delegates to `lib/r2-storage.js` whenever R2 env vars are present, so the rest of the code didn't have to change. Supabase env vars are still honored as a fallback for old deploys.

1. **Create the R2 bucket** — Cloudflare dashboard → R2 → Create bucket → name `sprite-factory` (or set `R2_BUCKET` to whatever name you pick). Public access is **not** required — the Node process serves all reads through `/assets/*`.
2. **Create an R2 API token** — R2 → Manage R2 API Tokens → Create API Token. Permissions: **Object Read & Write**. Scope it to the single bucket you just created. Cloudflare will show:
   - Access Key ID → `R2_ACCESS_KEY_ID`
   - Secret Access Key → `R2_SECRET_ACCESS_KEY` (shown only once — copy it now)
3. **Grab your Account ID** — Cloudflare dashboard top-right (or R2 overview page). It's a long hex string. The R2 endpoint URL is `https://<account-id>.r2.cloudflarestorage.com` — that whole URL becomes `R2_ENDPOINT`.
4. **Set Railway Variables** — Railway dashboard → sprite-factory service → Variables:
   - `R2_ENDPOINT` = `https://<account-id>.r2.cloudflarestorage.com` (no trailing slash, no bucket in path)
   - `R2_ACCESS_KEY_ID`
   - `R2_SECRET_ACCESS_KEY`
   - `R2_BUCKET` *(optional — defaults to `sprite-factory`)*
   Save → Redeploy.
5. **Verify** — once the new deploy is live, hit:
   - `https://sprite-factory-production.up.railway.app/api/debug/db` — should return `{ "ok": true, "backend": "r2", ... }`.
   - `https://sprite-factory-production.up.railway.app/api/storage-status` — should return `{ "backend": "r2", "r2Available": true, "connected": true, ... }`.
   - The studio page — the red banner should be gone, and the startup log line in Railway → Deployments → View logs should read `Storage: R2 (bucket=sprite-factory)`.
6. **Also set locally for dev** — `cp .env.example .env`, fill in the same values. `server.js` has a zero-dep `.env` loader that picks them up automatically.
7. **(Optional) seed R2 from current Railway state** — the prior session added `POST /api/migrate-to-storage`, which uploads all current local `_meta/*.json` files and assets to R2 in one shot. Useful only if there's data in the running container that hasn't been mirrored to R2 yet.

`/api/debug/db` reports the connected backend, which side is missing, and the connection error if any — read its response before re-doing setup.

## Log

| Date | What happened |
|---|---|
| 2026-06-06 | Banner trigger + UI/UX cleanup on top of the prior R2 migration: `/api/debug/db` now reports R2 status (preferring R2, falling back to Supabase) so the red banner clears once R2 vars are set on Railway; banner copy + click-through alert rewritten with the four R2 env vars; startup `Storage:` log line replaces the old `Supabase:` line; added `.env.example` documenting R2 env vars; documented Cloudflare R2 setup steps in this file. |
| 2026-06-06 | Earlier in the day: another session landed the actual R2 wiring (`lib/r2-storage.js`, `lib/supabase-storage.js` routing fallback, `/api/storage-status`, `/api/migrate-to-storage`, `verifyConnection`). |
| 2026-03-31 | Fixed ERR_REQUIRE_ESM crash (chalk), fixed port mismatch via startCommand, pushed to main |
| 2026-03-31 | Discovered Railway injects PORT=8080, domain was set to 3456 — worked around in railway.json |
| 2026-03-31 | Initial Railway deployment set up, GitHub auto-deploy connected |

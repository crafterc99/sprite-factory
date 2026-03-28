# Blockers

### BLOCKER-001
- Reported by: head terminal
- Related task: EXPORT-001
- Description: soul-jam repo not cloned locally
- Exact failure: `POST /api/export/soul-jam` returns 404 — directory `../soul-jam/public/assets/images/` does not exist
- File or command involved: `routes/export.js` — SOUL_JAM_IMAGES_DIR resolution
- Suggested next action: `cd /Users/pshelley/sprite-tools && git clone <soul-jam-repo-url> soul-jam`
- Unblocks: EXPORT-001, end-to-end atlas export test
- STATUS: RESOLVED — 2026-03-27 (HEAD-DISPATCH-013)
  - soul-jam repo cloned to /Users/pshelley/sprite-tools/soul-jam
  - Directory /Users/pshelley/sprite-tools/soul-jam/public/assets/images/ confirmed to exist with sprite files
  - TASK-0003 unblocked and marked IN_PROGRESS

### BLOCKER-002
- Reported by: head terminal
- Related task: ANIMATION-001
- Description: External image generation API instability — repeated 429 rate limits and 500 internal server errors across multiple models
- Exact failure: gemini-3.1-flash-image-preview → 429/500 across multiple retries; fallback models also failed; long-wait retry also failed. Left breezy-dribble.png in corrupted state (4096x512 instead of 1440x180).
- File or command involved: `routes/generation.js` POST /api/generate — batch path
- Suggested next action: Wait for provider cooldown, then retry ANIMATION-001 with a fresh generation. Do NOT retry in a loop.
- Unblocks: ANIMATION-001, breezy-dribble polish
- STATUS UPDATE (2026-03-27): PARTIALLY RESOLVED
  - Re-test performed by head terminal via direct Node.js API call
  - gemini-3-pro-image-preview: still 500 INTERNAL after 12s
  - gemini-3.1-flash-image-preview: still 500 INTERNAL after 9s
  - gemini-2.5-flash-image (legacy): RESPONDING — image returned in 4.9s
  - Decision: unblock ANIM-REGEN-SNOOP-IDLE and ANIM-REGEN-Z-STEPBACK using gemini-2.5-flash-image
  - Caveat: legacy model may produce lower-resolution output; QC thresholds remain unchanged (80/100 and 75/100); if output falls below threshold, re-queue for pro model when 500s resolve
  - Blocker remains open for pro model recovery; do not attempt pro model until 500s clear
- STATUS UPDATE (2026-03-27, second update — HEAD post-regen dispatch, CORRECTED):
  - HEAD initially diagnosed the 58/100 snoop-idle failure as a gemini-2.5-flash-image model capability limitation (fills 100% frame height). This diagnosis was INCORRECT.
  - CORRECTION (same date, pipeline bug fix identified): The 58/100 failure was caused by a processSprite pipeline bug — resizeFrame was operating on 168x768 tall raw frames without a prior crop-to-content step, which forced 100% fill regardless of model output. This bug has been fixed in lib/sprite-processor/index.js (cropToContent now runs before resize). The same fix unblocked breezy-dribble and walk (now scoring 85-100/100 with 90-91% fill).
  - POLICY RETRACTED: gemini-2.5-flash-image is usable with the fixed pipeline. The model capability limitation diagnosis was wrong.
  - ANIM-REGEN-SNOOP-IDLE is RE-QUEUED for Animation terminal using the fixed pipeline. Raw output at data/raw-sprites/snoop-idle-regen-raw.png can be reprocessed without re-generating.
  - BLOCKER-002 is RESOLVED for flash model work. Pro model (gemini-3-pro-image-preview, gemini-3.1-flash-image-preview) 500 errors remain unresolved but are no longer blocking snoop-idle.

## Active Blocker Template

### BLOCKER-ID
- Reported by:
- Related task:
- Description:
- Exact failure:
- File or command involved:
- Suggested next action:
- Unblocks:

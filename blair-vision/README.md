# Blair Vision

A tiny, event-driven AI perception layer for the Chrome tab you are looking at. It watches the DOM (no
screenshots), recognises a multiple-choice **practice** question, asks **Jev** (TypeSafe System One) to pick between the
candidate options, and shows the pick in a small draggable HUD:

```
┌─────┐
│  C  │      (or "3" when the options are numbered, "C ?" when confidence is low)
└─────┘
```

> **Intended use:** practice quizzes, studying, accessibility, understanding pages, and your own non-graded test
> pages. Blair Vision only *displays* a suggested option. It never clicks, submits, or advances anything, and it
> does not hide itself from anyone. Do not use it on proctored or graded assessments.

## Load it in Chrome (30 seconds)

```bash
git clone <this repo> && cd blair-vision   # or just use the folder you already have
# dist/ is already built and committed. To rebuild: npm install && npm run build
```

1. Open `chrome://extensions`, switch on **Developer mode**.
2. **Load unpacked** and choose the **`dist/`** folder inside this project.
3. Click the Blair Vision icon → **Settings**, choose a provider, paste your key. (Keys stay in `chrome.storage.local` on your machine.)
4. Open a quiz tab, click the icon → **Enable on this tab**.

No key yet? Try it with the bundled **mock** Jev: `npm install && npm run demo`, then in Settings choose *Jev / TypeSafe*,
set the endpoint to `http://localhost:8787/v1/systemone` and any key (e.g. `mock`), and open
`http://localhost:8788/practice-quiz.html`. The mock answers only the demo questions; it is not Jev.

## How it works

```
DOM mutation ─┐
visibilitychange ├─► debounce 180 ms (max-wait 1 s) ─► extract question+choices ─► fingerprint
scroll / nav  ─┤                                                                     │
heartbeat 5 s ─┘  (fallback; same fingerprint gate)                     unchanged?  ─┴─► DO NOTHING
                                                                       changed?    ──► cache hit? ─► HUD
                                                                                        │ miss
                                                                          Jev (abortable) ─► [optional fallback LLM] ─► cache ─► HUD
```

* State machine: `IDLE → DETECTED → STABILIZING → ANALYZING → ANSWERED → WAITING_FOR_CHANGE`.
* The moment the on-screen question stops matching the displayed answer the HUD switches to `…`; a request is only
  sent after the DOM settles. Responses from older questions are dropped and their requests aborted (`AbortController`),
  so an answer for the previous question is never shown.
* Fingerprint = SHA-256 of normalized question + choices (pure-JS so it also works on plain-http pages). The **cache key** uses
  the *sorted* choice texts, so a reordered repeat of a question is a cache hit and the letter is re-mapped to the new order.
* Cache: `chrome.storage.local`, 500 entries (oldest evicted). Identical question → zero API calls.
* Hidden tabs are never analysed (unless you opt in). Idle cost: a few timers and a MutationObserver.

### What is sent to the model
Only: question text, the choice texts, and ≤500 chars of nearby visible text, plus the URL **without** query/hash. Never:
password/card/token-like/hidden/file inputs, input values, cookies, storage, scripts/CSS/invisible text/nav/footer. Card-like
numbers, emails, and API-key/JWT-shaped strings are scrubbed from context. Domains in *Blocked domains* are refused.
Off by default: Blair Vision injects **nothing** until you click **Enable on this tab** (uses `activeTab`, not `<all_urls>`).

### Providers (`src/providers/`)
| Setting | Endpoint | Key |
|---|---|---|
| Jev / TypeSafe | `https://api.typesafe.ai/v1/systemone` (overridable) | TypeSafe key |
| OpenRouter | `https://openrouter.ai/api/alpha/decisions` (model `~typesafe/jev-latest`) | OpenRouter key |
| Jev Browser Control | `https://jevbrowsercontrol.com/api/v1/decisions` | `jbc_…` key |

Request (adapted from [jev-browser-control](https://github.com/nexibeo/jev-browser-control), MIT — see `NOTICE`):
`{ model, state:{question, page:{text}}, questions:{ answer:{ type:'choice', criteria:{A:'…',B:'…'}, instructions } } }` →
`answers.answer = { choice, confidence, probabilities }`, `usage.cost`. The distribution is strictly validated.

`DecisionProvider` interface → `JevProvider` first; optional `FallbackLLMProvider` (OpenRouter chat, **off by default**) runs only when
confidence < threshold, the top-2 margin < 0.10, or the question looks like it needs calculation/reasoning.

### Visual content
DOM first. If only a canvas/large image is found the HUD shows "Visual content detected". *Analyze visible content* (popup; needs
*Visual fallback* on) takes **one** `captureVisibleTab` screenshot on demand and sends it to the fallback model. Never automatic.

## Develop

```bash
npm install
npm run check      # lint + typecheck + unit tests + build + manifest verification
npm run e2e        # loads dist/ into real Chromium against the demo page + mock Jev
npm run demo       # demo page :8788 and mock Jev :8787
```
Layout: `src/background` (service worker, router), `src/content` (observer, extractor, detector, fingerprint, HUD), `src/providers`,
`src/shared`, `src/options`, `src/popup`, `tests/`, `demo/`.

## API keys & distribution (read this)

* **No key is in this repository.** Keys are typed into Settings and stored in `chrome.storage.local`. `npm run verify` fails the build if a key-like string ends up in `dist/`.
* **Never publish or share a build that contains a user's key** — anyone with the package can extract it and spend your credits.
* To ship this publicly, put a **Blair backend** in front: the extension sends the compact question to `https://api.blair.example/v1/decide` with the
  user's session token; the backend holds the TypeSafe/OpenRouter key server-side, rate-limits, and meters usage. Only `endpointFor()` in
  `src/providers/jev.js` needs to change (add a `blair` provider whose URL is your backend and whose key is the session token).

## Known limits
* After a navigation to a **different origin** in an enabled tab, Chrome revokes `activeTab`; click the icon and enable again (same-origin navigations keep working).
* `file://` pages need "Allow access to file URLs"; the demo is served from localhost instead.
* Choices that are only images have no text to send, so they are reported as visual content.

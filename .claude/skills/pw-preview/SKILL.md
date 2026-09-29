---
name: pw-preview
description: Preview and test UI changes to the funding-tracker scanner (public/index.html, app.js, styles.css) in a real headless browser with mocked API data, before shipping. Use whenever a change touches the table, a popup, filters, favorites, or any other frontend behavior and needs visual confirmation or a screenshot for the user — not just a syntax check.
---

# pw-preview: browser-driven preview/testing for the funding-tracker frontend

This project has no build step and no client-side test suite — the only way
to actually see whether a change to `public/index.html` / `public/app.js` /
`public/styles.css` works is to load it in a real browser. This skill is the
reusable engine for that: a static file server for `public/`, a set of
fixture builders matching the app's real API response shapes, and a worked
example to copy and adapt.

It does **not** need the Node backend (`server.js`) running, a database, or
network access — every `/api/*` call is mocked with `page.route`, so it's
fast and works fully offline against synthetic data.

## When to use this

- After editing anything under `public/` and before telling the user it
  works — render it, don't just eyeball the diff.
- The user asks for a preview/screenshot before you ship a UI change.
- Verifying an interaction (a click, a filter, a toggle) actually does what
  the code says it does, not just that it doesn't throw.

Not for: backend-only changes (`lib/`, `server.js` routes) with no visible
frontend effect — a plain `node -c` and the existing `test_*.js` scripts
in scratchpad (see prior session history) cover those.

## Quick start

```bash
# 1. Start the static server (serves public/, reads files fresh every
#    request — no restart needed after further edits). Leave it running in
#    the background for the rest of the session; it's cheap and idempotent
#    to leave up.
node .claude/skills/pw-preview/scripts/server.js &

# 2. Copy the worked example into your scratchpad and adapt it — don't edit
#    example.js in place, it's also this skill's own smoke test.
cp .claude/skills/pw-preview/scripts/example.js /tmp/claude-*/*/scratchpad/my_preview.js

# 3. Run it (playwright and its browser live outside this project's
#    node_modules, hence NODE_PATH):
NODE_PATH=/opt/node22/lib/node_modules node /tmp/claude-*/*/scratchpad/my_preview.js
```

Take screenshots into your scratchpad directory (never into this skill's
`scripts/` folder — that's source, not output) and hand them to the user
with `SendUserFile`.

## What `fixtures.js` gives you

```js
const {
  fundingRow,          // one row of /api/funding's `rows`
  spreadRow,            // one row of /api/spreads's `rows`
  history,               // settlement array for /api/history
  aprTrendPoints,      // snapshot array for /api/apr-history
  favoritesPayload,   // { funding: [...], spread: [...] } for /api/favorites
  resolveChromiumExecutable, // finds the installed Chromium build without hardcoding its version
} = require('.claude/skills/pw-preview/scripts/fixtures');
```

Each builder returns realistic defaults (see the source for the exact
fields) — pass an `overrides` object to change only what your scenario
needs. `fundingRow()`/`spreadRow()` auto-derive `aprPct`/`avgAprPct`/
`spreadAprPct` from the rate + interval you give them via the same
`annualizedPct` formula `lib/metrics.js` uses, so a fixture never shows an
APR inconsistent with its own rate.

## Endpoints you'll typically mock

| Endpoint | Shape | Notes |
|---|---|---|
| `GET /api/funding` | `{ rows, updatedAt, refreshing, errors }` | `rows` = `fundingRow()[]` |
| `GET /api/spreads` | `{ rows, updatedAt, refreshing, errors }` | `rows` = `spreadRow()[]` |
| `GET /api/favorites` | `{ funding: [...], spread: [...] }` | |
| `POST\|DELETE /api/favorites/:tab/:baseAsset` | same shape back | route pattern **must** be `'**/api/favorites{,/**}'` — see gotcha below |
| `GET /api/history?exchange=&symbol=&intervalHours=` | `{ exchange, symbol, intervalHours, history }` | `history` = `history()` output, oldest-first |
| `GET /api/apr-history?exchange=&symbol=` | `{ exchange, symbol, points }` | `points` = `aprTrendPoints()` output, oldest-first |
| `GET /api/spot-prices?symbol=&refPrice=` | `{ symbol, coingeckoId, venues }` | usually fine mocked to `venues: []` unless testing the spot-venue list itself |

## Two gotchas worth knowing before you rediscover them the hard way

1. **Playwright's glob `*` never crosses a `/`.** `page.route('**/api/favorites*', ...)`
   matches `GET /api/favorites` but silently misses
   `POST /api/favorites/funding/BTC` (two extra path segments) — the request
   falls through to the real static server and 404s, and the star just
   doesn't sync. Use `'**/api/favorites{,/**}'` (matches the bare path OR
   any number of extra segments) instead, as `example.js` does.

2. **Don't place fixture timestamps exactly on a day boundary.** The
   funding popup's 1Д/7Д/15Д/30Д window selector (and anything else that
   filters by `time >= cutoff`) is flaky if a fixture's timestamp lands
   exactly on a 24h-multiple boundary — whether it's in/out of the window
   ends up depending on the few milliseconds between building the fixture
   and the browser evaluating its own `Date.now()`. `history()` and
   `aprTrendPoints()` already nudge every point 5 minutes older than its
   clean grid slot for exactly this reason (`offsetMs`, overridable) — keep
   that offset if you hand-roll a history array instead of using the
   builder.

## Verifying this skill still works

`scripts/example.js` doubles as a smoke test for the skill itself — after
editing `server.js` or `fixtures.js`, re-run it directly (steps 1 and 3
above, skipping the copy) and confirm it still prints `ALL PASS`.

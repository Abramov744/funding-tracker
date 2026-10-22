// Variational Omni's public API (lib/exchanges/variational.js) exposes only
// the CURRENT funding rate for each market — there is no public per-market
// history endpoint. The only historical feed documented is a private,
// wallet-authenticated CSV export of one's own trades (up to 365 days, but
// only for a logged-in account's own activity, not a public per-market feed).
//
// To give Variational rows the same 30-day stability stats every other
// exchange's own history endpoint provides, this module builds that history
// itself: every time lib/exchanges/variational.js's fetchCurrent() runs
// (driven by lib/cache.js's background refresh, every ~5 minutes), it
// compares each market's `nextFundingTime` against what was last seen for
// it, and whenever that boundary has passed, records the rate that was in
// effect right before the crossing as one settled funding event. Resolution
// is limited to the gap between fetchCurrent() calls, comfortably under
// Variational's shortest (1h) funding interval, so no boundary should be
// missed in normal operation — a missed check (e.g. the process was down)
// just means that one settlement isn't recorded, same as a coin having less
// than 30 days of real history on any other exchange.
//
// Persisted to disk the same way as lib/aprHistory.js's snapshots, so the
// accumulated history survives a redeploy instead of resetting to empty
// every time (full 30-day coverage still takes 30 real days to build from a
// cold start — there's no way around that without a real history endpoint).
const fs = require('fs');
const path = require('path');
const { dataDir } = require('./dataDir');

const MAX_POINTS = 760; // a bit over 31 days at Variational's shortest (1h) interval — mirrors cache.js's own MAX_HISTORY_LIMIT headroom
const STALE_SYMBOL_MS = 3 * 24 * 60 * 60 * 1000; // drop a market's series once it's gone missing (delisted, or filtered out as non-crypto) this long

// symbol -> { points: [{ time, rate }], cursor: { nextFundingTime, rate } | null, lastSeenAt }
const state = new Map();

const STORE_PATH = path.join(dataDir(), 'variational-funding-history.json');

function loadFromDisk() {
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return;
    for (const [symbol, entry] of Object.entries(parsed)) {
      if (entry && Array.isArray(entry.points)) {
        state.set(symbol, { points: entry.points, cursor: entry.cursor || null, lastSeenAt: entry.lastSeenAt || 0 });
      }
    }
  } catch {
    // No file yet (first boot, or no persistent disk attached) — start empty.
  }
}

function saveToDisk() {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    const obj = {};
    for (const [symbol, entry] of state) obj[symbol] = entry;
    fs.writeFileSync(STORE_PATH, JSON.stringify(obj));
  } catch (err) {
    console.error('Failed to persist Variational funding history:', err.message || err);
  }
}

loadFromDisk();

// Called once per market on every fetchCurrent() — records a settled
// funding event whenever that market's funding-period boundary has been
// crossed since the previous call, using the rate that was in effect right
// before the crossing (Variational's `funding.last` is the rate currently
// in effect heading into `next_timestamp`, not a rate already paid out —
// see the API docs — so the settlement that just happened used the PREVIOUS
// call's rate/timestamp pair, which is exactly what `cursor` holds).
function recordObservation(symbol, { rate, nextFundingTime }) {
  if (!Number.isFinite(rate) || !Number.isFinite(nextFundingTime)) return;
  const now = Date.now();
  const entry = state.get(symbol) || { points: [], cursor: null, lastSeenAt: 0 };
  entry.lastSeenAt = now;

  if (entry.cursor && now >= entry.cursor.nextFundingTime && nextFundingTime !== entry.cursor.nextFundingTime) {
    entry.points.push({ time: entry.cursor.nextFundingTime, rate: entry.cursor.rate });
    if (entry.points.length > MAX_POINTS) entry.points.splice(0, entry.points.length - MAX_POINTS);
  }
  entry.cursor = { nextFundingTime, rate };
  state.set(symbol, entry);
}

// Call once per fetchCurrent() cycle, after all of that cycle's
// recordObservation() calls — prunes stale series and persists to disk in a
// single write rather than one per market.
function flush() {
  const now = Date.now();
  for (const [symbol, entry] of state) {
    if (now - entry.lastSeenAt > STALE_SYMBOL_MS) state.delete(symbol);
  }
  saveToDisk();
}

// Returns the last `limit` settled funding events for one symbol, oldest
// first — or [] if nothing's accumulated yet (brand-new market, or the app
// only just started up and hasn't crossed a funding boundary for it since).
function getHistory(symbol, limit = 200) {
  const entry = state.get(symbol);
  if (!entry || !limit) return [];
  return entry.points.slice(-limit);
}

module.exports = { recordObservation, flush, getHistory };

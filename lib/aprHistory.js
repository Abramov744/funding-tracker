// Tracks how each row's *average* APR (the 30-day rolling metric in the
// "Ср. APR %" column) itself moves over time — separate from the funding-rate
// history chart, which shows individual settlements, not the trend of their
// average. A rolling 30-day average moves slowly by construction, so hourly
// snapshots are frequent enough to see a multi-day trend without the store
// growing unreasonably large.
const { getState } = require('./cache');

const SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const MAX_POINTS = 24 * 30; // 30 days of hourly points
const STALE_KEY_MS = 3 * 24 * 60 * 60 * 1000; // drop a coin's series if it hasn't appeared in 3 days

// "exchange:symbol" -> { points: [{ time, value }], lastSeenAt }
const state = new Map();

function keyOf(exchange, symbol) {
  return `${exchange}:${symbol}`;
}

// Reads whatever the funding cache currently holds and appends one point for
// every row that has a computed average APR (i.e. currently a candidate —
// rows without one don't have a meaningful trend to plot). Also prunes
// series for coins that have been gone long enough to call stale, so churn
// (a coin flickering in and out of candidacy) doesn't grow this unbounded.
function recordSnapshot() {
  const { rows } = getState();
  const now = Date.now();
  const seenThisCycle = new Set();

  for (const row of rows) {
    if (row.avgAprPct == null || !Number.isFinite(row.avgAprPct)) continue;
    const key = keyOf(row.exchange, row.symbol);
    seenThisCycle.add(key);

    const entry = state.get(key) || { points: [], lastSeenAt: 0 };
    entry.points.push({ time: now, value: row.avgAprPct });
    if (entry.points.length > MAX_POINTS) entry.points.splice(0, entry.points.length - MAX_POINTS);
    entry.lastSeenAt = now;
    state.set(key, entry);
  }

  for (const [key, entry] of state) {
    if (!seenThisCycle.has(key) && now - entry.lastSeenAt > STALE_KEY_MS) state.delete(key);
  }
}

// Returns [{ time, value }], oldest first, for one row — or [] if nothing's
// been recorded yet (e.g. the coin only just started trading, or the app
// only just started up and hasn't reached the first hourly snapshot).
function getHistory(exchange, symbol) {
  const entry = state.get(keyOf(exchange, symbol));
  return entry ? entry.points : [];
}

function startAutoSnapshot() {
  // A short head start rather than snapshotting immediately: right at boot
  // the funding cache's own first refresh is still in flight (it publishes
  // incrementally per exchange), so an instant snapshot would mostly record
  // nothing. This still gets an early first point without waiting a full
  // hour for one.
  setTimeout(recordSnapshot, 60 * 1000);
  setInterval(recordSnapshot, SNAPSHOT_INTERVAL_MS);
}

module.exports = { recordSnapshot, getHistory, startAutoSnapshot };

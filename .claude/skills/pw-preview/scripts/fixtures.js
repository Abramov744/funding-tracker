// Fixture builders matching the exact JSON shapes public/app.js expects from
// each endpoint (verified against server.js / lib/spreads.js / lib/cache.js
// as of the favorites-per-tab + spread-popup-price-row + APR-window-selector
// features). Keep these in sync if those response shapes ever change —
// app.js reads fields by name with no schema validation, so a stale fixture
// fails silently (a blank row, a "—" instead of a value) rather than erroring.
const fs = require('fs');
const path = require('path');

const HOUR = 60 * 60 * 1000;

// annualizedPct from lib/metrics.js, duplicated here so fixtures can report
// an internally-consistent aprPct/avgAprPct without importing server code.
function annualizedPct(rate, intervalHours) {
  if (!intervalHours || !Number.isFinite(rate)) return null;
  return rate * (8760 / intervalHours) * 100;
}

// One row of /api/funding's `rows` array (the main spot+short table).
function fundingRow(overrides = {}) {
  const base = {
    exchange: 'bitget',
    exchangeLabel: 'Bitget',
    symbol: 'BTCUSDT',
    baseAsset: 'BTC',
    marketCapRank: 1,
    openInterestUsd: 5e6,
    price: 90000,
    fundingRate: 0.001,
    intervalHours: 8,
    nextFundingTime: Date.now() + HOUR,
    historyChecked: true,
    periods: 90,
    positiveRatio: 0.9,
    minRate: 0.0002,
    maxRate: 0.0012,
    avgRate: 0.0009,
    currentStreak: 90,
  };
  const row = { ...base, ...overrides };
  row.aprPct = row.aprPct ?? annualizedPct(row.fundingRate, row.intervalHours);
  row.avgAprPct = row.avgAprPct ?? annualizedPct(row.avgRate, row.intervalHours);
  return row;
}

// One row of /api/spreads's `rows` array (the futures-futures spread tab).
function spreadRow(overrides = {}) {
  const base = {
    baseAsset: 'BTC',
    marketCapRank: 1,
    shortExchange: 'aster',
    shortExchangeLabel: 'Aster',
    shortSymbol: 'BTCUSDT',
    shortRate: 0.001,
    shortIntervalHours: 8,
    shortPrice: 90050,
    shortOpenInterestUsd: 5e6,
    shortNextFundingTime: Date.now() + HOUR,
    longExchange: 'hyperliquid',
    longExchangeLabel: 'Hyperliquid',
    longSymbol: 'BTC',
    longRate: -0.0001,
    longIntervalHours: 1,
    longPrice: 90000,
    longOpenInterestUsd: 8e6,
    longNextFundingTime: Date.now() + HOUR,
    periods: 720,
    positiveRatio: 1,
    minAprPct: 150,
    maxAprPct: 210,
    avgAprPct: 180.2,
  };
  const row = { ...base, ...overrides };
  const currentSpreadRate = row.shortRate / row.shortIntervalHours - row.longRate / row.longIntervalHours;
  row.spreadAprPct = row.spreadAprPct ?? annualizedPct(currentSpreadRate, 1);
  return row;
}

// A settlement-history array for /api/history — oldest first, `count`
// points `stepHours` apart, most recent at (approximately) now. Every point
// is nudged 5 minutes older than its clean grid slot so none of them sit
// exactly on a 24h-multiple day boundary — the popup's 1Д/7Д/15Д/30Д window
// selector filters by `time >= cutoff`, and a point sitting EXACTLY on a
// cutoff is flaky (whether it's in/out depends on the few ms between
// building this fixture and the browser evaluating Date.now() itself).
// Always use this offset for any fixture that will be filtered by that
// selector — see the postmortem in pw_apr_window_selector.js from the
// session that added it.
function history(count, stepHours, rate, { now = Date.now(), offsetMs = 5 * 60 * 1000 } = {}) {
  const rows = [];
  for (let i = count - 1; i >= 0; i--) {
    const h = i * stepHours;
    const r = typeof rate === 'function' ? rate(h, i) : rate;
    rows.push({ rate: r, time: now - h * HOUR - offsetMs });
  }
  return rows;
}

// A hoursly APR-trend snapshot array for /api/apr-history — same
// oldest-first + boundary-offset rules as history() above, but the value is
// the row's avgAprPct at that point in time, not a raw settlement rate.
function aprTrendPoints(count, stepHours, value, opts = {}) {
  return history(count, stepHours, 0, opts).map((p, i) => ({
    time: p.time,
    value: typeof value === 'function' ? value(i * stepHours, i) : value,
  }));
}

// GET/POST/DELETE /api/favorites(/:tab/:baseAsset) all return this shape.
function favoritesPayload(funding = [], spread = []) {
  return { funding, spread };
}

// Finds the Playwright-managed Chromium build without hardcoding its
// version number (the installed build number can change with environment
// image updates) — globs /opt/pw-browsers/chromium-*/chrome-linux/chrome and
// picks the newest match. Throws with a clear message if none is found.
function resolveChromiumExecutable() {
  const root = '/opt/pw-browsers';
  const entries = fs.readdirSync(root).filter((e) => e.startsWith('chromium-'));
  if (entries.length === 0) throw new Error(`No chromium-* build found under ${root}`);
  entries.sort(); // lexicographic sort works for the zero-padded build numbers Playwright uses
  const newest = entries[entries.length - 1];
  const exe = path.join(root, newest, 'chrome-linux', 'chrome');
  if (!fs.existsSync(exe)) throw new Error(`Expected chromium executable missing: ${exe}`);
  return exe;
}

module.exports = {
  annualizedPct,
  fundingRow,
  spreadRow,
  history,
  aprTrendPoints,
  favoritesPayload,
  resolveChromiumExecutable,
};

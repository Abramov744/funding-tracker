// Bitfinex USDt-margined perpetuals. Public endpoints, no API key needed.
// Docs: https://docs.bitfinex.com/reference/rest-public-derivatives-status
//       https://docs.bitfinex.com/reference/rest-public-derivatives-status-history
const { filterToCrypto } = require('../cryptoassets');

const BASE = 'https://api-pub.bitfinex.com/v2';
const INTERVAL_HOURS = 8;
const HISTORY_PAGE_SIZE = 5000;
const HISTORY_MAX_PAGES = 15;
const HISTORY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const REQUEST_GAP_MS = 700; // Bitfinex documents a 90 requests/minute limit.
const HISTORY_CACHE_TTL_MS = 4 * 60 * 1000;
const NON_CRYPTO_BASES = new Set([
  'EUR', 'GBP', 'UKOIL',
  'XAU', 'XAUT', 'XAG', 'XPT', 'XPD',
  'EVIV', 'BVIV', // derivatives volatility indices, not spot crypto assets
]);

let keyByBase = new Map();
let historyCache = new Map();
let lastHistoryRequestAt = 0;
let requestQueue = Promise.resolve();

function parseKey(key) {
  const match = /^t([A-Z0-9]+)F0:USTF0$/.exec(String(key || ''));
  return match ? match[1] : null;
}

function isCryptoMarketKey(key) {
  const base = parseKey(key);
  return Boolean(base && !NON_CRYPTO_BASES.has(base) && !base.endsWith('IX'));
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { 'User-Agent': 'funding-tracker/1.0' } });
  if (!res.ok) throw new Error(`Bitfinex ${path} -> HTTP ${res.status}`);
  return res.json();
}

// Bitfinex documents up to 90 requests/minute. Serialize history paging and
// leave a small margin so multiple candidate symbols cannot burst past it.
function getHistoryJson(path) {
  const task = requestQueue.then(async () => {
    const waitMs = Math.max(0, REQUEST_GAP_MS - (Date.now() - lastHistoryRequestAt));
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    const result = await getJson(path);
    lastHistoryRequestAt = Date.now();
    return result;
  });
  requestQueue = task.catch(() => {});
  return task;
}

async function fetchCurrent() {
  const statuses = await getJson('/status/deriv?keys=ALL');
  if (!Array.isArray(statuses)) throw new Error('Bitfinex status response is not an array');

  const eligible = statuses
    .map((status) => ({ status, base: Array.isArray(status) ? parseKey(status[0]) : null }))
    .filter(({ status, base }) =>
      Array.isArray(status) &&
      isCryptoMarketKey(status[0]) &&
      base &&
      finite(status[9]) !== null &&
      finite(status[15] || status[3]) > 0
    );

  const crypto = filterToCrypto(eligible, {
    exchange: 'bitfinex',
    symbolOf: (item) => item.base,
    priceOf: (item) => finite(item.status[15]) || finite(item.status[3]),
  });

  keyByBase = new Map();
  return crypto.map(({ status, base }) => {
    keyByBase.set(base, status[0]);
    return {
      exchange: 'bitfinex',
      symbol: base,
      // NEXT_FUNDING_ACCRUED is the running estimate for the upcoming
      // settlement; CURRENT_FUNDING is the rate already applied in this
      // period and is used only when reconstructing historical settlements.
      fundingRate: finite(status[9]),
      intervalHours: INTERVAL_HOURS,
      nextFundingTime: finite(status[8]),
      price: finite(status[15]) || finite(status[3]),
      // OPEN_INTEREST is a contract count on Bitfinex, and the public status
      // endpoint does not expose enough contract metadata to convert it safely
      // to USD notional. Leave OI and 24h volume unknown rather than mislabel.
      openInterestUsd: null,
      volume24hUsd: null,
    };
  });
}

function normalizeHistory(rows, cutoff) {
  const byPeriod = new Map();
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const time = finite(row[0]);
    const nextFundingTime = finite(row[7]);
    const rate = finite(row[11]);
    if (time === null || time < cutoff || nextFundingTime === null || rate === null) continue;

    // Status history records repeat throughout the 8h funding period. Keep
    // just the newest snapshot for each next-settlement timestamp.
    const previous = byPeriod.get(nextFundingTime);
    if (!previous || time > previous.time) byPeriod.set(nextFundingTime, { rate, time });
  }
  return [...byPeriod.values()].sort((a, b) => a.time - b.time);
}

async function fetchHistory(symbol, limit = 90) {
  const cached = historyCache.get(symbol);
  if (cached && Date.now() - cached.fetchedAt < HISTORY_CACHE_TTL_MS) {
    return cached.history.slice(-limit);
  }

  const key = keyByBase.get(symbol);
  if (!key) throw new Error(`Bitfinex: unknown market for symbol ${symbol}`);

  const cutoff = Date.now() - HISTORY_WINDOW_MS;
  const snapshots = [];
  let end = Date.now();
  let previousOldest = Infinity;

  for (let page = 0; page < HISTORY_MAX_PAGES; page++) {
    const path = `/status/deriv/${encodeURIComponent(key)}/hist?limit=${HISTORY_PAGE_SIZE}&sort=-1&end=${end}`;
    const rows = await getHistoryJson(path);
    if (!Array.isArray(rows) || rows.length === 0) break;

    let oldest = Infinity;
    for (const row of rows) {
      const time = Array.isArray(row) ? finite(row[0]) : null;
      if (time !== null) {
        oldest = Math.min(oldest, time);
        if (time >= cutoff) snapshots.push(row);
      }
    }
    if (oldest <= cutoff || oldest >= previousOldest || rows.length < HISTORY_PAGE_SIZE) break;
    previousOldest = oldest;
    end = oldest - 1;
  }

  const history = normalizeHistory(snapshots, cutoff);
  historyCache.set(symbol, { history, fetchedAt: Date.now() });
  return history.slice(-limit);
}

module.exports = {
  id: 'bitfinex',
  label: 'Bitfinex',
  // Only the four strongest positive and negative markets are fully enriched
  // each refresh. Paging the 30-day history is intentionally rate-limited.
  maxHistoryCandidates: 2,
  maxNegativeHistoryCandidates: 2,
  fetchCurrent,
  fetchHistory,
  parseKey,
  isCryptoMarketKey,
  normalizeHistory,
};

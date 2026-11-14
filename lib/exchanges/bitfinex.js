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
// Base-asset units represented by one Bitfinex derivative contract, from the
// official per-product specifications. OI is reported in contract counts;
// ticker volume is reported in the same market quantity units.
const BASE_UNITS_PER_CONTRACT = {
  BTC: 1, ETH: 1, ADA: 1000, DOGE: 1000, SHIB: 100000, IOT: 1000,
  LTC: 1, DOT: 100, XLM: 1000, SOL: 1, UNI: 100, LINK: 10,
  SUSHI: 100, FIL: 100, AVAX: 100, XRP: 100, ALG: 100, EGLD: 1,
  AAVE: 1, AXS: 1, COMP: 1, XTZ: 100, TRX: 1000, ATO: 10,
  ZEC: 1, NEO: 10, CRV: 100, ICP: 10, NEAR: 100, GALA: 1000,
  APE: 10, ETC: 10, JASMY: 1000, SAND: 100, APT: 100, ARB: 100,
  BNB: 1, TON: 10, POL: 100, PEPE: 100000, CHZ: 1000, SUI: 100,
  HBAR: 1000, TAO: 100, ONDO: 100, ENA: 1000, SEI: 1000,
  LDO: 1000, HYPE: 100, FET: 1000, XPL: 1000, INJ: 100,
  JTO: 1000, ZRO: 1000, XDC: 1000, DEXE: 100, ALLO: 1000,
  KAITO: 1000, LIT: 100,
};

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

function contractMetricToUsd(amount, price, base) {
  const value = finite(amount);
  const mark = finite(price);
  const unitsPerContract = BASE_UNITS_PER_CONTRACT[base];
  if (value === null || mark === null || mark <= 0 || !unitsPerContract) return null;
  return Math.abs(value) * unitsPerContract * mark;
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

  let tickers = [];
  if (crypto.length) {
    const symbols = crypto.map(({ status }) => status[0]).join(',');
    try {
      tickers = await getJson(`/tickers?symbols=${encodeURIComponent(symbols)}`);
      if (!Array.isArray(tickers)) tickers = [];
    } catch (err) {
      // Funding and price are still useful if the separate ticker endpoint is
      // temporarily unavailable; only liquidity metrics degrade to null.
      console.warn(`Bitfinex tickers unavailable: ${err.message || err}`);
    }
  }
  const tickerByKey = new Map(tickers.filter(Array.isArray).map((ticker) => [ticker[0], ticker]));

  keyByBase = new Map();
  return crypto.map(({ status, base }) => {
    keyByBase.set(base, status[0]);
    const price = finite(status[15]) || finite(status[3]);
    const ticker = tickerByKey.get(status[0]);
    const tickerPrice = (ticker && finite(ticker[7])) || price;
    return {
      exchange: 'bitfinex',
      symbol: base,
      // NEXT_FUNDING_ACCRUED is the running estimate for the upcoming
      // settlement; CURRENT_FUNDING is the rate already applied in this
      // period and is used only when reconstructing historical settlements.
      fundingRate: finite(status[9]),
      intervalHours: INTERVAL_HOURS,
      nextFundingTime: finite(status[8]),
      price,
      // The status endpoint reports OI in contracts; the official product
      // size converts each contract to base-asset units before USD valuation.
      openInterestUsd: contractMetricToUsd(status[18], price, base),
      // Trading-pair ticker volume is contract quantity over the last 24h.
      volume24hUsd: contractMetricToUsd(ticker && ticker[8], tickerPrice, base),
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
  contractMetricToUsd,
  normalizeHistory,
};

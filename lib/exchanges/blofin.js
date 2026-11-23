// BloFin USDT/USDC-margined linear perpetuals. Public market-data API.
// Docs: https://docs.blofin.com/index.html
const { filterToCrypto } = require('../cryptoassets');

const BASE = 'https://openapi.blofin.com';
const HISTORY_PAGE_SIZE = 100;
const HISTORY_CACHE_TTL_MS = 8 * 60 * 1000;
const HISTORY_MIN_GAP_MS = 125; // Stay below BloFin's 500 requests/minute IP limit.

let contractValueBySymbol = new Map();
let historyCache = new Map();
let historyQueue = Promise.resolve();
let lastHistoryRequestAt = 0;

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { 'User-Agent': 'funding-tracker/1.0' } });
  if (!res.ok) throw new Error(`BloFin ${path} -> HTTP ${res.status}`);
  const body = await res.json();
  if (String(body.code) !== '0') throw new Error(`BloFin ${path} -> ${body.code} ${body.msg || 'API error'}`);
  return body.data;
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function intervalHours(rate) {
  const amount = finite(rate.fundingInterval);
  if (!amount || amount <= 0) return null;
  if (rate.fundingIntervalUnit === 'minute') return amount / 60;
  if (rate.fundingIntervalUnit === 'hour') return amount;
  return null;
}

async function fetchCurrent() {
  const [instruments, tickers, marks, rates] = await Promise.all([
    getJson('/api/v1/market/instruments?apiPermission=full'),
    getJson('/api/v1/market/tickers'),
    getJson('/api/v1/market/mark-price'),
    getJson('/api/v1/market/funding-rate'),
  ]);
  if (![instruments, tickers, marks, rates].every(Array.isArray)) {
    throw new Error('BloFin: unexpected public market-data response');
  }

  const active = instruments.filter((item) =>
    item.state === 'live' && item.instType === 'SWAP' && item.contractType === 'linear' &&
    ['USDT', 'USDC'].includes(item.quoteCurrency) && item.settleCurrency === item.quoteCurrency &&
    item.assetClass === 'Crypto' && finite(item.contractValue) > 0
  );
  const tickerBySymbol = new Map(tickers.map((item) => [item.instId, item]));
  const markBySymbol = new Map(marks.map((item) => [item.instId, item]));
  const rateBySymbol = new Map(rates.map((item) => [item.instId, item]));
  contractValueBySymbol = new Map(active.map((item) => [item.instId, Number(item.contractValue)]));

  const eligible = active.filter((item) => rateBySymbol.has(item.instId));
  const crypto = filterToCrypto(eligible, {
    exchange: 'blofin',
    symbolOf: (item) => item.baseCurrency,
    priceOf: (item) => finite(markBySymbol.get(item.instId)?.markPrice) || finite(tickerBySymbol.get(item.instId)?.last),
  });

  return crypto.map((instrument) => {
    const ticker = tickerBySymbol.get(instrument.instId) || {};
    const mark = markBySymbol.get(instrument.instId) || {};
    const rate = rateBySymbol.get(instrument.instId);
    const price = finite(mark.markPrice) || finite(ticker.last);
    const baseVolume = finite(ticker.volCurrency24h);
    const fundingTime = finite(rate.fundingTime);
    return {
      exchange: 'blofin',
      // Keep the full instrument ID so USDT and USDC markets for one asset
      // have independent history and cannot overwrite one another.
      symbol: instrument.instId,
      fundingRate: finite(rate.fundingRate),
      intervalHours: intervalHours(rate),
      nextFundingTime: fundingTime,
      price,
      // BloFin's documented public market-data schema does not expose OI.
      openInterestUsd: null,
      // volCurrency24h is base-asset volume; multiply by the market price to
      // express the turnover in USDT/USDC, which is approximately USD.
      volume24hUsd: baseVolume !== null && price ? baseVolume * price : null,
    };
  }).filter((row) => row.fundingRate !== null);
}

function getContractValue(symbol) {
  return contractValueBySymbol.get(symbol) || null;
}

async function loadContractValue(symbol) {
  const cached = getContractValue(symbol);
  if (cached) return cached;
  const rows = await getJson(`/api/v1/market/instruments?instId=${encodeURIComponent(symbol)}`);
  const item = Array.isArray(rows) ? rows.find((row) => row.instId === symbol) : null;
  if (!item || item.contractType !== 'linear' || !['USDT', 'USDC'].includes(item.quoteCurrency)) {
    throw new Error(`BloFin: linear USDT/USDC contract ${symbol} was not found`);
  }
  const value = finite(item.contractValue);
  if (!value || value <= 0) throw new Error(`BloFin: invalid contract value for ${symbol}`);
  contractValueBySymbol.set(symbol, value);
  return value;
}

function getHistoryPage(path) {
  const task = historyQueue.then(async () => {
    const waitMs = Math.max(0, HISTORY_MIN_GAP_MS - (Date.now() - lastHistoryRequestAt));
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    lastHistoryRequestAt = Date.now();
    return getJson(path);
  });
  historyQueue = task.catch(() => {});
  return task;
}

async function fetchHistory(symbol, limit = 750) {
  const cached = historyCache.get(symbol);
  if (cached && cached.limit >= limit && Date.now() - cached.fetchedAt < HISTORY_CACHE_TTL_MS) {
    return cached.history.slice(-limit);
  }

  const rows = [];
  const seen = new Set();
  let after = null;
  const maxPages = Math.ceil(Math.max(1, limit) / HISTORY_PAGE_SIZE) + 1;
  for (let page = 0; page < maxPages && rows.length < limit; page += 1) {
    const query = new URLSearchParams({ instId: symbol, limit: String(HISTORY_PAGE_SIZE) });
    if (after) query.set('after', after);
    const pageRows = await getHistoryPage(`/api/v1/market/funding-rate-history?${query.toString()}`);
    if (!Array.isArray(pageRows) || !pageRows.length) break;

    for (const row of pageRows) {
      const rate = finite(row.fundingRate);
      const time = finite(row.fundingTime);
      if (rate === null || time === null || (row.fundingKind !== undefined && String(row.fundingKind) !== '0') || seen.has(time)) continue;
      seen.add(time);
      rows.push({ rate, time });
    }
    if (pageRows.length < HISTORY_PAGE_SIZE) break;
    const oldest = pageRows.reduce((min, row) => Math.min(min, finite(row.fundingTime) ?? Infinity), Infinity);
    if (!Number.isFinite(oldest) || String(oldest) === after) break;
    after = String(oldest);
  }

  const history = rows.sort((a, b) => a.time - b.time).slice(-limit);
  historyCache.set(symbol, { limit, history, fetchedAt: Date.now() });
  return history;
}

module.exports = {
  id: 'blofin',
  label: 'BloFin',
  maxHistoryCandidates: 80,
  maxNegativeHistoryCandidates: 40,
  fetchCurrent,
  fetchHistory,
  getContractValue,
  loadContractValue,
};

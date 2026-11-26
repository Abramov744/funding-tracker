// Public linear USDT perpetuals. https://api-docs.toobit.com/api/usdt-m-market-data.html
const { setTimeout: delay } = require('node:timers/promises');

const BASE = 'https://api.toobit.com';
const MARKET_TTL_MS = 5 * 60_000;
let marketCache;
let marketRequest;
let requestQueue = Promise.resolve();
let nextRequestAt = 0;

async function getJson(path) {
  // Share pacing across refreshes, history popups and order books.
  const turn = requestQueue.then(async () => {
    while (Date.now() < nextRequestAt) await delay(nextRequestAt - Date.now());
    nextRequestAt = Date.now() + 100;
  });
  requestQueue = turn;
  await turn;
  const response = await fetch(BASE + path, { signal: AbortSignal.timeout(15_000) });
  if (response.status === 429) {
    const reset = Number(response.headers.get('X-Api-Limit-Reset-Timestamp'));
    nextRequestAt = Math.max(nextRequestAt, Date.now() + 1_000, reset || 0);
  }
  if (!response.ok) throw new Error(`Toobit ${path} -> HTTP ${response.status}`);
  return response.json();
}

function finite(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function periodHours(period) {
  const match = /^(\d+)H$/.exec(period);
  return match ? Number(match[1]) || null : null;
}

async function loadMarkets() {
  if (marketCache && Date.now() < marketCache.expiresAt) return marketCache.contracts;
  marketRequest ??= getJson('/api/v1/exchangeInfo').then(({ contracts }) => {
    const active = contracts.filter((market) => market.status === 'TRADING'
      && market.inverse === false && market.marginToken === 'USDT' && market.quoteAsset === 'USDT'
      && market.isRwa === false && market.symbol.endsWith('-SWAP-USDT'));
    const bySymbol = new Map(active.map((market) => [market.symbol, market]));
    marketCache = { contracts: bySymbol, expiresAt: Date.now() + MARKET_TTL_MS };
    return bySymbol;
  }).finally(() => { marketRequest = null; });
  return marketRequest;
}

async function fetchCurrent() {
  const [markets, rates, marks, tickers] = await Promise.all([
    loadMarkets(),
    getJson('/api/v1/futures/fundingRate'),
    getJson('/quote/v1/markPrice'),
    getJson('/quote/v1/contract/ticker/24hr'),
  ]);
  const markBySymbol = new Map(marks.map((row) => [row.symbolId, row.price]));
  const tickerBySymbol = new Map(tickers.map((row) => [row.si ?? row.s, row]));
  return rates.filter((row) => markets.has(row.symbol)).map((row) => {
    const ticker = tickerBySymbol.get(row.symbol);
    return {
      exchange: 'toobit',
      symbol: row.symbol,
      fundingRate: finite(row.rate),
      intervalHours: periodHours(row.period),
      nextFundingTime: finite(row.nextFundingTime),
      price: finite(markBySymbol.get(row.symbol)) ?? finite(ticker?.c),
      volume24hUsd: finite(ticker?.qv),
      openInterestUsd: null,
    };
  }).filter((row) => row.fundingRate !== null && row.intervalHours !== null);
}

async function fetchHistory(symbol, limit = 200, intervalHours) {
  const cutoff = Date.now() - 30 * 24 * 60 * 60_000;
  const requested = Math.min(1000, Math.max(1, limit));
  const path = `/api/v1/futures/historyFundingRate?symbol=${encodeURIComponent(symbol)}&limit=`;
  let rows = await getJson(path + requested);
  // If the settlement interval recently increased, the current interval may
  // undercount the records needed for the 30-day window.
  if (intervalHours && requested >= Math.ceil(30 * 24 / intervalHours)
      && rows.length === requested && requested < 1000
      && rows.every((row) => Number(row.settleTime) > cutoff)) {
    rows = await getJson(path + 1000);
  }
  return rows.map((row) => ({
    rate: finite(row.settleRate),
    time: finite(row.settleTime),
    intervalHours: periodHours(row.period),
  })).filter((row) => row.rate !== null && row.time > 0).sort((a, b) => a.time - b.time);
}

async function fetchOpenInterest(symbol, price) {
  if (!Number.isFinite(price) || price <= 0) return null;
  const { openInterestList } = await getJson(`/quote/v1/openInterest?symbol=${encodeURIComponent(symbol)}`);
  const size = finite(openInterestList.find((row) => row.symbol === symbol)?.size);
  return size === null ? null : size * price;
}

async function loadContractMultiplier(symbol) {
  const market = (await loadMarkets()).get(symbol);
  const multiplier = finite(market?.contractMultiplier);
  if (!(multiplier > 0)) throw new Error(`Toobit: неизвестен размер контракта ${symbol}.`);
  return multiplier;
}

function fetchDepth(symbol) {
  return getJson(`/quote/v1/depth?symbol=${encodeURIComponent(symbol)}&limit=100`);
}

module.exports = {
  id: 'toobit', label: 'Toobit', fetchCurrent, fetchHistory, fetchOpenInterest, loadContractMultiplier, fetchDepth,
};

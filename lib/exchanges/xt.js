// XT.COM USDT-margined perpetuals. Public endpoints, no API key required.
// Docs: https://doc.xt.com/docs/futures/Quote%20collection/get-futures-info
//       https://doc.xt.com/docs/futures/MarketData/get-funding-rate-records
const { filterToCrypto } = require('../cryptoassets');

const BASE = 'https://fapi.xt.com/future/market/v1/public';
const HISTORY_PAGE_SIZE = 100;

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { 'User-Agent': 'funding-tracker/1.0' } });
  if (!res.ok) throw new Error(`XT.COM ${path} -> HTTP ${res.status}`);
  const body = await res.json();
  // The CoinGecko-compatible bulk contract endpoint is the one exception:
  // it returns a bare array, while the q/* endpoints use XT's result envelope.
  if (path === '/cg/contracts') return body;
  if (Number(body.returnCode) !== 0) {
    throw new Error(`XT.COM ${path} -> ${body.error?.code || body.returnCode}: ${body.error?.msg || body.msgInfo || 'API error'}`);
  }
  return body.result;
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function fetchCurrent() {
  const result = await getJson('/cg/contracts');
  if (!Array.isArray(result)) throw new Error('XT.COM: unexpected contracts response');

  const contracts = result.filter((item) =>
    item && String(item.underlyingType) === '2'
      && String(item.product_type || '').toUpperCase() === 'PERPETUAL'
      && String(item.target_currency || '').toUpperCase() === 'USDT'
      && finite(item.last_price) > 0
  );
  const crypto = filterToCrypto(contracts, {
    exchange: 'xt',
    symbolOf: (item) => item.base_currency || String(item.symbol).split('_')[0],
    priceOf: (item) => finite(item.last_price),
  });

  return crypto.map((item) => {
    const intervalMinutes = finite(item.funding_interval_minutes);
    const collectionHours = finite(item.collection_internal);
    return {
      exchange: 'xt',
      symbol: String(item.symbol).toUpperCase(),
      fundingRate: finite(item.funding_rate),
      intervalHours: intervalMinutes > 0 ? intervalMinutes / 60 : (collectionHours > 0 ? collectionHours : null),
      nextFundingTime: finite(item.next_funding_rate_timestamp),
      price: finite(item.last_price),
      openInterestUsd: finite(item.open_interest_usd),
      volume24hUsd: finite(item.target_volume),
    };
  }).filter((row) => Number.isFinite(row.fundingRate));
}

async function fetchHistory(symbol, limit = 750) {
  const wanted = Math.min(750, Math.max(1, Math.floor(Number(limit) || 1)));
  const pair = String(symbol).toLowerCase().replace(/[-/]/g, '_');
  const rows = [];
  let cursor = null;

  while (rows.length < wanted) {
    const pageLimit = Math.min(HISTORY_PAGE_SIZE, wanted - rows.length);
    const query = new URLSearchParams({ symbol: pair, direction: 'PREV', limit: String(pageLimit) });
    if (cursor !== null) query.set('id', String(cursor));
    const result = await getJson(`/q/funding-rate-record?${query}`);
    const items = Array.isArray(result?.items) ? result.items : [];
    if (!items.length) break;
    rows.push(...items.map((item) => ({ rate: finite(item.fundingRate), time: finite(item.createdTime) }))
      .filter((item) => Number.isFinite(item.rate) && Number.isFinite(item.time)));
    const oldest = items.reduce((min, item) => Math.min(min, Number(item.id)), Infinity);
    if (!result.hasPrev || !Number.isFinite(oldest) || oldest <= 0 || oldest === cursor) break;
    cursor = oldest;
  }

  const unique = new Map();
  for (const row of rows) unique.set(row.time, row);
  return [...unique.values()].sort((a, b) => a.time - b.time).slice(-wanted);
}

module.exports = { id: 'xt', label: 'XT.COM', fetchCurrent, fetchHistory };

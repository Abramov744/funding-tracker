// ApeX Omni — perpetual DEX, public REST API, no key needed. The docs site
// (api-docs.omni.apex.exchange) isn't reachable from this environment, so
// these endpoints/fields were confirmed against real response samples.
const { mapWithConcurrency } = require('../pool');

const BASE = 'https://omni.apex.exchange';
const INTERVAL_HOURS = 1; // ApeX Omni settles funding hourly (most CEXs use 8h)
const CONCURRENCY = 8;

async function getJson(path) {
  const res = await fetch(BASE + path, { headers: { 'User-Agent': 'funding-tracker/1.0' } });
  if (!res.ok) throw new Error(`ApeX ${path} -> HTTP ${res.status}`);
  const body = await res.json();
  return body.data;
}

// Returns current funding snapshot for every tradable USDT-margined perpetual.
// ApeX has no bulk "current funding rate for every instrument" call — like
// OKX, /api/v3/ticker only returns something when a specific `symbol` is
// given (an empty `symbol` just comes back with an empty list) — so this
// fans out one ticker lookup per contract with bounded concurrency.
async function fetchCurrent() {
  const config = await getJson('/api/v3/symbols');
  const contracts = ((config && config.contractConfig && config.contractConfig.perpetualContract) || []).filter(
    (c) => c.enableTrade && c.symbolDisplayName
  );

  const results = await mapWithConcurrency(contracts, CONCURRENCY, async (c) => {
    const tickers = await getJson(`/api/v3/ticker?symbol=${encodeURIComponent(c.symbolDisplayName)}`);
    const t = Array.isArray(tickers) ? tickers[0] : tickers;
    if (!t || t.fundingRate === undefined || t.fundingRate === null) return null;

    const nextFundingTime = Date.parse(t.nextFundingTime); // e.g. "2026-09-05T14:00:00Z"
    // oraclePrice comes back as an empty string on live tickers — markPrice is
    // the one that's actually populated; lastPrice is the final fallback.
    const price = Number(t.markPrice) || Number(t.oraclePrice) || Number(t.lastPrice) || null;

    return {
      exchange: 'apex',
      symbol: c.symbolDisplayName,
      fundingRate: Number(t.fundingRate),
      intervalHours: INTERVAL_HOURS,
      nextFundingTime: Number.isFinite(nextFundingTime) ? nextFundingTime : null,
      price,
    };
  });

  return results.filter((r) => r && !r.error && Number.isFinite(r.fundingRate));
}

// The ticker and history-funding endpoints disagree on symbol format: ticker
// uses the concatenated form ("BTCUSDT"), history-funding wants it hyphenated
// ("BTC-USDT"). Every Omni perpetual is USDT-margined (confirmed across all
// 138 listed contracts), so this just splits before the trailing USDT.
function toHyphenatedSymbol(symbol) {
  return symbol.endsWith('USDT') ? `${symbol.slice(0, -4)}-USDT` : symbol;
}

// Returns the last `limit` funding-rate settlements for one symbol, oldest first.
async function fetchHistory(symbol, limit = 200) {
  const hyphenated = toHyphenatedSymbol(symbol);
  const rows = (await getJson(`/api/v3/history-funding?symbol=${encodeURIComponent(hyphenated)}&limit=${limit}`)) || [];

  return rows
    .map((r) => {
      const rate = Number(r.rate);
      let time = Number(r.fundingTimestamp ?? r.fundingTime);
      if (Number.isFinite(time) && time > 0 && time < 1e12) time *= 1000; // in case it ever comes back in seconds
      return { rate, time };
    })
    .filter((r) => Number.isFinite(r.rate) && Number.isFinite(r.time))
    .sort((a, b) => a.time - b.time)
    .slice(-limit);
}

module.exports = { id: 'apex', label: 'ApeX', fetchCurrent, fetchHistory };

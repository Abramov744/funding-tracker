// dYdX v4 — perpetual DEX, public Indexer REST API, no key needed.
// Docs: https://docs.dydx.xyz/indexer-client/http
const BASE = 'https://indexer.dydx.trade/v4';
const INTERVAL_HOURS = 1; // dYdX v4 settles funding hourly (continuous funding model)

async function getJson(path) {
  const res = await fetch(BASE + path, { headers: { 'User-Agent': 'funding-tracker/1.0' } });
  if (!res.ok) throw new Error(`dYdX ${path} -> HTTP ${res.status}`);
  return res.json();
}

// Returns current funding snapshot for every active perpetual market.
// /perpetualMarkets replies with `markets` as an object keyed by ticker, not an array.
async function fetchCurrent() {
  const data = await getJson('/perpetualMarkets');
  const markets = Object.values(data.markets || {});

  return markets
    .filter((m) => m.status === 'ACTIVE' && m.nextFundingRate !== undefined && m.nextFundingRate !== null)
    .map((m) => ({
      exchange: 'dydx',
      symbol: m.ticker,
      fundingRate: Number(m.nextFundingRate),
      intervalHours: INTERVAL_HOURS,
      nextFundingTime: null,
      price: Number(m.oraclePrice) || null,
    }));
}

// Returns the last `limit` funding-rate settlements for one symbol, oldest first.
async function fetchHistory(symbol, limit = 200) {
  const data = await getJson(`/historicalFunding?ticker=${encodeURIComponent(symbol)}&limit=${limit}`);
  const rows = data.historicalFunding || [];

  return rows
    .map((r) => ({ rate: Number(r.rate), time: Date.parse(r.effectiveAt) }))
    .filter((r) => Number.isFinite(r.rate) && Number.isFinite(r.time))
    .sort((a, b) => a.time - b.time);
}

module.exports = { id: 'dydx', label: 'dYdX', fetchCurrent, fetchHistory };

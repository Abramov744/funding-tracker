// Paradex — StarkNet-based perpetual DEX, public REST API, no key needed.
// Docs: https://docs.paradex.trade/api-reference
//
// Unlike the CEXs above, Paradex funding is continuous/hourly rather than settled
// every 8h — the API doesn't expose a "next funding time" the way the others do.
const BASE = 'https://api.prod.paradex.trade/v1';
const FUNDING_INTERVAL_HOURS = 1;

async function getJson(path) {
  const res = await fetch(BASE + path, { headers: { 'User-Agent': 'funding-tracker/1.0' } });
  if (!res.ok) throw new Error(`Paradex ${path} -> HTTP ${res.status}`);
  return res.json();
}

// Returns current funding snapshot for every open USD-settled perpetual on Paradex.
async function fetchCurrent() {
  const [markets, summary] = await Promise.all([getJson('/markets'), getJson('/markets/summary?market=ALL')]);

  const perpSymbols = new Set(
    (markets.results || [])
      .filter((m) => m.asset_kind === 'PERP' && m.quote_currency === 'USD')
      .map((m) => m.symbol)
  );

  return (summary.results || [])
    .filter((s) => perpSymbols.has(s.symbol) && s.funding_rate !== undefined && s.funding_rate !== null)
    .map((s) => ({
      exchange: 'paradex',
      symbol: s.symbol,
      fundingRate: Number(s.funding_rate),
      intervalHours: FUNDING_INTERVAL_HOURS,
      nextFundingTime: null,
      price: Number(s.mark_price) || null,
    }));
}

// Returns the last `limit` funding-rate settlements for one symbol, oldest first.
async function fetchHistory(symbol, limit = 200) {
  const data = await getJson(`/funding/data?market=${encodeURIComponent(symbol)}&page_size=${limit}`);
  return (data.results || [])
    .map((r) => ({ rate: Number(r.funding_rate), time: Date.parse(r.created_at) }))
    .sort((a, b) => a.time - b.time); // be defensive about the API's actual sort order
}

module.exports = { id: 'paradex', label: 'Paradex', fetchCurrent, fetchHistory };

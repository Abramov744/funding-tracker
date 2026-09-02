// Paradex — StarkNet-based perpetual DEX, public REST API, no key needed.
// Docs: https://docs.paradex.trade/api-reference
const BASE = 'https://api.prod.paradex.trade/v1';
const DEFAULT_INTERVAL_HOURS = 8; // confirmed via /funding/data's funding_period_hours field

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
      // /markets/summary doesn't always carry funding_period_hours — fall back to the
      // exchange-wide default (confirmed 8h via /funding/data) when it's missing.
      intervalHours: Number(s.funding_period_hours) || DEFAULT_INTERVAL_HOURS,
      nextFundingTime: null,
      price: Number(s.mark_price) || null,
    }));
}

// Paradex doesn't expose discrete "settlement" history the way the other exchanges
// do — /funding/data instead streams a continuous mark-to-market snapshot roughly
// every 5 seconds, so a single request only ever covers a few hours of raw ticks.
// created_at is a unix-ms integer, NOT an ISO string (Date.parse() on it silently
// returns NaN, which is why history used to render as empty).
//
// We downsample to ~1 point per funding period so the chart shows sensible bars
// instead of thousands of near-identical sub-period ticks, and request a generous
// batch to make the most of what a single page can return.
async function fetchHistory(symbol, limit = 200, intervalHours = DEFAULT_INTERVAL_HOURS) {
  const pageSize = Math.min(Math.max(limit * 20, 500), 5000);
  const data = await getJson(`/funding/data?market=${encodeURIComponent(symbol)}&page_size=${pageSize}`);

  const raw = (data.results || [])
    .map((r) => ({ rate: Number(r.funding_rate), time: Number(r.created_at) }))
    .filter((r) => Number.isFinite(r.rate) && Number.isFinite(r.time))
    .sort((a, b) => a.time - b.time);

  const bucketMs = intervalHours * 60 * 60 * 1000;
  const byBucket = new Map();
  for (const point of raw) {
    byBucket.set(Math.floor(point.time / bucketMs), point); // keep the latest sample per bucket
  }

  return Array.from(byBucket.values())
    .sort((a, b) => a.time - b.time)
    .slice(-limit);
}

module.exports = { id: 'paradex', label: 'Paradex', fetchCurrent, fetchHistory };

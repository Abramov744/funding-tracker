// Coinbase International Exchange — Coinbase's non-US/institutional perpetual
// futures venue (distinct from the retail-facing Coinbase Advanced/Exchange spot
// API and from the US-regulated, dated-futures-only Coinbase Derivatives Exchange).
// Public market-data API, no key needed.
// Docs: https://docs.cdp.coinbase.com/intx/reference
const BASE = 'https://api.international.coinbase.com/api/v1';
const DEFAULT_INTERVAL_HOURS = 1; // Coinbase INTL settles funding hourly

async function getJson(path) {
  const res = await fetch(BASE + path, { headers: { 'User-Agent': 'funding-tracker/1.0' } });
  if (!res.ok) throw new Error(`Coinbase INTL ${path} -> HTTP ${res.status}`);
  return res.json();
}

// Returns current funding snapshot for every perpetual on Coinbase INTL.
// Only rows that actually carry live quote/funding data survive the filter, which
// doubles as the "is this instrument actually trading" check.
async function fetchCurrent() {
  const instruments = await getJson('/instruments');

  return (instruments || [])
    .filter(
      (i) =>
        i.type === 'PERP' &&
        i.quote &&
        i.quote.predicted_funding !== undefined &&
        i.quote.predicted_funding !== null
    )
    .map((i) => ({
      exchange: 'coinbase-intl',
      symbol: i.symbol,
      fundingRate: Number(i.quote.predicted_funding),
      intervalHours: DEFAULT_INTERVAL_HOURS,
      nextFundingTime: null,
      price: Number(i.quote.mark_price) || null,
    }));
}

// Returns the last `limit` funding-rate settlements for one symbol, oldest first.
// event_time's exact format (ISO string vs. unix timestamp) isn't confirmed against
// live traffic, so both are handled defensively rather than assuming one.
async function fetchHistory(symbol, limit = 200) {
  const data = await getJson(`/instruments/${encodeURIComponent(symbol)}/funding?result_limit=${limit}`);
  const rows = Array.isArray(data) ? data : data.results || [];

  return rows
    .map((r) => ({
      rate: Number(r.funding_rate),
      time: Number.isFinite(Number(r.event_time)) ? Number(r.event_time) : Date.parse(r.event_time),
    }))
    .filter((r) => Number.isFinite(r.rate) && Number.isFinite(r.time))
    .sort((a, b) => a.time - b.time);
}

module.exports = { id: 'coinbase-intl', label: 'Coinbase INTL', fetchCurrent, fetchHistory };

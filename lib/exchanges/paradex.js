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
// every 5 seconds. created_at is a unix-ms integer, NOT an ISO string (Date.parse()
// on it silently returns NaN, which is why history used to render as empty).
//
// start_at/end_at are honored as a time-range filter (confirmed against live
// responses), so we page backwards in time to pull more than a single page's worth
// of ticks. Full 30-day coverage at ~5s resolution would mean ~500k ticks — far too
// many requests to make per symbol, especially since cache.js calls this for every
// currently-positive-funding candidate on every 5-minute background refresh — so
// MAX_PAGES bounds it to a realistic recent window (roughly a day or two) rather
// than pretending to match the other five exchanges' full 30-day depth.
const PAGE_SIZE = 5000;
const MAX_PAGES = 6;

async function fetchHistory(symbol, limit = 200, intervalHours = DEFAULT_INTERVAL_HOURS) {
  const windowStart = Date.now() - limit * intervalHours * 60 * 60 * 1000;
  const raw = [];
  let endAt = Date.now();

  for (let page = 0; page < MAX_PAGES; page++) {
    const qs = new URLSearchParams({
      market: symbol,
      page_size: String(PAGE_SIZE),
      start_at: String(windowStart),
      end_at: String(endAt),
    });
    const data = await getJson(`/funding/data?${qs.toString()}`);
    const rows = data.results || [];
    if (rows.length === 0) break;

    for (const r of rows) {
      const time = Number(r.created_at);
      const rate = Number(r.funding_rate);
      if (Number.isFinite(time) && Number.isFinite(rate)) raw.push({ rate, time });
    }

    const oldest = Number(rows[rows.length - 1].created_at);
    if (!Number.isFinite(oldest) || oldest <= windowStart || rows.length < PAGE_SIZE) break;
    endAt = oldest - 1; // page backwards in time
  }

  // Downsample to ~1 point per funding period so the chart shows sensible bars
  // instead of a wall of near-identical sub-period ticks.
  const bucketMs = intervalHours * 60 * 60 * 1000;
  const byBucket = new Map();
  for (const point of raw.sort((a, b) => a.time - b.time)) {
    byBucket.set(Math.floor(point.time / bucketMs), point); // keep the latest sample per bucket
  }

  return Array.from(byBucket.values())
    .sort((a, b) => a.time - b.time)
    .slice(-limit);
}

module.exports = { id: 'paradex', label: 'Paradex', fetchCurrent, fetchHistory };

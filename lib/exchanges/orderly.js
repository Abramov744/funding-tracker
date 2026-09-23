// Orderly Network — omnichain perpetual DEX. Public REST API, no key needed.
// Docs: https://orderly.network/docs/
const { filterToCrypto } = require('../cryptoassets');

const BASE = 'https://api.orderly.org';
// No per-market interval field anywhere in the API; Orderly's own connector
// docs describe funding as computed on a fixed 8h cycle, confirmed on a real
// BTC funding-history sample (settlements land exactly 28,800,000ms apart).
const FUNDING_INTERVAL_HOURS = 8;
const HISTORY_PAGE_SIZE = 100;

async function getJson(path) {
  const res = await fetch(BASE + path, { headers: { 'User-Agent': 'funding-tracker/1.0' } });
  if (!res.ok) throw new Error(`Orderly ${path} -> HTTP ${res.status}`);
  const body = await res.json();
  if (!body.success) throw new Error(`Orderly ${path} -> success=false`);
  return body.data;
}

// Orderly symbols look like "PERP_BTC_USDC" or, for a handful of assets
// listed through more than one broker partition, "PERP_CAP_USDC_mythos" — the
// base ticker is always the second underscore-separated segment. Left as-is
// (multiplier prefixes like "1000BONK" included) since isCrypto()/splitSymbol
// downstream expects the raw ticker to size the price-band check correctly.
function rawBase(symbol) {
  const parts = symbol.split('_');
  return parts[1] || symbol;
}

// base ticker -> full Orderly symbol, filled by fetchCurrent and read by
// fetchHistory, which needs the exchange's own symbol string.
let symbolByBase = new Map();

// Returns current funding for every active crypto perpetual.
//
// Orderly lists tokenized stocks, indices, forex and commodities (AAPL,
// SPX500, EURUSD, XAU, crude oil, ...) as ordinary perpetuals. Unlike when
// this scanner first looked at Orderly, it now publishes an explicit list of
// them at /v1/public/rwa/info (71 symbols on a real dump — SPX500, TSLA,
// NVDA, CL, XAU, EURUSD, HKDUSD, ...), so most are filtered for free. A
// handful of remaining tickers (e.g. broker-partitioned variants like
// CAP_mythos, ALLO_mythos) aren't obviously crypto or RWA from the ticker
// alone, so isCrypto()'s CoinGecko cross-check still runs as a second layer
// — cheap, since the price needed for it is already in this same bulk call.
async function fetchCurrent() {
  const [futures, rwa] = await Promise.all([getJson('/v1/public/futures'), getJson('/v1/public/rwa/info')]);

  const rwaSymbols = new Set((rwa.rows || []).map((r) => r.symbol));
  const active = (futures.rows || []).filter((m) => m.status === 'ACTIVE' && !rwaSymbols.has(m.symbol));

  const crypto = filterToCrypto(active, {
    exchange: 'orderly',
    symbolOf: (m) => rawBase(m.symbol),
    priceOf: (m) => Number(m.mark_price),
  });

  return crypto
    .map((m) => {
      const base = rawBase(m.symbol);
      symbolByBase.set(base, m.symbol);
      const price = Number(m.mark_price);
      // open_interest is in base-asset units, not USD — confirmed on a real
      // BTC sample: 31.46213 * $84,242 ~= $2.65M, a plausible order of
      // magnitude for Orderly's scale (smaller than the majors here).
      const oi = Number(m.open_interest);
      return {
        exchange: 'orderly',
        symbol: base,
        fundingRate: Number(m.last_funding_rate),
        intervalHours: FUNDING_INTERVAL_HOURS,
        nextFundingTime: m.next_funding_time || null,
        price: Number.isFinite(price) ? price : null,
        openInterestUsd: Number.isFinite(oi) && Number.isFinite(price) ? oi * price : null,
      };
    })
    .filter((r) => Number.isFinite(r.fundingRate));
}

// Returns the last `limit` funding-rate settlements for one symbol, oldest
// first. /funding_rate_history paginates at 60 rows/page by default; a
// `size` param is accepted too, but rather than trust an unverified upper
// bound on it, this pages through with `page` until enough rows are
// collected or a short page signals there's no more history — works the
// same regardless of what size the API actually honors per request.
async function fetchHistory(symbol, limit = 200) {
  const rawSymbol = symbolByBase.get(symbol) || symbol;
  const maxPages = Math.ceil(limit / HISTORY_PAGE_SIZE) + 1;
  let rows = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await getJson(
      `/v1/public/funding_rate_history?symbol=${encodeURIComponent(rawSymbol)}&page=${page}&size=${HISTORY_PAGE_SIZE}`
    );
    const pageRows = (res && res.rows) || [];
    if (!pageRows.length) break;
    rows = rows.concat(pageRows);
    if (rows.length >= limit || pageRows.length < HISTORY_PAGE_SIZE) break;
  }

  return rows
    .map((r) => ({ rate: Number(r.funding_rate), time: Number(r.funding_rate_timestamp) }))
    .filter((r) => Number.isFinite(r.rate) && Number.isFinite(r.time))
    .sort((a, b) => a.time - b.time)
    .slice(-limit);
}

module.exports = { id: 'orderly', label: 'Orderly', fetchCurrent, fetchHistory };

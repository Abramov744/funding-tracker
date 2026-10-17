// RISEx — perpetual DEX on the RISE chain (Ethereum L2). Public REST API, no
// key needed. Docs: https://developer.rise.trade (marked "work in progress" —
// the exchange and its API are both young; confirmed live that BTC/USDC
// already has 40+ days of hourly settlement history, so it's past the
// bootstrap phase for at least the major markets).
//
// Listed markets mix real crypto with tokenized stocks/commodities/index
// ETFs (TSLA, NVDA, XAU, SPY, ...) under the same /v1/markets response, but
// unlike several other exchanges here, RISEx tags every market with an
// explicit `category` field ("crypto"/"stocks"/"commodity"/"index_etf") —
// confirmed live across all 44 listed markets — so no CoinGecko cross-check
// or hand-maintained ticker list is needed, just filter on it.
//
// Funding settles hourly for every market (funding_interval is in
// nanoseconds; 3600000000000 = 3600s = 1h, confirmed on every sampled
// market) — computed per-market rather than hardcoded, in case that ever
// differs. current_funding_rate/funding_rate_8h/history's funding_rate are
// all the same per-hour raw fraction (not pre-annualized, unlike GMX) —
// confirmed by cross-checking current_funding_rate × 8 against the
// separately-reported funding_rate_8h field on the same response.
const BASE = 'https://api.rise.trade';
const NS_PER_HOUR = 3600 * 1e9;

async function getJson(path) {
  const res = await fetch(BASE + path, { headers: { 'User-Agent': 'funding-tracker/1.0' } });
  if (!res.ok) throw new Error(`RISEx ${path} -> HTTP ${res.status}`);
  const body = await res.json();
  return body.data;
}

// baseAsset -> numeric market_id, needed by fetchHistory's per-market
// endpoint — populated by fetchCurrent, same pattern as GMX's marketAddressByAsset.
let marketIdBySymbol = new Map();

async function fetchCurrent() {
  const data = await getJson('/v1/markets');
  const markets = (data && data.markets) || [];

  const crypto = markets.filter((m) => m.category === 'crypto' && m.active !== false && m.market_id);

  marketIdBySymbol = new Map(crypto.map((m) => [symbolOf(m), m.market_id]));

  return crypto
    .map((m) => {
      const rate = Number(m.current_funding_rate);
      const price = Number(m.mark_price) || null;
      if (!Number.isFinite(rate)) return null;

      const intervalNs = Number(m.funding_interval);
      const intervalHours = Number.isFinite(intervalNs) && intervalNs > 0 ? intervalNs / NS_PER_HOUR : 1;

      const oi = Number(m.open_interest);
      const openInterestUsd = price && Number.isFinite(oi) ? oi * price : null;

      const nextFundingTime = Number(m.next_funding_time);

      return {
        exchange: 'rise',
        symbol: symbolOf(m),
        fundingRate: rate,
        intervalHours,
        nextFundingTime: Number.isFinite(nextFundingTime) ? Math.round(nextFundingTime / 1e6) : null,
        price,
        openInterestUsd,
        // quote_volume_24h is already USD-denominated 24h volume — confirmed
        // on a real BTC/USDC sample: "48226079.3241194".
        volume24hUsd: Number(m.quote_volume_24h) || null,
      };
    })
    .filter((r) => r);
}

// "BTC/USDC" -> "BTCUSDC" — strips the slash so lib/metrics.js's baseAsset()
// can split off the trailing USDC the same way it already does for every
// other exchange's bare-USDC symbols.
function symbolOf(m) {
  return String(m.base_asset_symbol || '').replace('/', '');
}

// Returns the last `limit` hourly settlements for one symbol, oldest first.
// start_time=1 (rather than omitting it) sidesteps the endpoint's own
// default of "last 7 days" — confirmed live that a small positive
// start_time plus a high limit returns the full available history instead,
// most-recent-first, which is then trimmed to `limit` and reversed below.
async function fetchHistory(symbol, limit = 200) {
  const marketId = marketIdBySymbol.get(symbol);
  if (!marketId) throw new Error(`RISEx: unknown market for ${symbol}`);

  const data = await getJson(
    `/v1/markets/id/${marketId}/funding-rate-history?start_time=1&limit=${Math.min(limit, 1000)}`
  );
  const records = (data && data.records) || [];

  return records
    .map((r) => ({ rate: Number(r.funding_rate), time: Math.round(Number(r.start_time) / 1e6) }))
    .filter((r) => Number.isFinite(r.rate) && Number.isFinite(r.time))
    .sort((a, b) => a.time - b.time)
    .slice(-limit);
}

module.exports = { id: 'rise', label: 'RISEx', fetchCurrent, fetchHistory };

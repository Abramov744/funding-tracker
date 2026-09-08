// GRVT — perpetual DEX on ZKsync. Public REST API, no key needed, but market
// data is POST + JSON body rather than GET + query params, confirmed against
// the official Python SDK and real API responses (api-docs.grvt.io isn't
// reachable from this environment): https://github.com/gravity-technologies/grvt-pysdk
const { mapWithConcurrency } = require('../pool');
const { isCrypto, isMapUsable } = require('../cryptoassets');

const BASE = 'https://market-data.grvt.io';
const CONCURRENCY = 8;
// Sized for the worst case (a 1h-interval instrument covering cache.js's 30-day
// avg-APR window, 720 periods) + buffer; GRVT's default page is 500, max 1000.
const HISTORY_LIMIT = 722;

async function postJson(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'funding-tracker/1.0' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GRVT ${path} -> HTTP ${res.status}`);
  const json = await res.json();
  return json.result;
}

// base ticker (our row.symbol, e.g. "BTC") -> [{ rate, time }], oldest first.
// Filled by fetchCurrent (which already has to pull each instrument's funding
// history — see below) and read by fetchHistory at no extra request cost.
let historyBySymbol = new Map();

// GRVT reports funding_rate as a percentage-point string ("0.01" means
// 0.01%), not a decimal fraction — confirmed against their own funding-
// mechanism docs, which describe the baseline rate as "+1 bp (0.01%)", and a
// real API response that returned exactly "0.01" for that baseline case.
// funding_time is unix *nanoseconds*.
function parseFundingRows(rows) {
  return (rows || [])
    .map((r) => ({ rate: Number(r.funding_rate) / 100, time: Math.round(Number(r.funding_time) / 1e6) }))
    .filter((r) => Number.isFinite(r.rate) && Number.isFinite(r.time))
    .sort((a, b) => a.time - b.time);
}

// Returns current funding for every active crypto perpetual.
//
// GRVT lists ~110 tokenized stocks, ETFs, forex pairs and commodities
// (AAPL, TSLA, EURUSD, XAU, ...) as ordinary "PERPETUAL" instruments — and
// unlike edgeX/Pacifica, literally nothing distinguishes them from real
// coins: kind, asset_class, settlement_period and venues read identically for
// AAPL_USDT_Perp and BTC_USDT_Perp in the real API response. lib/cryptoassets.js
// is what tells them apart.
//
// GRVT's market-data API has no bulk "current funding for every instrument"
// call, and it isn't GET/query-string like every other exchange here — each
// call is a POST with a JSON body. fetchCurrent fans out one funding-history
// request per instrument (bounded concurrency, as with OKX/ApeX), which also
// carries the mark price and funding_interval_hours, and caches the full
// history so fetchHistory costs nothing further.
async function fetchCurrent() {
  if (!isMapUsable()) {
    throw new Error('GRVT: CoinGecko map unavailable — cannot separate crypto from tokenized stocks');
  }

  const instruments = await postJson('/full/v1/all_instruments', { is_active: true });
  const perps = (instruments || []).filter((i) => i.kind === 'PERPETUAL' && i.quote === 'USDT');

  // Cheap pre-filter on the ticker alone (no price yet) — drops the bulk of
  // GRVT's stock/forex/commodity listings before spending a request on them.
  // A handful of real coins share a ticker with a stock (MET/Meteora vs.
  // MetLife, ADI, ROBO) and pass this stage; the price check below resolves them.
  const candidates = perps.filter((i) => isCrypto(i.base));

  const results = await mapWithConcurrency(candidates, CONCURRENCY, async (inst) => {
    const rows = await postJson('/full/v1/funding', { instrument: inst.instrument, limit: HISTORY_LIMIT });
    if (!rows || !rows.length) return null;

    const history = parseFundingRows(rows);
    if (!history.length) return null;

    const latest = rows[0]; // reverse-chronological with no end_time set -> newest first
    const price = Number(latest.mark_price);
    if (!isCrypto(inst.base, price)) return null; // resolves ticker collisions now that a real price exists

    historyBySymbol.set(inst.base, history);

    return {
      exchange: 'grvt',
      symbol: inst.base,
      fundingRate: history[history.length - 1].rate,
      intervalHours: Number(latest.funding_interval_hours) || Number(inst.funding_interval_hours) || null,
      // Settles on a schedule GRVT doesn't publish a per-instrument timestamp
      // for — left null rather than guessed at, same as Hyperliquid/Lighter.
      nextFundingTime: null,
      price: Number.isFinite(price) && price > 0 ? price : null,
    };
  });

  return results.filter((r) => r && !r.error && Number.isFinite(r.fundingRate));
}

// Served from the cache fetchCurrent fills in the same refresh cycle, so this
// makes no request of its own.
async function fetchHistory(symbol, limit = 200) {
  const history = historyBySymbol.get(symbol);
  if (!history) throw new Error(`GRVT: no cached funding history for ${symbol}`);
  return history.slice(-limit);
}

module.exports = { id: 'grvt', label: 'GRVT', fetchCurrent, fetchHistory };

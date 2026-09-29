// Phemex USDⓈ-M linear perpetual contracts (USDT/USDC-margined) — public
// REST API, no key needed. Docs: https://phemex-docs.github.io/
//
// Two response envelope styles are mixed across Phemex's own endpoints: most
// REST endpoints use {code, msg, data}, but the /md/v2 market-data endpoints
// use a JSON-RPC-ish {error, id, result} shape instead — getJson() below
// handles both.
const BASE = 'https://api.phemex.com';

async function getJson(path) {
  const res = await fetch(BASE + path, { headers: { 'User-Agent': 'funding-tracker/1.0' } });
  if (!res.ok) throw new Error(`Phemex ${path} -> HTTP ${res.status}`);
  const body = await res.json();
  if ('result' in body) {
    if (body.error) throw new Error(`Phemex ${path} -> ${JSON.stringify(body.error)}`);
    return body.result;
  }
  if (body.code !== 0) throw new Error(`Phemex ${path} -> ${body.code} ${body.msg || ''}`);
  return body.data;
}

// symbol -> { intervalHours, fundingHistorySymbol } — populated by
// fetchCurrent(), reused by fetchHistory() (the history endpoint takes a
// dotted "funding rate" symbol like ".BTCUSDTFR8H", not the trading symbol).
let contractBySymbol = new Map();

// Returns current funding for every active, non-TradFi USDⓈ-M perpetual.
//
// Three bulk calls, merged by symbol:
// - /public/products' perpProductsV2 node is already scoped to USDT/USDC
//   linear contracts only (confirmed live: no inverse BTCUSD-style symbols
//   leak in here) — filtered to status:"Listed". perpProductSubType also
//   distinguishes real crypto ("Normal") from Phemex's synthetic
//   tokenized-stock/forex/commodity products ("TradFi": AAPL, XAU, NOK, ...)
//   and pre-market speculation contracts ("PreMarket": ANTHROPICUSDT,
//   OPENAIUSDT) — confirmed live over 130+ instruments, more than half of
//   which are actually TradFi, not crypto — so only "Normal" is kept, same
//   idea as Bitget's isRwa/Extended's category flags.
// - /md/v2/ticker/24hr/all carries markPriceRp (price) and openInterestRv,
//   already unscaled decimal strings, and OI is in base-asset units (each
//   contract = 1 unit) — confirmed on BTCUSDT: 2139.86 * $84,303 ≈ $180M, a
//   sane figure, so no contract-size multiplier needed here.
// - /contract-biz/public/real-funding-rates carries fundingRate and (note
//   the odd lowercase-f casing) nextfundingTime. Its symbol=ALL response
//   leaks in ~8 inverse/quanto contracts (bare "BTCUSD", lowercase-c
//   "cETHUSD" etc.) not present in perpProductsV2 — dropped naturally by
//   only looking up symbols already known from step 1.
async function fetchCurrent() {
  const [products, tickers, fundingRates] = await Promise.all([
    getJson('/public/products'),
    getJson('/md/v2/ticker/24hr/all'),
    getJson('/contract-biz/public/real-funding-rates?symbol=ALL&pageSize=500'),
  ]);

  contractBySymbol = new Map(
    ((products && products.perpProductsV2) || [])
      .filter((p) => p.status === 'Listed' && p.perpProductSubType === 'Normal')
      .map((p) => [
        p.symbol,
        { intervalHours: Number(p.fundingInterval) / 3600 || null, fundingHistorySymbol: p.fundingRate8hSymbol },
      ])
  );

  const tickerBySymbol = new Map((Array.isArray(tickers) ? tickers : []).map((t) => [t.symbol, t]));
  const fundingRows = (fundingRates && fundingRates.rows) || (Array.isArray(fundingRates) ? fundingRates : []);

  return fundingRows
    .map((r) => {
      const c = contractBySymbol.get(r.symbol);
      const rate = Number(r.fundingRate);
      if (!c || !Number.isFinite(rate)) return null;

      const t = tickerBySymbol.get(r.symbol);
      const price = t ? Number(t.markPriceRp) : null;
      const oi = t ? Number(t.openInterestRv) : NaN;

      return {
        exchange: 'phemex',
        symbol: r.symbol,
        fundingRate: rate,
        intervalHours: c.intervalHours,
        nextFundingTime: Number(r.nextfundingTime) || null,
        price,
        openInterestUsd: price && Number.isFinite(oi) ? oi * price : null,
      };
    })
    .filter((r) => r);
}

const HISTORY_PAGE_SIZE = 100; // API max

// Returns the last `limit` settled funding-rate events for one symbol,
// oldest first. A single call with no start/end already returns the most
// recent `limit` records oldest-first (confirmed live) — for limit>100,
// pages backwards in time using `end` (the oldest fundingTime seen so far
// minus 1ms), prepending each older batch.
async function fetchHistory(symbol, limit = 200) {
  const c = contractBySymbol.get(symbol);
  if (!c || !c.fundingHistorySymbol) throw new Error(`Phemex: unknown funding-history symbol for ${symbol}`);

  let rows = [];
  let end;
  while (rows.length < limit) {
    const qs = new URLSearchParams({ symbol: c.fundingHistorySymbol, limit: String(HISTORY_PAGE_SIZE) });
    if (end) qs.set('end', String(end));

    const page = await getJson(`/api-data/public/data/funding-rate-history?${qs.toString()}`);
    const pageRows = (page && page.rows) || (Array.isArray(page) ? page : []);
    if (!pageRows.length) break;

    rows = pageRows.concat(rows);
    end = Number(pageRows[0].fundingTime) - 1;
    if (pageRows.length < HISTORY_PAGE_SIZE) break;
  }

  return rows
    .map((r) => ({ rate: Number(r.fundingRate), time: Number(r.fundingTime) }))
    .filter((r) => Number.isFinite(r.rate) && Number.isFinite(r.time))
    .sort((a, b) => a.time - b.time)
    .slice(-limit);
}

module.exports = { id: 'phemex', label: 'Phemex', fetchCurrent, fetchHistory };

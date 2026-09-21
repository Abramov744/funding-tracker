// BingX USDT-margined perpetual swaps — public market data, no API key needed.
// Docs: https://bingx-api.github.io/docs/#/en-us/swapV2/market-api.html
// BingX's swap v2 API closely mirrors Binance Futures' endpoint/field conventions
// (same family as Aster) — premiumIndex and fundingRate shapes below follow that.
const BASE = 'https://open-api.bingx.com';
const DEFAULT_INTERVAL_HOURS = 8;

async function getJson(path) {
  const res = await fetch(BASE + path, { headers: { 'User-Agent': 'funding-tracker/1.0' } });
  if (!res.ok) throw new Error(`BingX ${path} -> HTTP ${res.status}`);
  const body = await res.json();
  if (body.code !== 0) throw new Error(`BingX ${path} -> ${body.code} ${body.msg}`);
  return body.data;
}

// Returns current funding snapshot for every active USDT-margined perpetual on BingX.
async function fetchCurrent() {
  const [contracts, premiumIndex] = await Promise.all([
    getJson('/openApi/swap/v2/quote/contracts'),
    getJson('/openApi/swap/v2/quote/premiumIndex'),
  ]);

  const tradingSymbols = new Set(
    (contracts || []).filter((c) => c.status === 1 && c.currency === 'USDT').map((c) => c.symbol)
  );

  const list = Array.isArray(premiumIndex) ? premiumIndex : [premiumIndex];

  return list
    .filter((p) => tradingSymbols.has(p.symbol) && p.lastFundingRate !== undefined && p.lastFundingRate !== null)
    .map((p) => ({
      exchange: 'bingx',
      symbol: p.symbol,
      fundingRate: Number(p.lastFundingRate),
      intervalHours: DEFAULT_INTERVAL_HOURS,
      nextFundingTime: p.nextFundingTime || null,
      price: Number(p.markPrice) || null,
    }));
}

// Returns the last `limit` funding-rate settlements for one symbol, oldest first.
async function fetchHistory(symbol, limit = 200) {
  const rows = await getJson(
    `/openApi/swap/v2/quote/fundingRate?symbol=${encodeURIComponent(symbol)}&limit=${limit}`
  );
  // Sort explicitly rather than trusting the API's own order — it turned out to be
  // newest-first here (unlike Aster's history endpoint), which was flipping the
  // 30-day chart's time axis backwards.
  return (rows || [])
    .map((r) => ({ rate: Number(r.fundingRate), time: Number(r.fundingTime) }))
    .sort((a, b) => a.time - b.time);
}

// Like Aster, BingX's open-interest endpoint has no bulk form — it's called
// once per history candidate via cache.js's fetchOpenInterest hook, same cost
// model already paid for fetchHistory. Unlike Aster (base-asset units),
// BingX's openInterest is already in USD — confirmed on a real BTC-USDT
// sample: openInterest="1197507520.0" would be an absurd ~1.2 billion BTC if
// taken as base-asset units, but is a plausible ~$1.2B notional figure,
// in the same range as OKX ($2.48B) and Bybit ($2.44B).
async function fetchOpenInterest(symbol) {
  const data = await getJson(`/openApi/swap/v2/quote/openInterest?symbol=${encodeURIComponent(symbol)}`);
  const oi = Number(data.openInterest);
  return Number.isFinite(oi) ? oi : null;
}

module.exports = { id: 'bingx', label: 'BingX', fetchCurrent, fetchHistory, fetchOpenInterest };

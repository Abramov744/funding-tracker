// Aster (asterdex.com) perpetual futures — public market data, no API key needed.
// Docs: https://github.com/asterdex/api-docs (V3 Futures API)
const BASE = 'https://fapi.asterdex.com';
const DEFAULT_INTERVAL_HOURS = 8; // Aster's common default when fundingInfo has no override

async function getJson(path) {
  const res = await fetch(BASE + path, { headers: { 'User-Agent': 'funding-tracker/1.0' } });
  if (!res.ok) throw new Error(`Aster ${path} -> HTTP ${res.status}`);
  return res.json();
}

// Returns current funding snapshot for every USDT-margined perpetual on Aster.
async function fetchCurrent() {
  const [exchangeInfo, premiumIndex, fundingInfo] = await Promise.all([
    getJson('/fapi/v3/exchangeInfo'),
    getJson('/fapi/v3/premiumIndex'),
    getJson('/fapi/v3/fundingInfo').catch(() => []), // best-effort; not fatal if it fails
  ]);

  const tradingSymbols = new Set(
    (exchangeInfo.symbols || [])
      .filter((s) => s.contractType === 'PERPETUAL' && s.status === 'TRADING' && s.quoteAsset === 'USDT')
      .map((s) => s.symbol)
  );

  const intervalBySymbol = new Map(
    (Array.isArray(fundingInfo) ? fundingInfo : []).map((f) => [f.symbol, f.fundingIntervalHours])
  );

  const list = Array.isArray(premiumIndex) ? premiumIndex : [premiumIndex];

  return list
    .filter((p) => tradingSymbols.has(p.symbol))
    .map((p) => ({
      exchange: 'aster',
      symbol: p.symbol,
      fundingRate: Number(p.lastFundingRate),
      intervalHours: intervalBySymbol.get(p.symbol) || DEFAULT_INTERVAL_HOURS,
      nextFundingTime: p.nextFundingTime || null,
      price: Number(p.markPrice) || null,
    }));
}

// Returns the last `limit` funding-rate settlements for one symbol, oldest first.
async function fetchHistory(symbol, limit = 100) {
  const rows = await getJson(`/fapi/v3/fundingRate?symbol=${encodeURIComponent(symbol)}&limit=${limit}`);
  return rows.map((r) => ({ rate: Number(r.fundingRate), time: r.fundingTime }));
}

// Unlike every other exchange integrated so far, Aster's open-interest
// endpoint (Binance-API-family) has no bulk form — /fapi/v1/openInterest
// requires `symbol` and 400s without it (confirmed against a real response:
// "Mandatory parameter 'symbol' was not sent"). cache.js calls this once per
// history candidate rather than once per refresh, same cost model already
// paid for fetchHistory. openInterest is in base-asset units directly (no
// contract multiplier here, unlike KuCoin/MEXC) — confirmed on a real
// BTCUSDT sample: openInterest=5621.166 * markPrice ≈ several hundred
// million dollars, a plausible BTC OI figure for this exchange's scale.
async function fetchOpenInterest(symbol, price) {
  if (!price) return null;
  const data = await getJson(`/fapi/v1/openInterest?symbol=${encodeURIComponent(symbol)}`);
  const oi = Number(data.openInterest);
  return Number.isFinite(oi) ? oi * price : null;
}

module.exports = { id: 'aster', label: 'Aster', fetchCurrent, fetchHistory, fetchOpenInterest };

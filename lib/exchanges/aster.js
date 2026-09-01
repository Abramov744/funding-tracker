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
    }));
}

// Returns the last `limit` funding-rate settlements for one symbol, oldest first.
async function fetchHistory(symbol, limit = 100) {
  const rows = await getJson(`/fapi/v3/fundingRate?symbol=${encodeURIComponent(symbol)}&limit=${limit}`);
  return rows.map((r) => ({ rate: Number(r.fundingRate), time: r.fundingTime }));
}

module.exports = { id: 'aster', label: 'Aster', fetchCurrent, fetchHistory };

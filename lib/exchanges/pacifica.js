// Pacifica — perpetual DEX on Solana. Public REST API, no key needed.
// Endpoints/fields confirmed against real API responses (docs.pacifica.fi
// isn't reachable from this environment).
const BASE = 'https://api.pacifica.fi/api/v1';
const INTERVAL_HOURS = 1; // Pacifica settles funding hourly

async function getData(path) {
  const res = await fetch(BASE + path, { headers: { 'User-Agent': 'funding-tracker/1.0' } });
  if (!res.ok) throw new Error(`Pacifica ${path} -> HTTP ${res.status}`);
  const body = await res.json();
  if (!body.success) throw new Error(`Pacifica ${path} -> ${body.error || 'unknown error'}`);
  return body.data;
}

// Returns current funding snapshot for every crypto perpetual, in one bulk
// request. /info/prices also lists spot markets (e.g. "SOL-USDC"), and /info
// lists tokenized stocks/commodities/forex (TSLA, XAU, EURUSD, ...) under the
// same "perpetual" instrument_type as crypto — the field that reliably tells
// them apart is execution_modes: every RWA/TradFi instrument includes "rfq"
// (quoted via market makers, since they don't have continuous crypto-style
// order-book liquidity), while every real crypto perpetual is orderbook-only.
async function fetchCurrent() {
  const [prices, markets] = await Promise.all([getData('/info/prices'), getData('/info')]);

  const cryptoSymbols = new Set(
    (markets || [])
      .filter((m) => m.instrument_type === 'perpetual' && !(m.execution_modes || []).includes('rfq'))
      .map((m) => m.symbol)
  );

  return (prices || [])
    .filter((p) => cryptoSymbols.has(p.symbol))
    .map((p) => ({
      exchange: 'pacifica',
      symbol: p.symbol, // bare base ticker, e.g. "BTC" — no quote suffix to strip
      fundingRate: Number(p.funding),
      intervalHours: INTERVAL_HOURS,
      // Pacifica exposes a *predicted next rate* here, not a settlement
      // timestamp — same situation as Hyperliquid, which settles on a fixed
      // schedule too, so this is left null rather than guessed at.
      nextFundingTime: null,
      price: Number(p.mark) || Number(p.oracle) || null,
    }))
    .filter((r) => Number.isFinite(r.fundingRate));
}

// Returns the last `limit` funding settlements for one symbol, oldest first.
// The endpoint's default page (no `limit`/`cursor` passed) already returns
// 200 real hourly settlements — exactly cache.js's own HISTORY_LIMIT — so a
// single request covers the normal case without needing to guess at this
// API's pagination parameter names.
async function fetchHistory(symbol, limit = 200) {
  const rows = await getData(`/funding_rate/history?symbol=${encodeURIComponent(symbol)}`);

  return (rows || [])
    .map((r) => ({ rate: Number(r.funding_rate), time: Number(r.created_at) }))
    .filter((r) => Number.isFinite(r.rate) && Number.isFinite(r.time))
    .sort((a, b) => a.time - b.time)
    .slice(-limit);
}

module.exports = { id: 'pacifica', label: 'Pacifica', fetchCurrent, fetchHistory };

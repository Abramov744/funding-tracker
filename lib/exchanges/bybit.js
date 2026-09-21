// Bybit USDT-margined linear perpetual futures — public market data, no API key needed.
// Docs: https://bybit-exchange.github.io/docs/v5/market/tickers
const BASE = 'https://api.bybit.com';

async function getJson(path) {
  const res = await fetch(BASE + path, { headers: { 'User-Agent': 'funding-tracker/1.0' } });
  if (!res.ok) throw new Error(`Bybit ${path} -> HTTP ${res.status}`);
  const body = await res.json();
  if (body.retCode !== 0) throw new Error(`Bybit ${path} -> ${body.retCode} ${body.retMsg}`);
  return body.result;
}

// Returns current funding snapshot for every active USDT-margined perpetual on Bybit.
// instruments-info carries the funding interval (tickers doesn't), tickers carries the
// live rate/price/next-funding-time (instruments-info doesn't) — one call each, merged.
async function fetchCurrent() {
  const [instruments, tickers] = await Promise.all([
    getJson('/v5/market/instruments-info?category=linear'),
    getJson('/v5/market/tickers?category=linear'),
  ]);

  const intervalBySymbol = new Map(
    (instruments.list || [])
      .filter((i) => i.status === 'Trading' && i.quoteCoin === 'USDT' && i.contractType === 'LinearPerpetual')
      .map((i) => [i.symbol, Number(i.fundingInterval) / 60]) // fundingInterval is in minutes
  );

  return (tickers.list || [])
    .filter((t) => intervalBySymbol.has(t.symbol) && t.fundingRate !== undefined && t.fundingRate !== '')
    .map((t) => ({
      exchange: 'bybit',
      symbol: t.symbol,
      fundingRate: Number(t.fundingRate),
      intervalHours: intervalBySymbol.get(t.symbol),
      nextFundingTime: t.nextFundingTime ? Number(t.nextFundingTime) : null,
      price: Number(t.markPrice) || null,
      // openInterestValue is already USD, but it's the sum of both the long and
      // short side — confirmed on a real BTCUSDT sample where it's exactly 2x
      // singleOpenInterestValue (4,880,913,901.90 vs 2,440,456,993.40).
      // singleOpenInterestValue matches the conventional one-sided OI figure
      // (what exchanges' own UIs and aggregators display), so that's the one
      // used here, same quantity Paradex's openInterestUsd represents.
      openInterestUsd: Number(t.singleOpenInterestValue) || null,
    }));
}

// Returns the last `limit` funding-rate settlements for one symbol, oldest first.
// Bybit's history endpoint caps out at 200 per page, which happens to match our default.
async function fetchHistory(symbol, limit = 200) {
  const result = await getJson(
    `/v5/market/funding/history?category=linear&symbol=${encodeURIComponent(symbol)}&limit=${Math.min(limit, 200)}`
  );
  return (result.list || [])
    .map((r) => ({ rate: Number(r.fundingRate), time: Number(r.fundingRateTimestamp) }))
    .reverse(); // API returns newest-first
}

module.exports = { id: 'bybit', label: 'Bybit', fetchCurrent, fetchHistory };

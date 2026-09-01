// KuCoin Futures — public market data, no API key needed.
// Docs: https://www.kucoin.com/docs/rest/futures-trading/market-data/get-symbol
const BASE = 'https://api-futures.kucoin.com';

async function getJson(path) {
  const res = await fetch(BASE + path, { headers: { 'User-Agent': 'funding-tracker/1.0' } });
  if (!res.ok) throw new Error(`KuCoin ${path} -> HTTP ${res.status}`);
  const body = await res.json();
  if (body.code !== '200000') throw new Error(`KuCoin ${path} -> ${body.code}`);
  return body.data;
}

// Returns current funding snapshot for every open USDT-settled perpetual on KuCoin.
// A single bulk call carries current rate, interval and next-funding time.
async function fetchCurrent() {
  const contracts = await getJson('/api/v1/contracts/active');
  return (contracts || [])
    .filter((c) => c.quoteCurrency === 'USDT' && c.status === 'Open' && c.fundingFeeRate !== null)
    .map((c) => ({
      exchange: 'kucoin',
      symbol: c.symbol,
      fundingRate: Number(c.fundingFeeRate),
      intervalHours: c.fundingRateGranularity ? c.fundingRateGranularity / 3600000 : 8,
      nextFundingTime: c.nextFundingRateDateTime || null,
    }));
}

// Returns the last `limit` funding-rate settlements for one symbol, oldest first.
// KuCoin's history endpoint takes an explicit time window instead of a count,
// so we size the window from the symbol's own funding interval.
async function fetchHistory(symbol, limit = 100, intervalHours = 8) {
  const to = Date.now();
  const from = to - limit * intervalHours * 60 * 60 * 1000;
  const rows = await getJson(
    `/api/v1/contract/funding-rates?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}`
  );
  return (rows || [])
    .map((r) => ({ rate: Number(r.fundingRate), time: r.timepoint }))
    .reverse() // API returns newest-first
    .slice(-limit);
}

module.exports = { id: 'kucoin', label: 'KuCoin', fetchCurrent, fetchHistory };

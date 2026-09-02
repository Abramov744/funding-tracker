// Crypto.com Exchange — USD-margined perpetual swaps, public market-data API,
// no key needed. Docs: https://exchange-docs.crypto.com/exchange/v1/rest-ws/index.html
//
// Unlike the other exchanges here, Crypto.com has no single bulk "current funding
// rate for every symbol" call — funding comes from a per-symbol "valuations"
// lookup (the same generic endpoint also serves mark price, index price and
// funding history, switched via valuation_type). So fetchCurrent() fans that out
// across every tradable perpetual with bounded concurrency, rather than the one
// bulk request the other adapters make.
const { mapWithConcurrency } = require('../pool');

const BASE = 'https://api.crypto.com/exchange/v1';
const DEFAULT_INTERVAL_HOURS = 8;
const CONCURRENCY = 8;

async function getJson(path) {
  const res = await fetch(BASE + path, { headers: { 'User-Agent': 'funding-tracker/1.0' } });
  if (!res.ok) throw new Error(`Crypto.com ${path} -> HTTP ${res.status}`);
  const body = await res.json();
  if (body.code !== 0) throw new Error(`Crypto.com ${path} -> ${body.code} ${body.message || ''}`);
  return body.result || {};
}

// Returns current funding snapshot for every tradable USD-margined perpetual.
async function fetchCurrent() {
  const [instrumentsResult, tickersResult] = await Promise.all([
    getJson('/public/get-instruments'),
    getJson('/public/get-tickers'),
  ]);

  const instruments = instrumentsResult.data || instrumentsResult.instruments || [];
  const perps = instruments.filter((i) => i.inst_type === 'PERPETUAL_SWAP' && i.tradable !== false);

  const priceBySymbol = new Map((tickersResult.data || []).map((t) => [t.i, Number(t.a)]));

  const results = await mapWithConcurrency(perps, CONCURRENCY, async (inst) => {
    const funding = await getJson(
      `/public/get-valuations?instrument_name=${encodeURIComponent(inst.symbol)}&valuation_type=funding_rate&count=1`
    );
    const point = (funding.data || [])[0];
    if (!point) return null;
    return {
      exchange: 'cryptocom',
      symbol: inst.symbol,
      fundingRate: Number(point.v),
      intervalHours: DEFAULT_INTERVAL_HOURS,
      nextFundingTime: null,
      price: priceBySymbol.get(inst.symbol) || null,
    };
  });

  return results.filter((r) => r && !r.error && Number.isFinite(r.fundingRate));
}

// Returns the last `limit` funding-rate settlements for one symbol, oldest first.
async function fetchHistory(symbol, limit = 200) {
  const data = await getJson(
    `/public/get-valuations?instrument_name=${encodeURIComponent(symbol)}&valuation_type=funding_hist&count=${limit}`
  );
  return (data.data || [])
    .map((r) => ({ rate: Number(r.v), time: Number(r.t) }))
    .filter((r) => Number.isFinite(r.rate) && Number.isFinite(r.time))
    .sort((a, b) => a.time - b.time);
}

module.exports = { id: 'cryptocom', label: 'Crypto.com', fetchCurrent, fetchHistory };

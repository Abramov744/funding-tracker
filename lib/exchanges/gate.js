// Gate.io USDT-margined futures — public market data, no API key needed.
// Docs: https://www.gate.com/docs/developers/apiv4/en/
const BASE = 'https://api.gateio.ws';

async function getJson(path) {
  const res = await fetch(BASE + path, { headers: { 'User-Agent': 'funding-tracker/1.0' } });
  if (!res.ok) throw new Error(`Gate ${path} -> HTTP ${res.status}`);
  return res.json();
}

// Returns current funding snapshot for every USDT-settled perpetual on Gate.io.
// A single bulk call carries the current rate, funding interval and next-apply time,
// so no per-symbol follow-up is needed for the "current" pass.
async function fetchCurrent() {
  const contracts = await getJson('/api/v4/futures/usdt/contracts');
  return (contracts || [])
    .filter((c) => c.status === 'trading' && !c.in_delisting)
    .map((c) => {
      const price = Number(c.mark_price ?? c.last_price) || null;
      // position_size is a raw contract count for one side of the market
      // (long == short by construction), not the notional Gate itself
      // reports as "Open Interest" on its own UI — confirmed on a real
      // BTC_USDT sample: position_size=348,639,421 * quanto_multiplier
      // (contract -> base-asset size)=0.0001 -> 34,863.94 BTC, almost
      // exactly half of the 69.92K Gate's own BTC_USDT page showed at the
      // same time (the ~0.3% gap is just live-data timing drift). So the
      // long+short total needs an explicit *2 to match what the exchange
      // itself calls open interest.
      const openInterestUsd =
        price && c.position_size !== undefined && c.quanto_multiplier !== undefined
          ? Number(c.position_size) * Number(c.quanto_multiplier) * 2 * price
          : null;
      return {
        exchange: 'gate',
        symbol: c.name,
        fundingRate: Number(c.funding_rate),
        intervalHours: c.funding_interval ? c.funding_interval / 3600 : 8,
        nextFundingTime: c.funding_next_apply ? c.funding_next_apply * 1000 : null,
        price,
        openInterestUsd,
      };
    });
}

// Returns the last `limit` funding-rate settlements for one symbol, oldest first.
async function fetchHistory(symbol, limit = 100) {
  const rows = await getJson(`/api/v4/futures/usdt/funding_rate?contract=${encodeURIComponent(symbol)}&limit=${limit}`);
  return rows.map((r) => ({ rate: Number(r.r), time: r.t * 1000 })).reverse(); // API returns newest-first, t is unix seconds
}

module.exports = { id: 'gate', label: 'Gate.io', fetchCurrent, fetchHistory };

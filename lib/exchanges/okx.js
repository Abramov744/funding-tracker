// OKX USDT-margined perpetual swaps — public v5 market-data API, no key needed.
// Docs: https://www.okx.com/docs-v5/en/#public-data-rest-api
const { mapWithConcurrency } = require('../pool');

const BASE = 'https://www.okx.com';
const DEFAULT_INTERVAL_HOURS = 8;
const CONCURRENCY = 8;

async function getJson(path) {
  const res = await fetch(BASE + path, { headers: { 'User-Agent': 'funding-tracker/1.0' } });
  if (!res.ok) throw new Error(`OKX ${path} -> HTTP ${res.status}`);
  const body = await res.json();
  if (body.code !== '0') throw new Error(`OKX ${path} -> ${body.code} ${body.msg}`);
  return body.data || [];
}

// Returns current funding snapshot for every live USDT-margined perpetual swap.
// OKX has no bulk "current funding rate for every instrument" call, so this fans
// out one funding-rate lookup per instrument with bounded concurrency, rather
// than the single request most of the other exchanges make. The per-symbol call
// also carries fundingTime and nextFundingTime, which lets us derive the real
// funding interval per instrument instead of assuming a fixed 8h for all of them.
async function fetchCurrent() {
  const [instruments, marks] = await Promise.all([
    getJson('/api/v5/public/instruments?instType=SWAP'),
    getJson('/api/v5/public/mark-price?instType=SWAP'),
  ]);

  const swaps = instruments.filter((i) => i.state === 'live' && i.settleCcy === 'USDT' && i.ctType === 'linear');
  const priceByInst = new Map(marks.map((m) => [m.instId, Number(m.markPx)]));

  const results = await mapWithConcurrency(swaps, CONCURRENCY, async (inst) => {
    const [rate] = await getJson(`/api/v5/public/funding-rate?instId=${encodeURIComponent(inst.instId)}`);
    if (!rate || rate.fundingRate === undefined || rate.fundingRate === null) return null;

    const fundingTime = Number(rate.fundingTime);
    const nextFundingTime = Number(rate.nextFundingTime);
    const computedInterval = (nextFundingTime - fundingTime) / (60 * 60 * 1000);
    const intervalHours = Number.isFinite(computedInterval) && computedInterval > 0 ? computedInterval : DEFAULT_INTERVAL_HOURS;

    return {
      exchange: 'okx',
      symbol: inst.instId,
      fundingRate: Number(rate.fundingRate),
      intervalHours,
      nextFundingTime: Number.isFinite(nextFundingTime) ? nextFundingTime : null,
      price: priceByInst.get(inst.instId) || null,
    };
  });

  return results.filter((r) => r && !r.error && Number.isFinite(r.fundingRate));
}

const HISTORY_PAGE_SIZE = 100; // OKX's own cap per page
const HISTORY_MAX_PAGES = 10; // safety cap regardless of how large `limit` is

// Returns the last `limit` funding-rate settlements for one symbol, oldest first.
// OKX returns newest-first; `after` pages backwards using the oldest fundingTime
// seen so far.
async function fetchHistory(symbol, limit = 200) {
  const raw = [];
  let after;

  for (let page = 0; page < HISTORY_MAX_PAGES && raw.length < limit; page++) {
    const qs = new URLSearchParams({ instId: symbol, limit: String(HISTORY_PAGE_SIZE) });
    if (after) qs.set('after', after);
    const rows = await getJson(`/api/v5/public/funding-rate-history?${qs.toString()}`);
    if (!rows.length) break;

    for (const r of rows) raw.push({ rate: Number(r.fundingRate), time: Number(r.fundingTime) });

    if (rows.length < HISTORY_PAGE_SIZE) break;
    after = rows[rows.length - 1].fundingTime;
  }

  return raw
    .filter((r) => Number.isFinite(r.rate) && Number.isFinite(r.time))
    .sort((a, b) => a.time - b.time)
    .slice(-limit);
}

module.exports = { id: 'okx', label: 'OKX', fetchCurrent, fetchHistory };

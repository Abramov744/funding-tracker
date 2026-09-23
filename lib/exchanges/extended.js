// Extended (formerly X10) — perpetual DEX on Starknet (StarkEx). Public REST
// API, no key needed. Docs: https://api.docs.extended.exchange/
const BASE = 'https://api.starknet.extended.exchange/api/v1';
// Confirmed on real BTC-USD funding history (72h and 720h samples): settlements
// land almost exactly 3,600,000ms apart, so funding is hourly for every market
// — there's no per-market interval field on /info/markets to read instead.
const FUNDING_INTERVAL_HOURS = 1;

async function getJson(path) {
  const res = await fetch(BASE + path, { headers: { 'User-Agent': 'funding-tracker/1.0' } });
  if (!res.ok) throw new Error(`Extended ${path} -> HTTP ${res.status}`);
  const body = await res.json();
  if (body.status !== 'OK') throw new Error(`Extended ${path} -> ${body.status}`);
  return body.data;
}

// Returns current funding for every active crypto perpetual.
//
// Extended lists ~400 markets total: 397 PERPETUAL + 3 SPOT, and among the
// perpetuals, 177 of 326 active ones are tagged category "RWA" — tokenized
// stocks/commodities (SHOP, INTC, SAMSUNG, ...) alongside real crypto. That
// tag is explicit and exhaustive, like Paradex's tags/Bitget's isRwa, so no
// CoinGecko cross-check is needed. A handful of markets carry other stale
// category values ("L1"/"Infra"/"L2" instead of "Crypto") from a tagging
// inconsistency, but none of those were active in a real dump — filtering on
// category !== 'RWA' (rather than === 'Crypto') avoids relying on that.
async function fetchCurrent() {
  const markets = await getJson('/info/markets');

  return (markets || [])
    .filter((m) => m.type === 'PERPETUAL' && m.status === 'ACTIVE' && m.active && m.category !== 'RWA')
    .map((m) => {
      const stats = m.marketStats || {};
      const price = Number(stats.markPrice);
      return {
        exchange: 'extended',
        symbol: m.name,
        fundingRate: Number(stats.fundingRate),
        intervalHours: FUNDING_INTERVAL_HOURS,
        nextFundingTime: stats.nextFundingRate || null, // despite the name, this is a timestamp
        price: Number.isFinite(price) ? price : null,
        // Already in USD — confirmed on real samples: openInterest lines up
        // with openInterestBase * markPrice (e.g. ENA: 1,837,281 vs
        // 1,837,862 computed, well within normal price-staleness drift).
        openInterestUsd: Number.isFinite(Number(stats.openInterest)) ? Number(stats.openInterest) : null,
      };
    })
    .filter((r) => Number.isFinite(r.fundingRate));
}

// Returns the last `limit` funding-rate settlements for one symbol, oldest
// first. /info/{market}/funding takes a startTime/endTime range rather than a
// row-count limit, and isn't paginated/capped — confirmed on a real 720-hour
// (30-day) BTC-USD request, which returned exactly 720 rows, one per hour,
// with no truncation. intervalHours is always 1 here, so `limit` periods is
// simply `limit` hours.
async function fetchHistory(symbol, limit = 200, intervalHours = FUNDING_INTERVAL_HOURS) {
  const endTime = Date.now();
  const startTime = endTime - limit * (intervalHours || FUNDING_INTERVAL_HOURS) * 60 * 60 * 1000;
  const rows = await getJson(
    `/info/${encodeURIComponent(symbol)}/funding?startTime=${startTime}&endTime=${endTime}`
  );
  return (rows || [])
    .map((r) => ({ rate: Number(r.f), time: Number(r.T) }))
    .filter((r) => Number.isFinite(r.rate) && Number.isFinite(r.time))
    .sort((a, b) => a.time - b.time)
    .slice(-limit);
}

module.exports = { id: 'extended', label: 'Extended', fetchCurrent, fetchHistory };

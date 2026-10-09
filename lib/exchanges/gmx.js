// GMX v2 — on-chain perpetual DEX on Arbitrum (Avalanche deployment exists too
// but carries a small fraction of GMX's volume, not covered here). Public
// Oracle/API endpoints, no key needed.
// Docs: https://docs.gmx.io/docs/api/integration-guide/
//
// Architecturally different from every other exchange in this scanner:
// - Funding is CONTINUOUS (accrues per-second based on long/short OI
//   imbalance), not a periodic settlement — there's no "next funding time".
//   /markets/info's fundingRateLong/Short/borrowingRateLong/Short fields are
//   already pre-annualized (raw / 1e30 = APR fraction directly) — confirmed
//   live across all 120 listed markets, ~98% fall within GMX's own
//   documented ±300% APR keeper bounds. This is a DIFFERENT scale than the
//   /rates history endpoint's fields of the same name, which are raw
//   per-second factors (raw / 1e30 = per-second fraction, needs ×31,536,000
//   for APR) — confirmed by cross-checking both endpoints against the same
//   ETH/USD market and getting matching ~3.5% magnitudes via each field's
//   own correct formula.
// - Each base asset can have MULTIPLE pools with different collateral
//   backing (BTC/ETH/SOL each have 4 on Arbitrum) — this picks the
//   highest-OI pool per asset as "the" market, same idea as picking a
//   primary venue.
// - The listed-market catalog also includes GMX's synthetic TradFi markets
//   (GOLD, SILVER, oil, QQQ, SPY, XAUT...) alongside crypto — excluded by an
//   explicit ticker list taken from GMX's own fee-schedule docs, which
//   enumerate them.
// - /rates?period=30d with no `address` filter (meant to return every
//   market's history in one bulk call) reliably 500s — confirmed live,
//   repeatedly. The same endpoint scoped to one market via `address=` works
//   fine, so history is fetched per-market like every other exchange here.
const ORACLE_BASE = 'https://arbitrum-api.gmxinfra.io';
const API_BASE = 'https://arbitrum.gmxapi.io/v1';
const SCALE = 1e30;
const SECONDS_PER_YEAR = 31536000;
const HOURS_PER_YEAR = 8760;

const TRADFI_TICKERS = new Set(['GOLD', 'SILVER', 'WTIOIL', 'BRENTOIL', 'NATGAS', 'SPCX', 'QQQ', 'SPY', 'XAUT', 'XAUT.v2']);

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'funding-tracker/1.0' } });
  if (!res.ok) throw new Error(`GMX ${url} -> HTTP ${res.status}`);
  return res.json();
}

// baseAsset -> marketToken (pool) address, for the highest-OI pool chosen
// for that asset — populated by fetchCurrent(), reused by fetchHistory().
let marketAddressByAsset = new Map();

function computePrice(raw, decimals) {
  if (raw === undefined || raw === null || decimals === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n / 10 ** (30 - decimals) : null;
}

async function fetchCurrent() {
  const [marketsRes, tokensRes, pricesRes] = await Promise.all([
    getJson(`${ORACLE_BASE}/markets/info`),
    getJson(`${ORACLE_BASE}/tokens`),
    getJson(`${ORACLE_BASE}/prices/tickers`),
  ]);

  const decimalsBySymbol = new Map((tokensRes.tokens || []).map((t) => [t.symbol, t.decimals]));
  const priceBySymbol = new Map();
  for (const p of pricesRes || []) {
    const decimals = decimalsBySymbol.get(p.tokenSymbol);
    const min = computePrice(p.minPrice, decimals);
    const max = computePrice(p.maxPrice, decimals);
    if (min !== null && max !== null) priceBySymbol.set(p.tokenSymbol, (min + max) / 2);
  }

  // Group listed, non-TradFi pools by base asset, keep only the one with the
  // most open interest per asset.
  const bestByAsset = new Map();
  for (const m of marketsRes.markets || []) {
    if (!m.isListed) continue;
    const baseAsset = (m.name || '').split('/')[0];
    if (!baseAsset || TRADFI_TICKERS.has(baseAsset)) continue;

    const oiLong = Number(m.openInterestLong) / SCALE;
    const oiShort = Number(m.openInterestShort) / SCALE;
    const oiTotal = oiLong + oiShort;
    const existing = bestByAsset.get(baseAsset);
    if (!existing || oiTotal > existing.oiTotal) {
      bestByAsset.set(baseAsset, { market: m, oiTotal, oiLong, oiShort });
    }
  }

  marketAddressByAsset = new Map(
    Array.from(bestByAsset.entries()).map(([asset, { market }]) => [asset, market.marketToken])
  );

  return Array.from(bestByAsset.entries())
    .map(([baseAsset, { market: m, oiTotal }]) => {
      // fundingRateLong here is already annualized (raw/SCALE = APR
      // fraction) — convert to the hourly-equivalent rate this scanner's
      // annualizedPct(rate, intervalHours) expects, since GMX has no real
      // "funding interval" to report. Positive fundingRateLong means longs
      // pay shorts — same sign convention as every periodic-funding
      // exchange already in this scanner.
      const fundingAprLong = Number(m.fundingRateLong) / SCALE;
      if (!Number.isFinite(fundingAprLong)) return null;
      const fundingRate = fundingAprLong / HOURS_PER_YEAR;

      return {
        exchange: 'gmx',
        symbol: baseAsset,
        fundingRate,
        intervalHours: 1,
        nextFundingTime: null,
        price: priceBySymbol.get(baseAsset) ?? null,
        openInterestUsd: Number.isFinite(oiTotal) ? oiTotal : null,
      };
    })
    .filter((r) => r);
}

// Returns the last `limit` hourly rate snapshots for one symbol's chosen
// pool, oldest first. /rates comes back newest-first (confirmed live), and
// its fundingRateLong is a raw per-second factor here — unlike
// /markets/info's pre-annualized field of the same name — so it's
// multiplied by 3600 (not 31,536,000) to get the hourly-equivalent rate
// matching this adapter's intervalHours: 1 convention.
async function fetchHistory(symbol, limit = 200) {
  const marketAddress = marketAddressByAsset.get(symbol);
  if (!marketAddress) throw new Error(`GMX: unknown market for ${symbol}`);

  const rows = await getJson(`${API_BASE}/rates?period=30d&address=${marketAddress}`);
  const match = (rows || []).find((r) => r.marketAddress === marketAddress);
  const snapshots = (match && match.ratesSnapshots) || [];

  return snapshots
    .map((s) => ({ rate: (Number(s.fundingRateLong) / SCALE) * 3600, time: Number(s.timestamp) * 1000 }))
    .filter((r) => Number.isFinite(r.rate) && Number.isFinite(r.time))
    .sort((a, b) => a.time - b.time)
    .slice(-limit);
}

module.exports = { id: 'gmx', label: 'GMX', fetchCurrent, fetchHistory };

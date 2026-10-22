// Variational Omni — P2P/RFQ derivatives protocol (not an orderbook
// exchange: market makers quote via RFQ). Public REST API, no key needed.
// Docs: https://docs.variational.io/technical-documentation/api
const { filterToCrypto } = require('../cryptoassets');
const variationalHistory = require('../variationalFundingHistory');

const BASE = 'https://omni-client-api.prod.ap-northeast-1.variational.io';

async function getJson(path) {
  const res = await fetch(BASE + path, { headers: { 'User-Agent': 'funding-tracker/1.0' } });
  if (!res.ok) throw new Error(`Variational ${path} -> HTTP ${res.status}`);
  return res.json();
}

// "1000BONK-PERP" -> "1000BONK", "BTC-PERP" -> "BTC" — strips the
// contract-type suffix every ticker carries (v2 API convention) so
// isCrypto()/splitSymbol downstream can size the price-band check and
// multiplier prefix correctly, same as every other exchange's bare tickers.
function rawBase(ticker) {
  return ticker.replace(/-PERP$/, '');
}

// Returns current funding for every active crypto perpetual, in one bulk
// request — Variational has no per-symbol fan-out at all, current funding
// rate, OI and 24h volume are all on this single response.
//
// listings mix three things under contract_type "perpetual": real crypto,
// TradFi RWA (AAPL, TSLA, QQQ, XAU, COPPER, ...) and pre-IPO speculation
// (ANTHROPIC, OPENAI) — confirmed live across all 562 perpetual listings in
// a real 580-market dump, with zero field distinguishing them (same
// situation as Lighter/GRVT), so filterToCrypto()'s CoinGecko cross-check is
// the only way to separate them. A further 18 listings carry contract_type
// "swap" instead (financing-cost-based synthetic exposure — mostly metals/
// commodities, e.g. XAU-SWAP) — excluded entirely rather than filtered,
// since swaps report separate long/short rates with no single signed
// funding rate this scanner's row shape can represent.
//
// Variational's public API has no history endpoint at all (the only
// historical feed documented is a private, wallet-authenticated CSV export
// of one's own trades) — fetchHistory below is backed by
// lib/variationalFundingHistory.js, which this function feeds on every call
// by recording each kept market's current rate/next-settlement pair.
async function fetchCurrent() {
  const stats = await getJson('/metadata/v2/stats');
  const perpetuals = (stats.listings || []).filter((l) => l.contract_type === 'perpetual' && l.funding);

  const crypto = filterToCrypto(perpetuals, {
    exchange: 'variational',
    symbolOf: (l) => rawBase(l.ticker),
    priceOf: (l) => Number(l.mark_price),
  });

  const rows = crypto
    .map((l) => {
      const rate = Number(l.funding.last.interval_rate);
      const intervalSeconds = Number(l.funding.interval_seconds);
      const nextFundingTime = Number(l.funding.next_timestamp) * 1000;
      if (!Number.isFinite(rate) || !Number.isFinite(intervalSeconds)) return null;

      const price = Number(l.mark_price) || null;
      // Both already USDC-denominated per-market figures (not the
      // platform-wide double-sided total) — confirmed against the docs'
      // own field descriptions, no price multiplication needed.
      const longOi = Number(l.open_interest && l.open_interest.long_open_interest) || 0;
      const shortOi = Number(l.open_interest && l.open_interest.short_open_interest) || 0;
      const volume24hUsd = Number(l.volume_24h);

      return {
        exchange: 'variational',
        symbol: l.ticker,
        fundingRate: rate,
        intervalHours: intervalSeconds / 3600,
        nextFundingTime: Number.isFinite(nextFundingTime) ? nextFundingTime : null,
        price,
        openInterestUsd: longOi + shortOi,
        volume24hUsd: Number.isFinite(volume24hUsd) ? volume24hUsd : null,
      };
    })
    .filter((r) => r);

  for (const row of rows) {
    variationalHistory.recordObservation(row.symbol, { rate: row.fundingRate, nextFundingTime: row.nextFundingTime });
  }
  variationalHistory.flush();

  return rows;
}

// Backed entirely by lib/variationalFundingHistory.js's locally-accumulated
// store (see fetchCurrent above) rather than a network request — there's no
// history endpoint to call. Returns whatever has accumulated so far, which
// starts empty for every market on a cold deploy and only reaches a full
// 30-day window after 30 real days of uptime.
async function fetchHistory(symbol, limit = 200) {
  return variationalHistory.getHistory(symbol, limit);
}

module.exports = { id: 'variational', label: 'Variational', fetchCurrent, fetchHistory };

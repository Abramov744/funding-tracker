// Market-cap ranking via CoinGecko's public API (no API key required).
// Used purely as a risk signal next to funding data — a high rank (small/no name
// coin) often means thin liquidity and a wider spot/futures spread than the
// funding rate alone suggests.
const BASE = 'https://api.coingecko.com/api/v3';
const PAGES = 6; // 6 * 250 = top 1500 coins by market cap
const PER_PAGE = 250;
const PAGE_DELAY_MS = 2000; // anonymous CoinGecko calls are rate-limited; space requests out
const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // ranks don't move fast; refresh hourly

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const state = {
  rankBySymbol: new Map(), // lowercase base symbol -> { rank, name, id }
  updatedAt: null,
};

async function getJson(path) {
  const res = await fetch(BASE + path, { headers: { 'User-Agent': 'funding-tracker/1.0' } });
  if (!res.ok) throw new Error(`CoinGecko ${path} -> HTTP ${res.status}`);
  return res.json();
}

async function refresh() {
  const rankBySymbol = new Map();

  for (let page = 1; page <= PAGES; page++) {
    let coins;
    try {
      coins = await getJson(
        `/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${PER_PAGE}&page=${page}&sparkline=false`
      );
    } catch (err) {
      // Keep whatever pages we already fetched (still far better than nothing)
      // instead of throwing the whole refresh away over one rate-limited page.
      console.error('CoinGecko rank refresh: stopping early —', err.message || err);
      break;
    }
    if (!coins || coins.length === 0) break;

    for (const coin of coins) {
      const symbol = (coin.symbol || '').toLowerCase();
      if (!symbol || coin.market_cap_rank == null) continue;
      // Ticker collisions happen (multiple coins share a symbol) — keep the
      // one with the lower (= more prominent) rank, since that's the coin
      // an exchange listing under that ticker most likely refers to.
      const existing = rankBySymbol.get(symbol);
      if (!existing || coin.market_cap_rank < existing.rank) {
        rankBySymbol.set(symbol, { rank: coin.market_cap_rank, name: coin.name, id: coin.id });
      }
    }

    if (coins.length < PER_PAGE) break; // reached the end of the list
    if (page < PAGES) await sleep(PAGE_DELAY_MS);
  }

  if (rankBySymbol.size > 0) {
    state.rankBySymbol = rankBySymbol;
    state.updatedAt = Date.now();
  }
}

function lookup(baseAsset) {
  const entry = state.rankBySymbol.get((baseAsset || '').toLowerCase());
  return entry ? entry.rank : null;
}

// CoinGecko coin id (e.g. "bitcoin") for the given base asset — used to look up
// per-exchange spot prices via CoinGecko's /coins/{id}/tickers endpoint.
function lookupId(baseAsset) {
  const entry = state.rankBySymbol.get((baseAsset || '').toLowerCase());
  return entry ? entry.id : null;
}

// Assumes an initial refresh() has already been awaited by the caller;
// this only schedules the recurring one.
function startAutoRefresh() {
  setInterval(() => {
    refresh().catch((err) => console.error('CoinGecko rank refresh failed:', err));
  }, REFRESH_INTERVAL_MS);
}

module.exports = { lookup, lookupId, startAutoRefresh, refresh, state };

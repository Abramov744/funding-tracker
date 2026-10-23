// Full CoinGecko coin universe + its own authoritative tokenized-RWA list.
//
// lib/marketcap.js only ranks the top ~1500 coins by market cap (6 paginated
// /coins/markets pages) — that's enough to rank and price-cross-check the
// coins that matter for display, but it means a real low-cap coin outside
// that cutoff reads identically, to lib/cryptoassets.js's isCrypto(), as a
// ticker CoinGecko has never heard of at all: both get rejected the same way.
// That silently drops any genuine low-cap alt a perp DEX lists, which is
// exactly the kind of thin, inefficiently-priced market a funding-arbitrage
// scanner should want to see, not hide.
//
// This module gives isCrypto() a second, much wider net before giving up on
// a ticker: CoinGecko's full coin list (~22k ids, every coin it tracks,
// however small) minus CoinGecko's own authoritative RWA list (the tokenized
// stocks/ETFs/commodities it tracks separately, e.g. AAPL, SPY, XAU) — the
// same classification problem lib/marketcap.js's name-based regex and
// lib/cryptoassets.js's price-band check currently guess at, now answered by
// CoinGecko's own data instead of a heuristic. Verified against the exact
// tickers those heuristics exist to catch: NVDA/TSLA/AAPL/SPY/XAU are all
// present in both /coins/list AND /rwas/list (correctly excluded), while
// BTC/SOL are in /coins/list but absent from /rwas/list (correctly kept).
//
// Both lists change slowly (new coin listings, new tokenized-stock wrappers)
// so a daily refresh is enough — unlike lib/marketcap.js's hourly rank
// refresh, which exists to keep *prices* current for the collision check,
// not to catch newly-listed tickers same-day.
const BASE = 'https://api.coingecko.com/api/v3';
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // both lists move slowly
const BOOTSTRAP_RETRY_MS = 2 * 60 * 1000;
const PAGE_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 3000;
// Both lists run into the tens of thousands / low thousands — any real fetch
// clears this by a wide margin. Only guards the empty/not-yet-booted case,
// same role as marketcap.js's own MIN_USABLE_SIZE.
const MIN_USABLE_SIZE = 1000;

const state = {
  coinSymbols: new Set(), // lowercase symbol -> real coin CoinGecko tracks, any market-cap rank
  rwaSymbols: new Set(), // lowercase symbol -> tokenized stock/ETF/commodity CoinGecko tracks
  updatedAt: null,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson(path) {
  const headers = { 'User-Agent': 'funding-tracker/1.0' };
  if (process.env.COINGECKO_API_KEY) headers['x-cg-demo-api-key'] = process.env.COINGECKO_API_KEY;

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(BASE + path, { headers });
    if (res.ok) return res.json();
    if (res.status === 429 && attempt < PAGE_RETRIES) {
      await sleep(RETRY_BASE_DELAY_MS * (attempt + 1));
      continue;
    }
    throw new Error(`CoinGecko ${path} -> HTTP ${res.status}`);
  }
}

async function refresh() {
  // Fetch both lists independently — a rate-limited/failed fetch of one
  // shouldn't throw away the other, same "keep last-known-good" approach as
  // lib/marketcap.js's own refresh().
  const [coins, rwas] = await Promise.allSettled([getJson('/coins/list'), getJson('/rwas/list')]);

  if (coins.status === 'fulfilled' && Array.isArray(coins.value)) {
    state.coinSymbols = new Set(coins.value.map((c) => (c.symbol || '').toLowerCase()).filter(Boolean));
  } else if (coins.status === 'rejected') {
    console.error('CoinGecko full coin list refresh failed:', coins.reason?.message || coins.reason);
  }

  if (rwas.status === 'fulfilled' && Array.isArray(rwas.value)) {
    state.rwaSymbols = new Set(rwas.value.map((r) => (r.symbol || '').toLowerCase()).filter(Boolean));
  } else if (rwas.status === 'rejected') {
    console.error('CoinGecko RWA list refresh failed:', rwas.reason?.message || rwas.reason);
  }

  if (coins.status === 'fulfilled' || rwas.status === 'fulfilled') state.updatedAt = Date.now();
}

// True when `symbol` is a ticker CoinGecko tracks as a real coin (any
// market-cap rank, not just marketcap.js's top-1500 cutoff) and is NOT one
// of CoinGecko's own tokenized stock/ETF/commodity wrappers. No price
// cross-check is possible here — the full coin list carries no price — so
// this is a lower-confidence fallback for tickers the ranked, price-checked
// path in lib/cryptoassets.js already missed, not a replacement for it.
function isKnownNonRwaCoin(symbol) {
  const s = (symbol || '').toLowerCase();
  if (!s) return false;
  return state.coinSymbols.has(s) && !state.rwaSymbols.has(s);
}

function isRwaSymbol(symbol) {
  return state.rwaSymbols.has((symbol || '').toLowerCase());
}

function isUsable() {
  return state.coinSymbols.size >= MIN_USABLE_SIZE;
}

function size() {
  return state.coinSymbols.size;
}

// Same bootstrap-retry shape as lib/marketcap.js: if the first fetch comes
// back too thin (or empty) to trust, retry every 2 minutes until it clears
// the usability bar, then fall back to the normal daily cadence.
function startAutoRefresh() {
  if (!isUsable()) {
    const retryTimer = setInterval(() => {
      refresh()
        .then(() => {
          if (isUsable()) clearInterval(retryTimer);
        })
        .catch((err) => console.error('CoinGecko full-list bootstrap retry failed:', err));
    }, BOOTSTRAP_RETRY_MS);
  }

  setInterval(() => {
    refresh().catch((err) => console.error('CoinGecko full-list refresh failed:', err));
  }, REFRESH_INTERVAL_MS);
}

module.exports = { refresh, isKnownNonRwaCoin, isRwaSymbol, isUsable, size, startAutoRefresh, state };

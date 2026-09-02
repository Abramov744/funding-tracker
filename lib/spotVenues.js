// Allow-list of spot exchanges shown in the "where to buy this coin on spot"
// popup. The official CoinMarketCap exchange ranking needs a paid/registered
// API key, so — same substitution lib/marketcap.js already makes for coin
// ranks — we use CoinGecko's public /exchanges endpoint, which ranks
// exchanges by its own "trust score" (a comparable centralized-exchange
// liquidity/reputation ranking) and requires no key.
const BASE = 'https://api.coingecko.com/api/v3';
const TOP_N = 15;
const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // exchange rankings move slowly; hourly is plenty

// Aster is a perp-only DEX with no spot market of its own, but the strategy
// explicitly wants it considered alongside the top 15 — if CoinGecko ever
// lists a spot venue under this id, it starts showing up automatically;
// until then it just never matches a ticker.
const ALWAYS_INCLUDED_IDS = ['aster'];

const state = {
  venues: new Map(), // coingecko exchange id -> display name
  updatedAt: null,
};

async function getJson(path) {
  const res = await fetch(BASE + path, { headers: { 'User-Agent': 'funding-tracker/1.0' } });
  if (!res.ok) throw new Error(`CoinGecko ${path} -> HTTP ${res.status}`);
  return res.json();
}

async function refresh() {
  const list = await getJson(`/exchanges?per_page=${TOP_N}&page=1`);
  if (!Array.isArray(list) || list.length === 0) return;

  const venues = new Map();
  for (const ex of list) {
    if (ex.id) venues.set(ex.id, ex.name || ex.id);
  }
  for (const id of ALWAYS_INCLUDED_IDS) {
    if (!venues.has(id)) venues.set(id, id);
  }

  state.venues = venues;
  state.updatedAt = Date.now();
}

function allowedIds() {
  return Array.from(state.venues.keys());
}

function nameFor(id) {
  return state.venues.get(id) || id;
}

// Assumes an initial refresh() has already been awaited by the caller;
// this only schedules the recurring one.
function startAutoRefresh() {
  setInterval(() => {
    refresh().catch((err) => console.error('CoinGecko exchange-list refresh failed:', err));
  }, REFRESH_INTERVAL_MS);
}

module.exports = { refresh, allowedIds, nameFor, startAutoRefresh, state };

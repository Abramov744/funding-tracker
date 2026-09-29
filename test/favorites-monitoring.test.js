// No-network integration test: a favorited coin must keep getting its history
// fetched (and so keep its stats/eligibility) even when its current rate
// would otherwise put it outside the top-N-by-rate candidate cutoff in
// lib/cache.js's buildRowsForExchange.
const os = require('os');
const path = require('path');
const fs = require('fs');
const Module = require('module');

// Point lib/favorites.js's persistence at a throwaway dir so this test never
// touches the real repo's data/favorites.json.
const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-favorites-test-'));
process.env.RAILWAY_VOLUME_MOUNT_PATH = tmpDataDir;

const marketcap = require(path.join(__dirname, '..', 'lib', 'marketcap.js'));
const favorites = require(path.join(__dirname, '..', 'lib', 'favorites.js'));

// Favorite a coin *before* it's ever seen by the cache — mirrors a user
// starring a coin that's currently unremarkable. Uses the spread tab's list
// specifically, to prove lib/cache.js force-monitors off the union of both
// tabs' favorites (hasAny), not just the funding tab's.
favorites.add('spread', 'ZZZ');
if (!favorites.has('spread', 'zzz')) throw new Error('FAIL: favorites.has should be case-insensitive');
if (favorites.has('funding', 'ZZZ')) throw new Error('FAIL: favoriting on the spread tab should not mark it on the funding tab');
if (!favorites.hasAny('ZZZ')) throw new Error('FAIL: hasAny should see a spread-tab favorite');
if (JSON.parse(fs.readFileSync(path.join(tmpDataDir, 'favorites.json'), 'utf8')).spread[0] !== 'ZZZ') {
  throw new Error('FAIL: favorites.add should persist to disk immediately');
}

const HOUR = 60 * 60 * 1000;
const now = Date.now();
function buildHistory(stepHours, rate, hoursBack) {
  const rows = [];
  for (let h = hoursBack; h >= 0; h -= stepHours) rows.push({ rate, time: now - h * HOUR });
  return rows;
}

// 205 symbols with strictly descending positive rates -> MAX_CANDIDATES_PER_EXCHANGE
// (200) cuts the ranking off before the last 5, including our favorited coin
// (ZZZUSDT, rate rank #205 = the lowest of all).
const current = [];
for (let i = 0; i < 205; i++) {
  const symbol = i === 204 ? 'ZZZUSDT' : `COIN${i}USDT`;
  current.push({
    exchange: 'ex1',
    symbol,
    fundingRate: 0.001 - i * 0.000001, // strictly descending
    intervalHours: 8,
    nextFundingTime: null,
    price: 100,
  });
}

const fetchedHistoryFor = new Set();
const exOne = {
  id: 'ex1',
  label: 'Exchange One',
  async fetchCurrent() {
    return current;
  },
  async fetchHistory(symbol) {
    fetchedHistoryFor.add(symbol);
    return buildHistory(8, 0.0005, 720);
  },
};

const fakeExchangesModule = { EXCHANGES: [exOne], byId: new Map([['ex1', exOne]]) };
const exchangesPath = require.resolve(path.join(__dirname, '..', 'lib', 'exchanges', 'index.js'));
require.cache[exchangesPath] = new Module(exchangesPath);
require.cache[exchangesPath].exports = fakeExchangesModule;
require.cache[exchangesPath].loaded = true;

const cache = require(path.join(__dirname, '..', 'lib', 'cache.js'));

(async () => {
  await cache.refresh({ force: true });
  const state = cache.getState();

  console.log(`state.rows: ${state.rows.length}`);
  if (state.rows.length !== 205) throw new Error(`FAIL: expected 205 rows total, got ${state.rows.length}`);

  const zzzRow = state.rows.find((r) => r.symbol === 'ZZZUSDT');
  if (!zzzRow) throw new Error('FAIL: favorited coin missing from state.rows entirely');
  console.log('favorited row:', zzzRow);

  if (!zzzRow.historyChecked) {
    throw new Error('FAIL: favorited coin should have historyChecked=true despite ranking outside the top-N cutoff');
  }
  if (zzzRow.periods < 80) {
    throw new Error(`FAIL: expected ~90 periods of history (720h / 8h interval) for the favorited row, got ${zzzRow.periods}`);
  }
  if (!fetchedHistoryFor.has('ZZZUSDT')) {
    throw new Error('FAIL: fetchHistory should have been called for the favorited symbol');
  }

  // A non-favorited coin at the same rank (#204, the second-lowest rate) must
  // still be excluded, proving the fix is targeted rather than just raising
  // the cap for everyone.
  const unfavoredTailRow = state.rows.find((r) => r.symbol === 'COIN203USDT');
  if (!unfavoredTailRow) throw new Error('FAIL: COIN203USDT row missing');
  if (unfavoredTailRow.historyChecked) {
    throw new Error('FAIL: an unfavorited coin ranked outside the top-N cutoff should NOT have history fetched');
  }

  // --- Unfavorite: the next refresh should stop force-including it ---
  favorites.remove('spread', 'ZZZ');
  fetchedHistoryFor.clear();
  await cache.refresh({ force: true });
  const state2 = cache.getState();
  const zzzRow2 = state2.rows.find((r) => r.symbol === 'ZZZUSDT');
  if (zzzRow2.historyChecked) {
    throw new Error('FAIL: after removing the favorite, the coin should no longer be force-included');
  }

  console.log('ALL PASS');
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

// No-network integration test: verifies lib/cache.js's refresh() correctly
// wires negative-rate candidates + spread computation end-to-end, by
// substituting lib/exchanges/index.js's EXCHANGES with two fake adapters
// before requiring lib/cache.js fresh.
const path = require('path');
const Module = require('module');

const marketcap = require(path.join(__dirname, '..', 'lib', 'marketcap.js'));
marketcap.state.rankBySymbol.set('btc', { rank: 1, name: 'Bitcoin', id: 'bitcoin', price: 90000 });

const HOUR = 60 * 60 * 1000;
const now = Date.now();
function buildHistory(stepHours, rate, hoursBack) {
  const rows = [];
  for (let h = hoursBack; h >= 0; h -= stepHours) rows.push({ rate, time: now - h * HOUR });
  return rows;
}

// Exchange 1: BTC pays a strong positive rate (good short leg).
const exOne = {
  id: 'ex1',
  label: 'Exchange One',
  async fetchCurrent() {
    return [{ exchange: 'ex1', symbol: 'BTC', fundingRate: 0.001, intervalHours: 8, nextFundingTime: null, price: 90000 }];
  },
  async fetchHistory(symbol, limit, intervalHours) {
    return buildHistory(8, 0.001, 720);
  },
};

// Exchange 2: same coin, currently *negative* -> would have been invisible
// to the old positive-only candidate selection, but is exactly the long leg
// this feature needs to find.
const exTwo = {
  id: 'ex2',
  label: 'Exchange Two',
  async fetchCurrent() {
    return [{ exchange: 'ex2', symbol: 'BTC', fundingRate: -0.0001, intervalHours: 1, nextFundingTime: null, price: 90010 }];
  },
  async fetchHistory(symbol, limit, intervalHours) {
    return buildHistory(1, -0.0001, 720);
  },
};

const fakeExchangesModule = { EXCHANGES: [exOne, exTwo], byId: new Map([['ex1', exOne], ['ex2', exTwo]]) };
const exchangesPath = require.resolve(path.join(__dirname, '..', 'lib', 'exchanges', 'index.js'));
require.cache[exchangesPath] = new Module(exchangesPath);
require.cache[exchangesPath].exports = fakeExchangesModule;
require.cache[exchangesPath].loaded = true;

const cache = require(path.join(__dirname, '..', 'lib', 'cache.js'));

(async () => {
  await cache.refresh({ force: true });
  const state = cache.getState();

  console.log(`state.rows: ${state.rows.length}`);
  const ex2Row = state.rows.find((r) => r.exchange === 'ex2');
  if (!ex2Row) throw new Error('FAIL: ex2 (negative-rate) row missing from state.rows entirely');
  // The key behavioral change: a negative-rate row now gets real history
  // stats too (needed for the long leg's own stability), not just zeros.
  if (!ex2Row.historyChecked) throw new Error('FAIL: negative-rate candidate should now have historyChecked=true');
  if (ex2Row.periods < 700) throw new Error(`FAIL: expected ~720 periods of history for the negative-rate row, got ${ex2Row.periods}`);

  console.log(`state.spreadRows: ${state.spreadRows.length}`);
  if (state.spreadRows.length !== 1) throw new Error(`FAIL: expected exactly 1 spread row, got ${state.spreadRows.length}`);
  const row = state.spreadRows[0];
  if (row.baseAsset !== 'BTC') throw new Error(`FAIL: baseAsset ${row.baseAsset}`);
  if (row.shortExchange !== 'ex1' || row.longExchange !== 'ex2') {
    throw new Error(`FAIL: expected short=ex1/long=ex2, got short=${row.shortExchange}/long=${row.longExchange}`);
  }
  if (row.spreadAprPct <= 0) throw new Error(`FAIL: spreadAprPct should be positive, got ${row.spreadAprPct}`);

  console.log('ALL PASS');
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

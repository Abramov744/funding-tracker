// No-network regression tests for symbol normalization.
const { baseAsset, splitSymbol } = require('../lib/metrics');
const marketcap = require('../lib/marketcap');

const cases = [
  ['BTC-PERP', 'BTC'],
  ['BTC-USD-PERP', 'BTC'],
  ['1000BONK-PERP', 'BONK'],
  ['BTCUSDT', 'BTC'],
  ['BTC_USDT', 'BTC'],
  ['XBTUSDTM', 'BTC'],
];

for (const [symbol, expected] of cases) {
  const actual = baseAsset(symbol);
  if (actual !== expected) {
    throw new Error(`FAIL: baseAsset(${symbol}) = ${actual}; expected ${expected}`);
  }
}

const multiplied = splitSymbol('1000BONK-PERP');
if (multiplied.base !== 'BONK' || multiplied.multiplier !== 1000) {
  throw new Error(`FAIL: splitSymbol(1000BONK-PERP) = ${JSON.stringify(multiplied)}`);
}

marketcap.state.rankBySymbol.set('btc', { rank: 1, name: 'Bitcoin', id: 'bitcoin', price: 90000 });
if (marketcap.lookup(baseAsset('BTC-PERP')) !== 1) {
  throw new Error('FAIL: BTC-PERP did not resolve to the BTC market-cap rank');
}

console.log('Symbol normalization tests PASS');

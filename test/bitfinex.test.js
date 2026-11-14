// No-network adapter test for Bitfinex's public status payload shape.
const path = require('path');

const cryptoassetsPath = require.resolve(path.join(__dirname, '..', 'lib', 'cryptoassets.js'));
require.cache[cryptoassetsPath] = {
  id: cryptoassetsPath,
  filename: cryptoassetsPath,
  loaded: true,
  exports: {
    filterToCrypto(rows, { symbolOf }) {
      return rows.filter((row) => symbolOf(row) === 'BTC');
    },
  },
};

const bitfinex = require(path.join(__dirname, '..', 'lib', 'exchanges', 'bitfinex.js'));

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

function response(data) {
  return { ok: true, async json() { return data; } };
}

(async () => {
  assert(bitfinex.parseKey('tBTCF0:USTF0') === 'BTC', 'parse USDt perpetual key');
  assert(bitfinex.parseKey('tAAPL F0:USTF0') === null, 'reject malformed key');
  assert(bitfinex.parseKey('tBTCF0:BTCF0') === null, 'reject non-USDt collateral market');
  assert(!bitfinex.isCryptoMarketKey('tXAUTF0:USTF0'), 'reject tokenized gold ticker collision');
  assert(!bitfinex.isCryptoMarketKey('tEUROPE50IXF0:USTF0'), 'reject index markets');
  assert(!bitfinex.isCryptoMarketKey('tTESTBTCF0:TESTUSDTF0'), 'reject testnet market');

  const now = Date.now();
  const nextFundingTime = now + 60_000;
  global.fetch = async (url) => {
    if (String(url).includes('/status/deriv?keys=ALL')) {
      return response([
        ['tBTCF0:USTF0', now, null, 101, 100, null, null, null, nextFundingTime, 0.0003, 0, null, 0.0001, null, null, 102, null, null, 1000],
        ['tETHF0:USTF0', now, null, 20, 20, null, null, null, nextFundingTime, 0.0004, 0, null, 0.0002, null, null, 20, null, null, 500],
        ['tTESTF0:USTF0', now, null, 1, 1, null, null, null, nextFundingTime, 0.0005, 0, null, 0.1, null, null, 1],
      ]);
    }

    return response([
      [now - 2000, null, 101, 100, null, null, null, nextFundingTime, 0, 0, null, 0.0001],
      [now - 1000, null, 101, 100, null, null, null, nextFundingTime, 0, 0, null, 0.0002],
    ]);
  };

  const current = await bitfinex.fetchCurrent();
  assert(current.length === 1 && current[0].symbol === 'BTC', 'filter status rows to crypto USDt markets');
  assert(current[0].fundingRate === 0.0003 && current[0].intervalHours === 8, 'map accrued rate and interval');
  assert(current[0].price === 102 && current[0].nextFundingTime === nextFundingTime, 'map price and settlement time');
  assert(current[0].openInterestUsd === null && current[0].volume24hUsd === null, 'do not mislabel unknown USD metrics');

  const history = await bitfinex.fetchHistory('BTC', 90);
  assert(history.length === 1, 'deduplicate repeated snapshots within one funding interval');
  assert(history[0].rate === 0.0002 && history[0].time === now - 1000, 'keep newest snapshot in the interval');
  console.log('ALL PASS');
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

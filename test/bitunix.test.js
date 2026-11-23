const path = require('path');
const cryptoassetsPath = require.resolve(path.join(__dirname, '..', 'lib', 'cryptoassets.js'));
require.cache[cryptoassetsPath] = { id: cryptoassetsPath, filename: cryptoassetsPath, loaded: true, exports: {
  filterToCrypto(rows, { symbolOf }) { return rows.filter((row) => symbolOf(row) === 'BTC'); },
} };
const bitunix = require('../lib/exchanges/bitunix');
function assert(ok, message) { if (!ok) throw new Error(`FAIL: ${message}`); }
function response(data) { return { ok: true, async json() { return { code: 0, msg: 'Success', data }; } }; }
(async () => {
  let historyUrl;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/funding_rate/batch')) return response([{ symbol: 'BTCUSDT', markPrice: '60000', fundingRate: '0.0005', fundingInterval: 8, nextFundingTime: '1800000000000' }, { symbol: 'TSLAUSDT', markPrice: '300', fundingRate: '0.001', fundingInterval: 8 }]);
    if (u.endsWith('/tickers')) return response([{ symbol: 'BTCUSDT', markPrice: '60000', lastPrice: '59999', quoteVol: '120000000', baseVol: '2000' }, { symbol: 'TSLAUSDT', quoteVol: '4' }]);
    if (u.endsWith('/trading_pairs')) return response([{ symbol: 'BTCUSDT', quote: 'USDT', symbolStatus: 'OPEN' }, { symbol: 'TSLAUSDT', quote: 'USDT', symbolStatus: 'OPEN' }]);
    if (u.includes('/get_funding_rate_history')) { historyUrl = u; return response([{ fundingRate: '0.0003', fundingTime: '1000' }, { fundingRate: '-0.0001', fundingTime: '2000' }]); }
    throw new Error(`Unexpected URL: ${u}`);
  };
  const rows = await bitunix.fetchCurrent();
  assert(rows.length === 1 && rows[0].symbol === 'BTCUSDT', 'include live crypto USDT perpetual and filter non-crypto');
  assert(rows[0].fundingRate === 0.0005 && rows[0].intervalHours === 8 && rows[0].nextFundingTime === 1800000000000, 'parse current funding fields');
  assert(rows[0].price === 60000 && rows[0].volume24hUsd === 120000000 && rows[0].openInterestUsd === null, 'map mark, quote volume, and unsupported OI');
  const history = await bitunix.fetchHistory('BTCUSDT', 150);
  assert(history.length === 2 && history[0].time === 1000 && history[1].rate === -0.0001, 'normalize and sort funding history');
  assert(historyUrl.includes('symbol=BTCUSDT') && historyUrl.includes('limit=150'), 'request correct history pair and limit');
  const bounded = await bitunix.fetchHistory('BTCUSDT', 500);
  assert(historyUrl.includes('limit=200'), 'respect Bitunix 200-row history cap');
  assert(bounded.length === 2, 'return valid records after capping');
  const { byId } = require('../lib/exchanges');
  assert(byId.get('bitunix') === bitunix, 'register Bitunix in scanner');
  console.log('ALL PASS');
})().catch((err) => { console.error(err); process.exit(1); });

const path = require('path');
const cryptoassetsPath = require.resolve(path.join(__dirname, '..', 'lib', 'cryptoassets.js'));
require.cache[cryptoassetsPath] = { id: cryptoassetsPath, filename: cryptoassetsPath, loaded: true, exports: {
  filterToCrypto(rows, { symbolOf }) { return rows.filter((row) => symbolOf(row) === 'BTC'); },
} };
const xt = require('../lib/exchanges/xt');
function assert(ok, message) { if (!ok) throw new Error(`FAIL: ${message}`); }
function response(body) { return { ok: true, async json() { return body; } }; }

(async () => {
  const historyUrls = [];
  global.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/cg/contracts')) return response([
      { symbol: 'btc_usdt', base_currency: 'BTC', target_currency: 'USDT', underlyingType: 2, product_type: 'PERPETUAL', funding_rate: '0.0001', funding_interval_minutes: 480, next_funding_rate_timestamp: '1800000000000', last_price: '60000', open_interest_usd: '12000000', target_volume: '95000000' },
      { symbol: 'btc_usd', base_currency: 'BTC', target_currency: 'USD', underlyingType: 1, product_type: 'PERPETUAL', funding_rate: '0.0001', last_price: '60000' },
      { symbol: 'tsla_usdt', base_currency: 'TSLA', target_currency: 'USDT', underlyingType: 2, product_type: 'PERPETUAL', funding_rate: '0.0001', last_price: '300' },
    ]);
    if (u.includes('/q/funding-rate-record?')) {
      historyUrls.push(u);
      const query = new URL(u).searchParams;
      const id = query.get('id');
      const items = id
        ? [{ id: 9, fundingRate: '0.0003', createdTime: 2000 }, { id: 8, fundingRate: '-0.0001', createdTime: 1000 }]
        : Array.from({ length: 100 }, (_, i) => ({ id: 110 - i, fundingRate: '0.0002', createdTime: (110 - i) * 1000 }));
      return response({ returnCode: 0, result: { items, hasPrev: !id, hasNext: false } });
    }
    throw new Error(`Unexpected URL: ${u}`);
  };

  const rows = await xt.fetchCurrent();
  assert(rows.length === 1 && rows[0].symbol === 'BTC_USDT', 'select USDT-margined crypto perpetuals');
  assert(rows[0].fundingRate === 0.0001 && rows[0].intervalHours === 8, 'map funding and interval');
  assert(rows[0].nextFundingTime === 1800000000000 && rows[0].price === 60000, 'map next funding time and last price');
  assert(rows[0].openInterestUsd === 12000000 && rows[0].volume24hUsd === 95000000, 'use USD open interest and quote turnover');

  const history = await xt.fetchHistory('BTC_USDT', 120);
  assert(history.length === 102, 'paginate and deduplicate historical funding records');
  assert(history[0].time === 1000 && history[history.length - 1].time === 110000, 'return history in chronological order');
  assert(historyUrls.length === 2 && historyUrls[0].includes('symbol=btc_usdt') && historyUrls[1].includes('id=11'), 'paginate from the oldest record id');
  const { byId } = require('../lib/exchanges');
  assert(byId.get('xt') === xt, 'register XT.COM in scanner');
  console.log('ALL PASS');
})().catch((err) => { console.error(err); process.exit(1); });

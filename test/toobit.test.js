const assert = require('node:assert/strict');
const { byId } = require('../lib/exchanges');
const { splitSymbol } = require('../lib/metrics');
const { checkOrderBook, SPOT_VENUES } = require('../lib/orderBooks');

const symbol = '1000PEPE-SWAP-USDT';
const stock = 'AAPL-SWAP-USDT';
const hour = 60 * 60_000;
const now = Date.now();
const historyLimits = [];
const market = {
  symbol, status: 'TRADING', inverse: false, marginToken: 'USDT', quoteAsset: 'USDT',
  isRwa: false, contractMultiplier: '0.1',
};

global.fetch = async (input) => {
  const url = new URL(input);
  const pair = url.searchParams.get('symbol');
  assert.equal(url.origin, 'https://api.toobit.com');
  let body;
  switch (url.pathname) {
    case '/api/v1/exchangeInfo':
      body = { contracts: [market, { ...market, symbol: stock, isRwa: true }] };
      break;
    case '/api/v1/futures/fundingRate':
      body = [symbol, stock].map((name) => ({ symbol: name, rate: '0.0008', period: '8H', nextFundingTime: String(now + hour) }));
      break;
    case '/quote/v1/markPrice':
      body = [{ symbolId: symbol, price: '10' }];
      break;
    case '/quote/v1/contract/ticker/24hr':
      body = [{ si: symbol, c: '11', qv: '1234' }];
      break;
    case '/api/v1/futures/historyFundingRate': {
      assert.equal(pair, symbol);
      const limit = Number(url.searchParams.get('limit'));
      historyLimits.push(limit);
      body = Array.from({ length: Math.min(limit, 721) }, (_, i) => ({
        settleTime: String(now - (i + (i ? 7 : 0)) * hour),
        settleRate: i ? '0.0001' : '0.0008',
        period: i ? '1H' : '8H',
      }));
      break;
    }
    case '/quote/v1/openInterest':
      assert.equal(pair, symbol);
      body = { openInterestList: [{ symbol, size: '12.5' }] };
      break;
    case '/quote/v1/depth':
      assert.ok(pair === symbol || pair === 'PEPEUSDT');
      body = pair === symbol
        ? { b: [['10', '10'], ['8', '100']], a: [['11', '10']] }
        : { b: [['0.008', '2000']], a: [['0.009', '2000']] };
      break;
    default:
      throw new Error(`Unexpected request: ${url}`);
  }
  return { ok: true, status: 200, async json() { return body; } };
};

(async () => {
  const toobit = byId.get('toobit');
  const current = await toobit.fetchCurrent();
  assert.deepEqual(current, [{
    exchange: 'toobit', symbol, fundingRate: 0.0008, intervalHours: 8,
    nextFundingTime: now + hour, price: 10, volume24hUsd: 1234, openInterestUsd: null,
  }]);
  assert.deepEqual(splitSymbol('1000SATS-SWAP-USDT'), { base: 'SATS', multiplier: 1000 });
  assert.deepEqual(splitSymbol('1000SATSUSDT'), { base: '1000SATS', multiplier: 1 });
  const history = await toobit.fetchHistory(symbol, 92, 8);
  assert.deepEqual(historyLimits, [92, 1000]);
  assert.equal(history.length, 721);
  assert.deepEqual(history.at(-1), { time: now, rate: 0.0008, intervalHours: 8 });
  assert.equal(history[0].intervalHours, 1);
  assert.equal(await toobit.fetchOpenInterest(symbol, 10), 125);

  assert.ok(SPOT_VENUES.some((venue) => venue.id === 'toobit'));
  const book = await checkOrderBook({
    futuresExchange: 'toobit', futuresSymbol: symbol, spotExchangeId: 'toobit',
    base: 'PEPE', quote: 'USDT', sizeUsdt: 14,
  });
  assert.equal(book.baseQuantity, 1500);
  assert.equal(book.spotFilledQuantity, 1500);
  assert.ok(book.spotComplete && book.futuresComplete);
  console.log('ALL PASS');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

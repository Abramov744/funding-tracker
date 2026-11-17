const path = require('path');
const { checkOrderBook } = require(path.join(__dirname, '..', 'lib', 'orderBooks.js'));

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

function closeTo(actual, expected, message) {
  if (Math.abs(actual - expected) > 1e-9) {
    throw new Error(`FAIL: ${message}; got ${actual}, expected ${expected}`);
  }
}

function response(data) {
  return { ok: true, async json() { return data; } };
}

async function main() {
  let futuresBids = [['100', '1'], ['90', '1']];
  global.fetch = async (url) => {
    if (String(url).includes('/fapi/v1/depth')) {
      return response({ bids: futuresBids, asks: [['101', '1']] });
    }
    if (String(url).includes('/md/v2/orderbook')) {
      return response({
        error: null,
        result: { book: { bids: [['100', '1'], ['90', '1']], asks: [['101', '1']] } },
      });
    }
    if (String(url).includes('/api/v1/orderBookDetails')) {
      return response({
        code: 200,
        order_book_details: [{ market_id: 1, market_type: 'perp', status: 'active', symbol: 'BTC' }],
      });
    }
    if (String(url).includes('/api/v1/orderBookOrders')) {
      return response({
        code: 200,
        bids: [
          { price: '100', remaining_base_amount: '1' },
          { price: '90', remaining_base_amount: '1' },
        ],
        asks: [{ price: '101', remaining_base_amount: '1' }],
      });
    }
    if (String(url).includes('/api/v3/depth')) {
      return response({ bids: [['89', '1']], asks: [['90', '1'], ['99', '1']] });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const complete = await checkOrderBook({
    futuresExchange: 'aster',
    futuresSymbol: 'BTCUSDT',
    spotExchangeId: 'mexc',
    base: 'BTC',
    quote: 'USDT',
    sizeUsdt: 190,
  });

  closeTo(complete.baseQuantity, 2, 'spot buys the same base-asset quantity as the futures short');
  closeTo(complete.futuresAveragePrice, 95, 'short average uses bid-side fills');
  closeTo(complete.spotAveragePrice, 94.5, 'spot average uses ask-side fills');
  assert(complete.futuresComplete && complete.spotComplete, 'both books fully fill the requested trade');
  assert(complete.favorable, 'a lower, fully filled spot average is favorable');

  futuresBids = [['100', '1']];
  const partial = await checkOrderBook({
    futuresExchange: 'aster',
    futuresSymbol: 'BTCUSDT',
    spotExchangeId: 'mexc',
    base: 'BTC',
    quote: 'USDT',
    sizeUsdt: 190,
  });

  assert(!partial.futuresComplete, 'report an incomplete futures fill');
  assert(!partial.favorable, 'an incomplete futures fill must not be marked favorable');

  for (const futuresExchange of ['phemex', 'lighter']) {
    const result = await checkOrderBook({
      futuresExchange,
      futuresSymbol: futuresExchange === 'lighter' ? 'BTC' : 'BTCUSDT',
      spotExchangeId: 'mexc',
      base: 'BTC',
      quote: 'USDT',
      sizeUsdt: 190,
    });
    closeTo(result.futuresAveragePrice, 95, `${futuresExchange} short uses the returned bid depth`);
    assert(result.futuresComplete, `${futuresExchange} covers the requested short size`);
  }

  console.log('ALL PASS');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
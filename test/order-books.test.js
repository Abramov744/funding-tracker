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
        result: { orderbook_p: { bids: [['100', '1'], ['90', '1']], asks: [['101', '1']] } },
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
    if (String(url).includes('contract.mexc.com/api/v1/contract/depth/')) {
      return response({ data: { bids: [['100', '100'], ['90', '100']], asks: [['101', '100']] } });
    }
    if (String(url).includes('futures.ourbit.com/api/v1/contract/depth/')) {
      return response({ data: { bids: [['100', '100'], ['90', '100']], asks: [['101', '100']] } });
    }
    if (String(url).includes('contract.mexc.com/api/v1/contract/detail')) {
      return response({ data: [{ symbol: 'BTC_USDT', contractSize: 0.01 }] });
    }
    if (String(url).includes('futures.ourbit.com/api/v1/contract/detail')) {
      return response({ data: [{ symbol: 'BTC_USDT', contractSize: 0.01 }] });
    }
    if (String(url).includes('/api/v4/futures/usdt/order_book')) {
      return response({ bids: [{ p: '100', s: 100 }, { p: '90', s: 100 }], asks: [{ p: '101', s: 100 }] });
    }
    if (String(url).includes('/api/v4/futures/usdt/contracts/BTC_USDT')) {
      return response({ quanto_multiplier: 0.01 });
    }
    if (String(url).includes('api-futures.kucoin.com/api/v1/level2/snapshot')) {
      return response({ code: '200000', data: { bids: [['100', '100'], ['90', '100']], asks: [['101', '100']] } });
    }
    if (String(url).includes('api-futures.kucoin.com/api/v1/contracts/active')) {
      return response({ code: '200000', data: [{ symbol: 'XBTUSDTM', multiplier: 0.01 }] });
    }
    if (String(url).includes('/cfd/openApi/v1/pub/marketOrder')) {
      return response({ data: {
        bids: [{ price: '100', volume: '1' }, { price: '90', volume: '1' }],
        asks: [{ price: '101', volume: '1' }],
      } });
    }
    if (String(url).includes('/orderbooks/perpetualMarket/')) {
      return response({ bids: [{ price: '100', size: '1' }, { price: '90', size: '1' }], asks: [{ price: '101', size: '1' }] });
    }
    if (String(url).includes('api.ourbit.com/api/v3/depth')) {
      return response({ bids: [['89', '1']], asks: [['90', '1'], ['99', '1']] });
    }
    if (String(url).includes('sapi.asterdex.com/api/v3/depth')) {
      return response({ bids: [['89', '1']], asks: [['90', '1'], ['99', '1']] });
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

  const asterSpot = await checkOrderBook({
    futuresExchange: 'aster',
    futuresSymbol: 'BTCUSDT',
    spotExchangeId: 'aster',
    base: 'BTC',
    quote: 'USDT',
    sizeUsdt: 190,
  });
  closeTo(asterSpot.spotAveragePrice, 90, 'Aster spot uses ask-side depth');
  assert(asterSpot.spotComplete, 'Aster spot covers the requested buy size');

  const mexcSpot = await checkOrderBook({
    futuresExchange: 'aster',
    futuresSymbol: 'BTCUSDT',
    spotExchangeId: 'mxc',
    base: 'BTC',
    quote: 'USDT',
    sizeUsdt: 190,
  });
  closeTo(mexcSpot.spotAveragePrice, 90, 'MEXC spot alias uses ask-side depth');
  assert(mexcSpot.spotComplete, 'MEXC spot alias covers the requested buy size');

  const ourbitSpot = await checkOrderBook({
    futuresExchange: 'aster',
    futuresSymbol: 'BTCUSDT',
    spotExchangeId: 'ourbit',
    base: 'BTC',
    quote: 'USDT',
    sizeUsdt: 190,
  });
  closeTo(ourbitSpot.spotAveragePrice, 90, 'Ourbit spot uses ask-side depth');
  assert(ourbitSpot.spotComplete, 'Ourbit spot covers the requested buy size');

  for (const [futuresExchange, futuresSymbol] of [
    ['phemex', 'BTCUSDT'], ['lighter', 'BTC'], ['gate', 'BTC_USDT'],
    ['kucoin', 'XBTUSDTM'], ['lbank', 'BTCUSDT'], ['dydx', 'BTC-USD'],
  ]) {
    const result = await checkOrderBook({
      futuresExchange,
      futuresSymbol,
      spotExchangeId: 'mexc',
      base: 'BTC',
      quote: 'USDT',
      sizeUsdt: 190,
    });
    closeTo(result.futuresAveragePrice, 95, `${futuresExchange} short uses the returned bid depth`);
    assert(result.futuresComplete, `${futuresExchange} covers the requested short size`);
  }

  for (const futuresExchange of ['mexc', 'ourbit']) {
    const result = await checkOrderBook({
      futuresExchange,
      futuresSymbol: 'BTC_USDT',
      spotExchangeId: 'mexc',
      base: 'BTC',
      quote: 'USDT',
      sizeUsdt: 190,
    });
    closeTo(result.baseQuantity, 2, `${futuresExchange} converts contract volume into BTC`);
    closeTo(result.futuresAveragePrice, 95, `${futuresExchange} leaves BTC prices unscaled`);
    assert(result.futuresComplete, `${futuresExchange} covers the requested short size`);
  }

  console.log('ALL PASS');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
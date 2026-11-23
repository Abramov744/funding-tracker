const path = require('path');
const { checkOrderBook, getSpotVenuePrices } = require(path.join(__dirname, '..', 'lib', 'orderBooks.js'));

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
  let paradexUrl = '';
  let pacificaUrl = '';
  let orderlyUrl = '';
  let blofinFuturesUrl = '';
  let blofinSpotUrl = '';
  global.fetch = async (url) => {
    if (String(url).includes('/api/v1/spot/market/books?instType=SPOT')) {
      blofinSpotUrl = String(url);
      return response({ code: '0', data: [{ bids: [['89', '1']], asks: [['90', '1'], ['99', '1']] }] });
    }
    if (String(url).includes('/api/v1/market/books?instId=')) {
      blofinFuturesUrl = String(url);
      return response({ code: '0', data: [{ bids: [['100', '100'], ['90', '100']], asks: [['101', '100']] }] });
    }
    if (String(url).includes('/api/v1/market/instruments?instId=')) {
      return response({ code: '0', data: [{ instId: 'BTC-USDT', contractType: 'linear', quoteCurrency: 'USDT', contractValue: '0.01' }] });
    }
    if (String(url).includes('/api/v1/book?symbol=')) {
      pacificaUrl = String(url);
      return response({
        success: true,
        data: {
          s: 'BTC',
          l: [
            [{ p: '100', a: '1', n: 1 }, { p: '90', a: '1', n: 1 }],
            [{ p: '101', a: '2', n: 1 }],
          ],
          t: 1795435200000,
        },
        error: null,
        code: null,
      });
    }
    if (String(url).includes('api.prod.paradex.trade/v1/orderbook/')) {
      paradexUrl = String(url);
      return response({
        market: 'BTC-USD-PERP',
        last_updated_at: 1795435200000,
        seq_no: 123,
        bids: [['100', '1'], ['90', '1']],
        asks: [['101', '1']],
      });
    }
    if (String(url).includes('api.orderly.org/v1/orderbook/')) {
      orderlyUrl = String(url);
      return response({
        success: true,
        data: { symbol: 'PERP_BTC_USDC', bids: [['100', '1'], ['90', '1']], asks: [['101', '1']] },
      });
    }
    if (String(url).includes('/metadata/v2/stats')) {
      return response({ listings: [{
        ticker: 'BTC-PERP',
        contract_type: 'perpetual',
        quotes: {
          updated_at: '2026-11-23T10:00:00Z',
          size_1k: { bid: '99', ask: '101' },
          size_100k: { bid: '97', ask: '103' },
          size_1m: { bid: '95', ask: '105' },
        },
      }] });
    }
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
    if (String(url).includes('/api/v2/public/meta/getMetaData')) {
      return response({ code: 'SUCCESS', data: { contractList: [{ contractId: '30000001', contractName: 'BTCUSDC', enableTrade: true }] } });
    }
    if (String(url).includes('/api/v2/public/quote/getDepth')) {
      return response({ code: 'SUCCESS', data: [{ bids: [{ price: '100', size: '1' }, { price: '90', size: '1' }], asks: [{ price: '101', size: '1' }] }] });
    }
    if (String(url).includes('/api/v1/info/markets/BTC-USD/orderbook')) {
      return response({ status: 'OK', data: {
        market: 'BTC-USD',
        bid: [{ price: '100', qty: '1' }, { price: '90', qty: '1' }],
        ask: [{ price: '101', qty: '1' }],
      } });
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
    ['edgex', 'BTCUSDC'], ['extended', 'BTC-USD'],
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

  const directVenues = await getSpotVenuePrices('BTC');
  assert(directVenues.length > 0, 'direct spot venue aggregation returns at least one venue');
  for (let i = 1; i < directVenues.length; i += 1) {
    assert(directVenues[i - 1].price <= directVenues[i].price, 'direct spot venues are sorted by price');
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

  const variational = await checkOrderBook({
    futuresExchange: 'variational',
    futuresSymbol: 'BTC-PERP',
    spotExchangeId: 'mexc',
    base: 'BTC',
    quote: 'USDT',
    sizeUsdt: 5_000,
  });
  closeTo(variational.futuresAveragePrice, 97, 'Variational selects the quote tier covering the requested size');
  assert(variational.futuresComplete, 'Variational indicative quote covers the requested short size');
  assert(variational.futuresPricingMode === 'indicative-rfq', 'Variational quote is identified as indicative RFQ pricing');
  assert(variational.futuresQuoteTier === 'size_100k', 'Variational response records the selected size tier');
  assert(variational.futuresQuoteUpdatedAt === '2026-11-23T10:00:00Z', 'Variational response keeps quote freshness metadata');

  let unsupportedVariationalSize = false;
  try {
    await checkOrderBook({
      futuresExchange: 'variational',
      futuresSymbol: 'BTC-PERP',
      spotExchangeId: 'mexc',
      base: 'BTC',
      quote: 'USDT',
      sizeUsdt: 2_000_000,
    });
  } catch (err) {
    unsupportedVariationalSize = /котировку подходящего размера/.test(err.message);
  }
  assert(unsupportedVariationalSize, 'Variational rejects amounts larger than its published quote tiers');

  const paradex = await checkOrderBook({
    futuresExchange: 'paradex',
    futuresSymbol: 'BTC-USD-PERP',
    spotExchangeId: 'mexc',
    base: 'BTC',
    quote: 'USDT',
    sizeUsdt: 190,
  });
  closeTo(paradex.futuresAveragePrice, 95, 'Paradex parses public bid levels and calculates the short average');
  assert(paradex.futuresComplete, 'Paradex book covers the requested short size');
  assert(paradexUrl.includes('/v1/orderbook/BTC-USD-PERP?depth=100'), 'Paradex requests the public orderbook snapshot with depth');

  const pacifica = await checkOrderBook({
    futuresExchange: 'pacifica',
    futuresSymbol: 'BTC',
    spotExchangeId: 'mexc',
    base: 'BTC',
    quote: 'USDT',
    sizeUsdt: 190,
  });
  closeTo(pacifica.futuresAveragePrice, 95, 'Pacifica maps its p/a fields to price and size for the short average');
  assert(pacifica.futuresComplete, 'Pacifica book covers the requested short size');
  assert(pacificaUrl.includes('/api/v1/book?symbol=BTC'), 'Pacifica requests the public book endpoint using its bare ticker');

  const orderly = await checkOrderBook({
    futuresExchange: 'orderly',
    futuresSymbol: 'BTC',
    spotExchangeId: 'mexc',
    base: 'BTC',
    quote: 'USDT',
    sizeUsdt: 190,
  });
  closeTo(orderly.futuresAveragePrice, 95, 'Orderly parses public bid levels and calculates the short average');
  assert(orderly.futuresComplete, 'Orderly book covers the requested short size');
  assert(orderlyUrl.includes('/v1/orderbook/PERP_BTC_USDC?max_level=100'), 'Orderly requests the public orderbook snapshot using its full perpetual symbol');

  const blofinBook = await checkOrderBook({
    futuresExchange: 'blofin',
    futuresSymbol: 'BTC-USDT',
    spotExchangeId: 'blofin',
    base: 'BTC',
    quote: 'USDT',
    sizeUsdt: 190,
  });
  closeTo(blofinBook.baseQuantity, 2, 'BloFin converts linear futures contract counts into base-asset quantity');
  closeTo(blofinBook.futuresAveragePrice, 95, 'BloFin computes the futures short average from bids');
  closeTo(blofinBook.spotAveragePrice, 94.5, 'BloFin parses spot asks and computes the average purchase price');
  assert(blofinBook.futuresComplete && blofinBook.spotComplete, 'BloFin books fully cover the requested amount');
  assert(blofinFuturesUrl.includes('/market/books?instId=BTC-USDT&size=100'), 'BloFin futures check requests 100 book levels');
  assert(blofinSpotUrl.includes('/spot/market/books?instType=SPOT&instId=BTC-USDT&size=100'), 'BloFin spot check requests public spot depth');

  console.log('ALL PASS');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

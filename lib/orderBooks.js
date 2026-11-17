// Public order books used only on demand by the funding popup. We keep this
// allowlisted rather than accepting arbitrary URLs from the browser.
const { splitSymbol } = require('./metrics');

const USER_AGENT = { 'User-Agent': 'funding-tracker/1.0' };
const STABLE_QUOTES = new Set(['USDT', 'USDC', 'USD']);

async function requestJson(url, options = {}) {
  const res = await fetch(url, { headers: { ...USER_AGENT, ...(options.headers || {}) }, ...options });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function level(price, quantity) {
  const p = Number(price);
  const q = Number(quantity);
  return Number.isFinite(p) && p > 0 && Number.isFinite(q) && q > 0 ? { price: p, quantity: q } : null;
}

function normalizeLevels(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    if (Array.isArray(row)) return level(row[0], row[1]);
    if (!row || typeof row !== 'object') return null;
    return level(row.price ?? row.p ?? row.px, row.size ?? row.amount ?? row.remaining_base_amount ?? row.vol ?? row.v ?? row.qty ?? row.sz);
  }).filter(Boolean);
}

function envelopeRows(body, exchange) {
  if (exchange === 'bybit') {
    if (body.retCode !== 0) throw new Error(`Bybit ${body.retCode}: ${body.retMsg || 'API error'}`);
    const result = body.result || {};
    return { bids: result.b || [], asks: result.a || [] };
  }
  if (exchange === 'okx') {
    if (body.code !== '0') throw new Error(`OKX ${body.code}: ${body.msg || 'API error'}`);
    const book = (body.data || [])[0] || {};
    return { bids: book.bids || [], asks: book.asks || [] };
  }
  if (exchange === 'gate' || exchange === 'mexc' || exchange === 'ourbit') {
    if (body.success === false) throw new Error(`${exchange} API error: ${body.code || ''}`);
    const data = body.data || body;
    return { bids: data.bids || data.bid || [], asks: data.asks || data.ask || [] };
  }
  if (exchange === 'kucoin') {
    if (body.code !== '200000') throw new Error(`KuCoin ${body.code}: API error`);
    const data = body.data || {};
    return { bids: data.bids || [], asks: data.asks || [] };
  }
  if (exchange === 'bitget') {
    if (body.code !== '00000') throw new Error(`Bitget ${body.code}: ${body.msg || 'API error'}`);
    const data = body.data || {};
    return { bids: data.bids || [], asks: data.asks || [] };
  }
  if (exchange === 'bingx') {
    if (body.code !== 0) throw new Error(`BingX ${body.code}: ${body.msg || 'API error'}`);
    const data = body.data || {};
    return { bids: data.bids || [], asks: data.asks || [] };
  }
  if (exchange === 'htx') {
    if (body.status !== 'ok') throw new Error(`HTX ${body.err_code || ''}: ${body.err_msg || 'API error'}`);
    const tick = (body.tick || body.data?.tick || {});
    return { bids: tick.bids || [], asks: tick.asks || [] };
  }
  if (exchange === 'lbank') {
    if (body.success === false || (body.error_code !== undefined && Number(body.error_code) !== 0)) {
      throw new Error(`LBank ${body.error_code}: ${body.msg || 'API error'}`);
    }
    const data = body.data || {};
    return { bids: data.bids || [], asks: data.asks || [] };
  }
  if (exchange === 'aster') {
    return { bids: body.bids || [], asks: body.asks || [] };
  }
  if (exchange === 'bitfinex') {
    // Bitfinex's amount sign distinguishes sides; rows are [price, count, amount].
    return {
      bids: (Array.isArray(body) ? body : []).filter((r) => Number(r[2]) > 0).map((r) => [r[0], Math.abs(r[2])]),
      asks: (Array.isArray(body) ? body : []).filter((r) => Number(r[2]) < 0).map((r) => [r[0], Math.abs(r[2])]),
    };
  }
  if (exchange === 'hyperliquid') {
    const [bids = [], asks = []] = body.levels || [];
    return { bids: bids.map((r) => [r.px, r.sz]), asks: asks.map((r) => [r.px, r.sz]) };
  }
  if (exchange === 'phemex') {
    if (body.error) throw new Error(`Phemex: ${JSON.stringify(body.error)}`);
    const book = (body.result || {}).book || {};
    return { bids: book.bids || [], asks: book.asks || [] };
  }
  if (exchange === 'lighter') {
    if (body.code !== 200) throw new Error(`Lighter ${body.code}: ${body.message || 'API error'}`);
    return { bids: body.bids || [], asks: body.asks || [] };
  }
  if (exchange === 'dydx') {
    return { bids: body.bids || [], asks: body.asks || [] };
  }
  if (exchange === 'coinbase') {
    return { bids: body.bids || [], asks: body.asks || [] };
  }
  if (exchange === 'kraken') {
    if (body.error && body.error.length) throw new Error(`Kraken: ${body.error.join(', ')}`);
    const data = Object.values(body.result || {})[0] || {};
    return { bids: data.bids || [], asks: data.asks || [] };
  }
  if (exchange === 'bitstamp') {
    return { bids: body.bids || [], asks: body.asks || [] };
  }
  throw new Error('Формат стакана этой биржи пока не поддерживается.');
}

async function getSpotBook(exchangeId, base, quote) {
  const pair = `${base}${quote}`;
  const dashed = `${base}-${quote}`;
  const underscored = `${base}_${quote}`;
  let url;
  let exchange;

  switch (String(exchangeId).toLowerCase()) {
    case 'binance': case 'binance_us':
      exchange = 'aster';
      url = `https://api.binance.com/api/v3/depth?symbol=${pair}&limit=1000`;
      break;
    case 'bybit':
      exchange = 'bybit';
      url = `https://api.bybit.com/v5/market/orderbook?category=spot&symbol=${pair}&limit=200`;
      break;
    case 'okx':
      exchange = 'okx';
      url = `https://www.okx.com/api/v5/market/books?instId=${dashed}&sz=400`;
      break;
    case 'gate': case 'gateio':
      exchange = 'gate';
      url = `https://api.gateio.ws/api/v4/spot/order_book?currency_pair=${underscored}&limit=100`;
      break;
    case 'bitget':
      exchange = 'bitget';
      url = `https://api.bitget.com/api/v2/spot/market/orderbook?symbol=${pair}&type=step0`;
      break;
    case 'mexc':
      exchange = 'mexc';
      url = `https://api.mexc.com/api/v3/depth?symbol=${pair}&limit=1000`;
      break;
    case 'kucoin': case 'kucoin_spot':
      exchange = 'kucoin';
      url = `https://api.kucoin.com/api/v3/market/orderbook/level2_100?symbol=${dashed}`;
      break;
    case 'bingx':
      exchange = 'bingx';
      url = `https://open-api.bingx.com/openApi/spot/v1/market/depth?symbol=${dashed}&limit=100`;
      break;
    case 'htx': case 'huobi':
      exchange = 'htx';
      url = `https://api.huobi.pro/market/depth?symbol=${pair.toLowerCase()}&type=step0`;
      break;
    case 'lbank':
      exchange = 'lbank';
      url = `https://api.lbkex.com/v2/depth.do?symbol=${underscored.toLowerCase()}&size=100`;
      break;
    case 'coinbase': case 'coinbase_exchange':
      exchange = 'coinbase';
      url = `https://api.exchange.coinbase.com/products/${dashed}/book?level=2`;
      break;
    case 'kraken':
      exchange = 'kraken';
      url = `https://api.kraken.com/0/public/Depth?pair=${pair}&count=500`;
      break;
    case 'bitstamp':
      exchange = 'bitstamp';
      url = `https://www.bitstamp.net/api/v2/order_book/${base.toLowerCase()}${quote.toLowerCase()}/`;
      break;
    case 'bitfinex': case 'bitfinex_spot': {
      exchange = 'bitfinex';
      const bfBase = base === 'BTC' ? 'XBT' : base;
      const bfQuote = quote === 'USDT' ? 'UST' : quote;
      url = `https://api-pub.bitfinex.com/v2/book/t${bfBase}${bfQuote}/P0?len=100`;
      break;
    }
    default:
      throw new Error(`На спотовой бирже «${exchangeId}» проверка стакана пока не поддерживается.`);
  }

  const body = await requestJson(url);
  const sides = envelopeRows(body, exchange);
  return { bids: normalizeLevels(sides.bids), asks: normalizeLevels(sides.asks), basePerUnit: 1 };
}

async function fetchFuturesBook(exchange, symbol) {
  const encoded = encodeURIComponent(symbol);
  const baseMultiplier = splitSymbol(symbol).multiplier || 1;
  let exchangeForEnvelope = exchange;
  let url;
  let method = 'GET';
  let body;
  let contractMultiplier = 1;

  switch (exchange) {
    case 'aster':
      exchangeForEnvelope = 'aster';
      url = `https://fapi.asterdex.com/fapi/v1/depth?symbol=${encoded}&limit=1000`;
      break;
    case 'bybit':
      url = `https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${encoded}&limit=200`;
      break;
    case 'okx':
      url = `https://www.okx.com/api/v5/market/books?instId=${encoded}&sz=400`;
      break;
    case 'gate': {
      const [book, contract] = await Promise.all([
        requestJson(`https://api.gateio.ws/api/v4/futures/usdt/order_book?contract=${encoded}&limit=100`),
        requestJson(`https://api.gateio.ws/api/v4/futures/usdt/contracts/${encoded}`),
      ]);
      contractMultiplier = Number(contract.quanto_multiplier) || 1;
      const sides = envelopeRows({ data: book }, 'gate');
      return { bids: normalizeLevels(sides.bids), asks: normalizeLevels(sides.asks), basePerUnit: contractMultiplier * baseMultiplier };
    }
    case 'mexc': case 'ourbit': {
      const baseUrl = exchange === 'mexc' ? 'https://contract.mexc.com' : 'https://futures.ourbit.com';
      const [bookBody, detailBody] = await Promise.all([
        requestJson(`${baseUrl}/api/v1/contract/depth/${encoded}?limit=100`),
        requestJson(`${baseUrl}/api/v1/contract/detail`),
      ]);
      const book = bookBody.data || bookBody;
      const contracts = detailBody.data || [];
      const contract = contracts.find((c) => c.symbol === symbol);
      contractMultiplier = Number(contract && contract.contractSize) || 1;
      const sides = envelopeRows({ data: book }, exchange);
      return { bids: normalizeLevels(sides.bids), asks: normalizeLevels(sides.asks), basePerUnit: contractMultiplier * baseMultiplier };
    }
    case 'kucoin': {
      const [bookBody, contractsBody] = await Promise.all([
        requestJson(`https://api-futures.kucoin.com/api/v1/level2_100?symbol=${encoded}`),
        requestJson('https://api-futures.kucoin.com/api/v1/contracts/active'),
      ]);
      const contract = (contractsBody.data || []).find((c) => c.symbol === symbol);
      contractMultiplier = Math.abs(Number(contract && contract.multiplier)) || 1;
      const sides = envelopeRows(bookBody, 'kucoin');
      return { bids: normalizeLevels(sides.bids), asks: normalizeLevels(sides.asks), basePerUnit: contractMultiplier * baseMultiplier };
    }
    case 'bingx':
      url = `https://open-api.bingx.com/openApi/swap/v2/quote/depth?symbol=${encodeURIComponent(symbol.replace('_', '-'))}&limit=100`;
      break;
    case 'bitget':
      url = `https://api.bitget.com/api/v2/mix/market/merge-depth?symbol=${encoded}&productType=USDT-FUTURES&limit=100`;
      break;
    case 'phemex':
      exchangeForEnvelope = 'phemex';
      url = `https://api.phemex.com/md/v2/orderbook?symbol=${encoded}`;
      break;
    case 'bitfinex': {
      const rawBase = String(symbol).replace(/USDT$|USD$/, '').replace(/^XBT$/, 'BTC');
      url = `https://api-pub.bitfinex.com/v2/book/t${rawBase}F0:USTF0/P0?len=100`;
      break;
    }
    case 'htx': {
      const match = String(symbol).match(/^(.+?)[-_](USDT|USD)$/i);
      if (!match) throw new Error('Не удалось распознать контракт HTX.');
      url = `https://api.hbdm.com/linear-swap-ex/market/depth?contract_code=${match[1]}-${match[2]}&type=step0`;
      break;
    }
    case 'lbank':
      url = `https://lbkperp.lbank.com/cfd/openApi/v1/pub/marketOrder?productGroup=SwapU&symbol=${encoded}&depth=100`;
      break;
    case 'hyperliquid':
      exchangeForEnvelope = 'hyperliquid';
      method = 'POST';
      url = 'https://api.hyperliquid.xyz/info';
      body = JSON.stringify({ type: 'l2Book', coin: symbol });
      break;
    case 'dydx':
      exchangeForEnvelope = 'dydx';
      url = `https://indexer.dydx.trade/v4/orderbook/perpetualMarket/${encoded}`;
      break;
    case 'lighter': {
      const details = await requestJson('https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails');
      if (details.code !== 200) throw new Error(`Lighter ${details.code}: ${details.message || 'API error'}`);
      const market = (details.order_book_details || []).find(
        (item) => item.symbol === symbol && item.market_type === 'perp' && item.status === 'active'
      );
      if (!market) throw new Error(`Lighter: активный perpetual-рынок ${symbol} не найден.`);
      url = `https://mainnet.zklighter.elliot.ai/api/v1/orderBookOrders?market_id=${encodeURIComponent(market.market_id)}&limit=250`;
      break;
    }
    default:
      throw new Error(`На фьючерсной бирже «${exchange}» публичный стакан пока не подключён.`);
  }

  const response = await requestJson(url, method === 'POST'
    ? { method, headers: { 'Content-Type': 'application/json' }, body }
    : {});
  const sides = envelopeRows(response, exchangeForEnvelope);
  if (!sides.bids.length || !sides.asks.length) throw new Error('Биржа вернула пустой стакан.');
  return {
    bids: normalizeLevels(sides.bids),
    asks: normalizeLevels(sides.asks),
    // Binance-family markets quote a bulk ticker at a multiplied price and
    // book quantity in contract units. Convert back to the underlying coin.
    basePerUnit: contractMultiplier * baseMultiplier,
  };
}

function walkQuote(levels, targetQuote) {
  let remaining = targetQuote;
  let quantity = 0;
  let quote = 0;
  for (const item of levels) {
    const take = Math.min(item.quantity, remaining / item.price);
    if (take <= 0) continue;
    quantity += take;
    quote += take * item.price;
    remaining -= take * item.price;
    if (remaining <= Math.max(1e-8, targetQuote * 1e-10)) break;
  }
  return { quantity, quote, averagePrice: quantity > 0 ? quote / quantity : null, complete: remaining <= Math.max(1e-8, targetQuote * 1e-10) };
}

function walkBase(levels, targetBase) {
  let remaining = targetBase;
  let quantity = 0;
  let quote = 0;
  for (const item of levels) {
    const take = Math.min(item.quantity, remaining);
    if (take <= 0) continue;
    quantity += take;
    quote += take * item.price;
    remaining -= take;
    if (remaining <= Math.max(1e-12, targetBase * 1e-10)) break;
  }
  return { quantity, quote, averagePrice: quantity > 0 ? quote / quantity : null, complete: remaining <= Math.max(1e-12, targetBase * 1e-10) };
}

async function checkOrderBook({ futuresExchange, futuresSymbol, spotExchangeId, base, quote, sizeUsdt }) {
  const amount = Number(sizeUsdt);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e9) throw new Error('Введите размер позиции от 0 до 1 000 000 000 USDT.');
  const cleanBase = String(base || '').toUpperCase();
  const cleanQuote = String(quote || '').toUpperCase();
  if (!/^[A-Z0-9]{1,20}$/.test(cleanBase) || !STABLE_QUOTES.has(cleanQuote)) {
    throw new Error('Для расчёта нужна спотовая пара с котируемой валютой USDT, USDC или USD.');
  }

  const [futureBook, spotBook] = await Promise.all([
    fetchFuturesBook(futuresExchange, futuresSymbol),
    getSpotBook(spotExchangeId, cleanBase, cleanQuote),
  ]);
  const shortBids = futureBook.bids
    .map((l) => ({ price: l.price / futureBook.basePerUnit, quantity: l.quantity * futureBook.basePerUnit }))
    .filter((l) => l.price > 0 && l.quantity > 0)
    .sort((a, b) => b.price - a.price);
  const spotAsks = spotBook.asks
    .map((l) => ({ price: l.price / spotBook.basePerUnit, quantity: l.quantity * spotBook.basePerUnit }))
    .filter((l) => l.price > 0 && l.quantity > 0)
    .sort((a, b) => a.price - b.price);

  if (!shortBids.length || !spotAsks.length) throw new Error('Не удалось получить необходимые стороны стакана.');
  const short = walkQuote(shortBids, amount);
  if (!short.quantity) throw new Error('Во фьючерсном стакане нет доступного объёма на продажу.');
  const spot = walkBase(spotAsks, short.quantity);

  return {
    sizeUsdt: amount,
    futuresExchange,
    futuresSymbol,
    spotExchangeId,
    spotBase: cleanBase,
    spotQuote: cleanQuote,
    baseQuantity: short.quantity,
    futuresFilledUsdt: short.quote,
    futuresComplete: short.complete,
    futuresAveragePrice: short.averagePrice,
    spotFilledQuantity: spot.quantity,
    spotAveragePrice: spot.averagePrice,
    spotComplete: spot.complete,
    spotNotional: spot.quote,
    favorable: short.complete && spot.complete && spot.averagePrice < short.averagePrice,
    checkedAt: Date.now(),
  };
}

module.exports = { checkOrderBook };

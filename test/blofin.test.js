// No-network tests for BloFin's public linear-perpetual market data.
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

const blofin = require(path.join(__dirname, '..', 'lib', 'exchanges', 'blofin.js'));

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

function response(data) {
  return { ok: true, async json() { return { code: '0', msg: 'success', data }; } };
}

(async () => {
  const now = Date.now();
  const instruments = [
    { instId: 'BTC-USDT', baseCurrency: 'BTC', quoteCurrency: 'USDT', settleCurrency: 'USDT', contractValue: '0.001', contractType: 'linear', instType: 'SWAP', state: 'live', assetClass: 'Crypto' },
    { instId: 'BTC-USDC', baseCurrency: 'BTC', quoteCurrency: 'USDC', settleCurrency: 'USDC', contractValue: '0.0001', contractType: 'linear', instType: 'SWAP', state: 'live', assetClass: 'Crypto' },
    { instId: 'BTC-USD', baseCurrency: 'BTC', quoteCurrency: 'USD', settleCurrency: 'BTC', contractValue: '1', contractType: 'inverse', instType: 'SWAP', state: 'live', assetClass: 'Crypto' },
    { instId: 'TSLA-USDT', baseCurrency: 'TSLA', quoteCurrency: 'USDT', settleCurrency: 'USDT', contractValue: '1', contractType: 'linear', instType: 'SWAP', state: 'live', assetClass: 'Stocks' },
  ];
  let historyRequests = 0;
  let pagedHistoryRequests = 0;

  global.fetch = async (url) => {
    const value = String(url);
    if (value.includes('/market/instruments?apiPermission=full')) return response(instruments);
    if (value.endsWith('/market/tickers')) return response([
      { instId: 'BTC-USDT', last: '100000', volCurrency24h: '2' },
      { instId: 'BTC-USDC', last: '100100', volCurrency24h: '3' },
      { instId: 'TSLA-USDT', last: '300', volCurrency24h: '100' },
    ]);
    if (value.endsWith('/market/mark-price')) return response([
      { instId: 'BTC-USDT', markPrice: '99900' },
      { instId: 'BTC-USDC', markPrice: '100000' },
      { instId: 'TSLA-USDT', markPrice: '300' },
    ]);
    if (value.endsWith('/market/funding-rate')) return response([
      { instId: 'BTC-USDT', fundingRate: '0.0005', fundingTime: String(now + 60_000), fundingInterval: '8', fundingIntervalUnit: 'hour' },
      { instId: 'BTC-USDC', fundingRate: '-0.0001', fundingTime: String(now + 30_000), fundingInterval: '240', fundingIntervalUnit: 'minute' },
      { instId: 'TSLA-USDT', fundingRate: '0.001', fundingTime: String(now + 60_000), fundingInterval: '8', fundingIntervalUnit: 'hour' },
    ]);
    if (value.includes('/market/funding-rate-history')) {
      if (value.includes('instId=BTC-USDC')) {
        pagedHistoryRequests += 1;
        if (!value.includes('&after=')) {
          return response(Array.from({ length: 100 }, (_, index) => ({
            instId: 'BTC-USDC', fundingRate: '0.0001', fundingTime: String(now - index * 1_000), fundingKind: '0',
          })));
        }
        return response([{ instId: 'BTC-USDC', fundingRate: '0.0002', fundingTime: String(now - 100_000), fundingKind: '0' }]);
      }
      historyRequests += 1;
      return response([
        { instId: 'BTC-USDT', fundingRate: '0.0002', fundingTime: String(now - 10_000), fundingKind: '0' },
        { instId: 'BTC-USDT', fundingRate: '0.0003', fundingTime: String(now - 20_000), fundingKind: '0' },
        { instId: 'BTC-USDT', fundingRate: '0.5', fundingTime: String(now - 5_000), fundingKind: '1' },
      ]);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const current = await blofin.fetchCurrent();
  assert(current.length === 2, 'include supported BTC linear USDT and USDC markets; exclude inverse and stocks');
  const usdt = current.find((row) => row.symbol === 'BTC-USDT');
  const usdc = current.find((row) => row.symbol === 'BTC-USDC');
  assert(usdt && usdc, 'keep distinct quote-currency symbols for independent scanner rows');
  assert(usdt.fundingRate === 0.0005 && usdt.intervalHours === 8, 'read current funding rate and hourly interval');
  assert(usdc.fundingRate === -0.0001 && usdc.intervalHours === 4, 'convert minute-based funding interval to hours');
  assert(usdt.price === 99900 && usdt.nextFundingTime === now + 60_000, 'read mark price and next settlement time');
  assert(usdt.openInterestUsd === null, 'leave unsupported public open interest empty');
  assert(usdt.volume24hUsd === 199800, 'convert base-denominated volume to USDT notional');
  assert(blofin.getContractValue('BTC-USDT') === 0.001, 'cache linear contract multiplier for order-book sizing');

  const history = await blofin.fetchHistory('BTC-USDT', 90);
  assert(history.length === 2, 'filter non-funding dividend entries from funding history');
  assert(history[0].rate === 0.0003 && history[0].time === now - 20_000, 'sort funding settlements oldest first');
  await blofin.fetchHistory('BTC-USDT', 90);
  assert(historyRequests === 1, 'reuse the short-lived history cache');

  const paged = await blofin.fetchHistory('BTC-USDC', 101);
  assert(paged.length === 101 && paged[0].time === now - 100_000, 'page through older funding settlements to fill the requested history window');
  assert(pagedHistoryRequests === 2, 'fetch the next history page when the first page reaches 100 rows');
  console.log('ALL PASS');
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

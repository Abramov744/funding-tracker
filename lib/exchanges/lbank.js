// LBank USDT-margined perpetuals. Public market data; no API key is needed.
// Docs: https://www.lbank.com/docs/contract.html
const { filterToCrypto } = require('../cryptoassets');
const fundingHistory = require('../fundingHistory');

const BASE = 'https://lbkperp.lbank.com/cfd/openApi/v1/pub';
const PRODUCT_GROUP = 'SwapU';
const DEFAULT_INTERVAL_HOURS = 8;

async function getJson(path) {
  const url = `${BASE}${path}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'funding-tracker/1.0' } });
  if (!res.ok) throw new Error(`LBank ${path} -> HTTP ${res.status}`);
  const body = await res.json();
  if (body.success === false || (body.error_code !== undefined && Number(body.error_code) !== 0)) {
    throw new Error(`LBank ${path} -> ${body.error_code} ${body.msg || ''}`);
  }
  return body.data;
}

// LBank's public contract API exposes current market data but no historical
// funding or open-interest endpoint. Record each rate before the settlement;
// fundingHistory turns it into a settled point once nextFeeTime advances.
async function fetchCurrent() {
  const [instruments, markets] = await Promise.all([
    getJson(`/instrument?productGroup=${PRODUCT_GROUP}`),
    getJson(`/marketData?productGroup=${PRODUCT_GROUP}`),
  ]);
  if (!Array.isArray(instruments) || !Array.isArray(markets)) {
    throw new Error('LBank: unexpected contract market data response');
  }

  const instrumentBySymbol = new Map(
    instruments
      .filter((item) => item && item.priceCurrency === 'USDT' && item.clearCurrency === 'USDT')
      .map((item) => [item.symbol, item])
  );
  const eligible = markets
    .map((market) => ({ market, instrument: instrumentBySymbol.get(market && market.symbol) }))
    .filter(({ market, instrument }) => instrument && market && Number(market.markedPrice || market.lastPrice) > 0);

  const crypto = filterToCrypto(eligible, {
    exchange: 'lbank',
    symbolOf: ({ instrument }) => instrument.baseCurrency,
    priceOf: ({ market }) => Number(market.markedPrice || market.lastPrice),
  });

  const rows = crypto.map(({ market, instrument }) => {
    const fundingRate = Number(market.fundingRate ?? market.positionFeeRate ?? market.prePositionFeeRate);
    const intervalSeconds = Number(market.positionFeeTime);
    const intervalHours = Number.isFinite(intervalSeconds) && intervalSeconds > 0
      ? intervalSeconds / 3600
      : DEFAULT_INTERVAL_HOURS;
    const rawNextFundingTime = Number(market.nextFeeTime);
    const nextFundingTime = Number.isFinite(rawNextFundingTime) && rawNextFundingTime > 0
      ? rawNextFundingTime
      : null;
    const price = Number(market.markedPrice || market.lastPrice) || null;
    const turnover = Number(market.turnover);
    const baseVolume = Number(market.volume);

    return {
      exchange: 'lbank',
      symbol: instrument.symbol,
      fundingRate,
      intervalHours,
      nextFundingTime,
      price,
      // LBank does not expose public open interest on this market endpoint.
      openInterestUsd: null,
      // `turnover` is quote-denominated and already USD/USDT in SwapU.
      volume24hUsd: Number.isFinite(turnover) ? turnover : (Number.isFinite(baseVolume) && price ? baseVolume * price : null),
    };
  }).filter((row) => Number.isFinite(row.fundingRate));

  for (const row of rows) {
    if (row.nextFundingTime) {
      fundingHistory.recordObservation('lbank', row.symbol, {
        rate: row.fundingRate,
        nextFundingTime: row.nextFundingTime,
      });
    }
  }
  fundingHistory.flush();

  return rows;
}

async function fetchHistory(symbol, limit = 750) {
  return fundingHistory.getHistory('lbank', symbol, limit);
}

module.exports = { id: 'lbank', label: 'LBank', fetchCurrent, fetchHistory };

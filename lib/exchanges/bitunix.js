// Bitunix USDT perpetuals: public market data, no API key required.
// Docs: https://www.bitunix.com/api-docs/futures/market/get_funding_rate_batch.html
const { filterToCrypto } = require('../cryptoassets');

const BASE = 'https://fapi.bitunix.com/api/v1/futures/market';

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { 'User-Agent': 'funding-tracker/1.0' } });
  if (!res.ok) throw new Error(`Bitunix ${path} -> HTTP ${res.status}`);
  const body = await res.json();
  if (Number(body.code) !== 0) throw new Error(`Bitunix ${path} -> ${body.code}: ${body.msg || 'API error'}`);
  return body.data;
}

async function fetchCurrent() {
  const [rates, tickers, instruments] = await Promise.all([
    getJson('/funding_rate/batch'), getJson('/tickers'), getJson('/trading_pairs'),
  ]);
  if (![rates, tickers, instruments].every(Array.isArray)) throw new Error('Bitunix: unexpected market data response');
  const tickerBySymbol = new Map(tickers.map((x) => [x.symbol, x]));
  const live = new Set(instruments.filter((x) => x.symbolStatus === 'OPEN' && x.quote === 'USDT').map((x) => x.symbol));
  const joined = rates.filter((r) => live.has(r.symbol)).map((r) => ({ rate: r, ticker: tickerBySymbol.get(r.symbol) }));
  const crypto = filterToCrypto(joined.filter((x) => x.ticker), {
    exchange: 'bitunix', symbolOf: ({ rate }) => rate.symbol.replace(/USDT$/, ''),
    priceOf: ({ rate, ticker }) => Number(rate.markPrice || ticker.markPrice || ticker.lastPrice),
  });
  return crypto.map(({ rate, ticker }) => ({
    exchange: 'bitunix', symbol: rate.symbol,
    fundingRate: Number(rate.fundingRate), intervalHours: Number(rate.fundingInterval) || null,
    nextFundingTime: Number(rate.nextFundingTime) || null,
    price: Number(rate.markPrice || ticker.markPrice || ticker.lastPrice) || null,
    openInterestUsd: null,
    volume24hUsd: Number.isFinite(Number(ticker.quoteVol)) ? Number(ticker.quoteVol) : null,
  })).filter((r) => Number.isFinite(r.fundingRate));
}

async function fetchHistory(symbol, limit = 200) {
  const rows = await getJson(`/get_funding_rate_history?symbol=${encodeURIComponent(symbol)}&limit=${Math.min(200, Math.max(1, limit))}`);
  return (Array.isArray(rows) ? rows : []).map((r) => ({ rate: Number(r.fundingRate), time: Number(r.fundingTime) }))
    .filter((r) => Number.isFinite(r.rate) && Number.isFinite(r.time)).sort((a, b) => a.time - b.time);
}

module.exports = { id: 'bitunix', label: 'Bitunix', fetchCurrent, fetchHistory };

// Lighter (zkLighter) — perpetual DEX. Public REST API, no key needed.
// Endpoints confirmed against the official Python SDK and real responses:
// https://github.com/elliottech/lighter-python
const { mapWithConcurrency } = require('../pool');
const { filterToCrypto } = require('../cryptoassets');

const BASE = 'https://mainnet.zklighter.elliot.ai';
const INTERVAL_HOURS = 1; // Lighter settles funding hourly
const CONCURRENCY = 6;
const HISTORY_HOURS = 722; // covers cache.js's 30-day avg-APR window (720h) + buffer; the endpoint caps at 750

async function getJson(path) {
  const res = await fetch(BASE + path, { headers: { 'User-Agent': 'funding-tracker/1.0' } });
  if (!res.ok) throw new Error(`Lighter ${path} -> HTTP ${res.status}`);
  const body = await res.json();
  if (body.code !== 200) throw new Error(`Lighter ${path} -> code ${body.code}`);
  return body;
}

// symbol -> [{ rate, time }], filled by fetchCurrent and read by fetchHistory.
// fetchCurrent already has to pull each market's funding history (see below),
// so keeping it means fetchHistory costs no requests at all.
let historyBySymbol = new Map();

// Lighter reports funding as a positive percentage plus a direction, so the
// sign has to be reassembled: "long" means longs pay shorts (positive by this
// app's convention), "short" the reverse. The percentage is confirmed by the
// row's own `value` field, which is the payment per 1 coin — for BTC at
// $79,954 a rate of 0.0012 yields value 0.9575, i.e. 0.0012% and not 0.0012.
function parseFundings(rows) {
  return (rows || [])
    .map((r) => ({
      rate: (r.direction === 'short' ? -1 : 1) * (Number(r.rate) / 100),
      time: Number(r.timestamp) * 1000, // Lighter sends seconds, the app works in ms
    }))
    .filter((r) => Number.isFinite(r.rate) && Number.isFinite(r.time))
    .sort((a, b) => a.time - b.time);
}

// Returns current funding for every active crypto perpetual.
//
// Lighter also lists ~100 tokenized stocks, ETFs, forex pairs and commodities
// (AAPL, TSLA, EURUSD, XAU, US500, even ANTHROPIC and OPENAI) as ordinary
// perps, with every field identical to a real coin's — lib/cryptoassets.js is
// what separates them, before the per-market fan-out so the excluded markets
// cost no requests.
//
// The current rate comes from each market's funding history rather than the
// bulk /api/v1/funding-rates endpoint: that one is a cross-exchange comparison
// widget (its rows carry an `exchange` field for binance/bybit/hyperliquid too)
// and its numbers don't reconcile with this exchange's own settlements — for
// BTC and ETH it reads exactly 8x the hourly rate, for SKR ~10x, and for 2Z it
// comes back with the opposite sign. Reading the history instead costs one
// request per market but is self-consistent, and it doubles as the cache that
// makes fetchHistory free.
async function fetchCurrent() {
  const { order_book_details: markets } = await getJson('/api/v1/orderBookDetails');

  const perps = (markets || []).filter((m) => m.market_type === 'perp' && m.status === 'active');
  const crypto = filterToCrypto(perps, {
    exchange: 'lighter',
    symbolOf: (m) => m.symbol,
    priceOf: (m) => Number(m.mark_price),
  });

  const now = Date.now();
  const start = now - HISTORY_HOURS * 60 * 60 * 1000;

  const rows = await mapWithConcurrency(crypto, CONCURRENCY, async (m) => {
    const { fundings } = await getJson(
      `/api/v1/fundings?market_id=${m.market_id}&resolution=1h&start_timestamp=${start}&end_timestamp=${now}&count_back=0`
    );
    const history = parseFundings(fundings);
    if (!history.length) return null;

    historyBySymbol.set(m.symbol, history);

    return {
      exchange: 'lighter',
      symbol: m.symbol, // bare base ticker, e.g. "BTC" — no quote suffix to strip
      fundingRate: history[history.length - 1].rate,
      intervalHours: INTERVAL_HOURS,
      // Settles on the hour without publishing a per-market timestamp, same as
      // Hyperliquid — left null rather than guessed at.
      nextFundingTime: null,
      price: Number(m.mark_price) || Number(m.last_trade_price) || null,
    };
  });

  return rows.filter((r) => r && !r.error && Number.isFinite(r.fundingRate));
}

// Served from the cache fetchCurrent fills in the same refresh cycle, so this
// makes no request of its own.
async function fetchHistory(symbol, limit = 200) {
  const history = historyBySymbol.get(symbol);
  if (!history) throw new Error(`Lighter: no cached funding history for ${symbol}`);
  return history.slice(-limit);
}

module.exports = { id: 'lighter', label: 'Lighter', fetchCurrent, fetchHistory };

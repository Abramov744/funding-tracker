const path = require('path');
const express = require('express');
const cache = require('./lib/cache');
const marketcap = require('./lib/marketcap');
const spotVenues = require('./lib/spotVenues');
const exchanges = require('./lib/exchanges');

const app = express();
const PORT = process.env.PORT || 3000;
const HISTORY_DAYS = 30;
const HISTORY_MAX_LIMIT = 750; // safety cap for exchanges with short funding intervals (e.g. 1h)
const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const SPOT_PRICE_CACHE_MS = 60 * 1000; // spare CoinGecko's rate limit on repeat popup opens
const spotPriceCache = new Map(); // baseAsset (uppercase) -> { expiresAt, data }

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'funding-tracker/1.0' } });
  if (!res.ok) throw new Error(`CoinGecko ${url} -> HTTP ${res.status}`);
  return res.json();
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/funding', (req, res) => {
  const state = cache.getState();
  res.json({
    updatedAt: state.updatedAt,
    refreshing: state.refreshing,
    errors: state.errors,
    rows: state.rows,
  });
});

app.post('/api/refresh', async (req, res) => {
  const state = await cache.refresh({ force: true });
  res.json({ updatedAt: state.updatedAt, refreshing: state.refreshing, errors: state.errors });
});

// On-demand funding-rate history for the "click a coin name" chart popup —
// covers the last 30 days, fetched fresh per request rather than kept in the
// main cache (which only stores per-symbol stats, not full history).
app.get('/api/history', async (req, res) => {
  const { exchange, symbol } = req.query;
  const ex = exchanges.byId.get(exchange);
  if (!ex) return res.status(400).json({ error: `Unknown exchange: ${exchange}` });
  if (!symbol) return res.status(400).json({ error: 'Missing symbol' });

  const intervalHours = Number(req.query.intervalHours) || 8;
  const limit = Math.min(HISTORY_MAX_LIMIT, Math.ceil((HISTORY_DAYS * 24) / intervalHours) + 2);

  try {
    const history = await ex.fetchHistory(symbol, limit, intervalHours);
    const cutoff = Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000;
    res.json({
      exchange,
      symbol,
      intervalHours,
      history: (history || []).filter((h) => h.time >= cutoff),
    });
  } catch (err) {
    res.status(502).json({ error: err.message || String(err) });
  }
});

// Spot prices for one coin across the top-15 CoinGecko-ranked exchanges + Aster —
// backs the "where can I buy this on spot" list in the funding-history popup.
app.get('/api/spot-prices', async (req, res) => {
  const symbol = (req.query.symbol || '').toString().trim();
  if (!symbol) return res.status(400).json({ error: 'Missing symbol' });

  const cacheKey = symbol.toUpperCase();
  const cached = spotPriceCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return res.json(cached.data);

  const coingeckoId = marketcap.lookupId(symbol);
  if (!coingeckoId) {
    const data = { symbol, coingeckoId: null, venues: [] };
    spotPriceCache.set(cacheKey, { data, expiresAt: Date.now() + SPOT_PRICE_CACHE_MS });
    return res.json(data);
  }

  const exchangeIds = spotVenues.allowedIds();

  try {
    const result = await getJson(
      `${COINGECKO_BASE}/coins/${coingeckoId}/tickers?exchange_ids=${exchangeIds.join(',')}&include_exchange_logo=false`
    );
    const tickers = (result && result.tickers) || [];

    // Keep one price per exchange — prefer a USDT quote, then USD/USDC/BUSD, then
    // whatever else is on offer, so e.g. a EUR-only listing doesn't get dropped.
    const QUOTE_PRIORITY = ['USDT', 'USD', 'USDC', 'BUSD'];
    const bestByExchange = new Map();
    for (const t of tickers) {
      const id = t.market && t.market.identifier;
      if (!id || t.last == null) continue;
      const rank = QUOTE_PRIORITY.indexOf((t.target || '').toUpperCase());
      const existing = bestByExchange.get(id);
      const existingRank = existing ? QUOTE_PRIORITY.indexOf((existing.target || '').toUpperCase()) : -1;
      const better = !existing || (rank !== -1 && (existingRank === -1 || rank < existingRank));
      if (better) bestByExchange.set(id, t);
    }

    const venues = Array.from(bestByExchange.entries())
      .map(([id, t]) => ({ id, name: spotVenues.nameFor(id), price: t.last, quote: t.target }))
      .sort((a, b) => a.price - b.price);

    const data = { symbol, coingeckoId, venues };
    spotPriceCache.set(cacheKey, { data, expiresAt: Date.now() + SPOT_PRICE_CACHE_MS });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message || String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Funding tracker listening on port ${PORT}`);
  // Load market-cap ranks and the top-exchange list first so the very first
  // funding refresh and popup opens can already use them.
  Promise.all([
    marketcap.refresh().catch((err) => console.error('Initial CoinGecko rank fetch failed:', err)),
    spotVenues.refresh().catch((err) => console.error('Initial CoinGecko exchange-list fetch failed:', err)),
  ]).finally(() => {
    marketcap.startAutoRefresh();
    spotVenues.startAutoRefresh();
    cache.startAutoRefresh();
  });
});

const path = require('path');
const express = require('express');
const cache = require('./lib/cache');
const marketcap = require('./lib/marketcap');
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

// Kicks off a refresh and returns immediately rather than waiting for it to
// finish — with eleven exchanges now (some needing many per-symbol requests,
// throttled on top of that for rate-limit-sensitive ones like Hyperliquid),
// a full cycle can take well past what a browser/proxy will wait on one
// request for. The client polls /api/funding's `refreshing` flag instead to
// know when it's done — same source of truth the background 5-minute
// auto-refresh already exposes.
app.post('/api/refresh', (req, res) => {
  cache.refresh({ force: true }).catch((err) => console.error('Manual refresh failed:', err));
  const state = cache.getState();
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

const SPOT_VENUE_LIMIT = 10;

// Spot prices for one coin across the exchanges currently trading it with the
// most 24h volume — backs the "where can I buy this on spot" list in the
// funding-history popup.
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

  try {
    const result = await getJson(`${COINGECKO_BASE}/coins/${coingeckoId}/tickers?include_exchange_logo=false`);
    const tickers = (result && result.tickers) || [];

    // An exchange can list several pairs for the same coin (BTC/USDT, BTC/USDC, ...) —
    // keep only its most-traded pair, since that's the price/volume that actually
    // represents "buying this coin on spot there".
    const bestByExchange = new Map();
    for (const t of tickers) {
      const id = t.market && t.market.identifier;
      const volumeUsd = t.converted_volume && t.converted_volume.usd;
      if (!id || t.last == null || volumeUsd == null) continue;
      const existing = bestByExchange.get(id);
      if (!existing || volumeUsd > existing.volumeUsd) {
        bestByExchange.set(id, { name: (t.market && t.market.name) || id, price: t.last, quote: t.target, volumeUsd });
      }
    }

    const venues = Array.from(bestByExchange.entries())
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => b.volumeUsd - a.volumeUsd)
      .slice(0, SPOT_VENUE_LIMIT);

    const data = { symbol, coingeckoId, venues };
    spotPriceCache.set(cacheKey, { data, expiresAt: Date.now() + SPOT_PRICE_CACHE_MS });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message || String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Funding tracker listening on port ${PORT}`);
  // Load market-cap ranks first so the very first funding refresh can already
  // attach them, instead of every row showing "—" until the next cycle.
  marketcap
    .refresh()
    .catch((err) => console.error('Initial CoinGecko rank fetch failed:', err))
    .finally(() => {
      marketcap.startAutoRefresh();
      cache.startAutoRefresh();
    });
});

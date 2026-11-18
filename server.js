const path = require('path');
const express = require('express');
const cache = require('./lib/cache');
const marketcap = require('./lib/marketcap');
const rwaCoinList = require('./lib/rwaCoinList');
const exchanges = require('./lib/exchanges');
const auth = require('./lib/auth');
const favorites = require('./lib/favorites');
const aprHistory = require('./lib/aprHistory');
const orderBooks = require('./lib/orderBooks');
const { PRICE_BAND } = require('./lib/cryptoassets');

const app = express();
const PORT = process.env.PORT || 3000;
const HISTORY_DAYS = 30;
const HISTORY_MAX_LIMIT = 750; // safety cap for exchanges with short funding intervals (e.g. 1h)
const SPOT_PRICE_CACHE_MS = 60 * 1000;
const spotPriceCache = new Map(); // baseAsset (uppercase) -> { expiresAt, data }

app.use(express.json());

// Login page and the login/logout endpoints themselves have to stay reachable
// without a session — everything else below auth.requireAuth does not.
app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const role = auth.checkCredentials(username, password);
  if (!role) return res.status(401).json({ error: 'Неверный логин или пароль' });

  if (role === 'guest') auth.recordGuestLogin(req);

  const token = auth.sign({ role, iat: Date.now() });
  res.cookie(auth.COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https',
    maxAge: auth.SESSION_MAX_AGE_MS,
  });
  res.json({ ok: true, role });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(auth.COOKIE_NAME);
  res.json({ ok: true });
});

// Everything from here on requires a logged-in session (guest or owner).
app.use(auth.requireAuth);

// Tells the frontend which role the current session has — e.g. so the
// "Гостевые входы" link in the header only shows up for the owner.
app.get('/api/session', (req, res) => {
  res.json({ role: req.session.role });
});

// Owner-only: how many times, and when, someone has logged in with the
// shared "guest" password — backs public/admin.html.
app.get('/api/guest-logins', auth.requireOwner, (req, res) => {
  const entries = auth.readGuestLog();
  res.json({ count: entries.length, entries });
});

// Favorited coins (by base asset) are shared server-side, not per-browser —
// lib/cache.js uses these lists to force those coins into every exchange's
// history-fetch candidates regardless of current-rate ranking, so "add to
// favorites" also means "always keep monitoring this coin". Kept as one list
// per tab (funding/spread) since starring a coin on one table isn't meant to
// affect the other.
function favoritesPayload() {
  return { funding: favorites.list('funding'), spread: favorites.list('spread') };
}

app.get('/api/favorites', (req, res) => {
  res.json(favoritesPayload());
});

app.post('/api/favorites/:tab/:baseAsset', (req, res) => {
  favorites.add(req.params.tab, req.params.baseAsset);
  res.json(favoritesPayload());
});

app.delete('/api/favorites/:tab/:baseAsset', (req, res) => {
  favorites.remove(req.params.tab, req.params.baseAsset);
  res.json(favoritesPayload());
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/funding', (req, res) => {
  const state = cache.getState();
  res.json({
    updatedAt: state.updatedAt,
    refreshing: state.refreshing,
    errors: state.errors,
    rows: state.rows,
    // Lets the client tell "this coin genuinely isn't in CoinGecko's top
    // 1500" from "CoinGecko itself is unreachable right now" — every row's
    // marketCapRank reads null in both cases, but only the first should
    // count against it in the "макс. ранг" filter.
    marketCapRankAvailable: marketcap.isUsable(),
  });
});

// Futures-futures funding-rate spread tab: long one exchange's perp, short
// another's on the same coin — delta-neutral, no spot leg. Computed as a
// derived pass over the same cache (lib/spreads.js), so it shares
// updatedAt/refreshing/errors with /api/funding rather than tracking its own.
app.get('/api/spreads', (req, res) => {
  const state = cache.getState();
  res.json({
    updatedAt: state.updatedAt,
    refreshing: state.refreshing,
    errors: state.errors,
    rows: state.spreadRows,
    marketCapRankAvailable: marketcap.isUsable(),
  });
});

// Kicks off a refresh and returns immediately rather than waiting for it to
// finish — with fourteen exchanges now (some needing many per-symbol requests,
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

// Trend of the row's own *average* APR (the "Ср. APR %" column) over time —
// distinct from /api/history above, which is individual funding settlements,
// not how their 30-day average has moved. Served straight from the in-memory
// hourly-snapshot store (lib/aprHistory.js); no external request involved.
app.get('/api/apr-history', (req, res) => {
  const { exchange, symbol } = req.query;
  if (!exchange) return res.status(400).json({ error: 'Missing exchange' });
  if (!symbol) return res.status(400).json({ error: 'Missing symbol' });

  res.json({ exchange, symbol, points: aprHistory.getHistory(exchange, symbol) });
});

const SPOT_VENUE_LIMIT = 10;

// Spot prices are sourced directly from public order books on exchanges whose
// spot adapter is enabled. CoinGecko is not used for this popup calculation.
app.get('/api/spot-prices', async (req, res) => {
  const symbol = (req.query.symbol || '').toString().trim();
  if (!symbol) return res.status(400).json({ error: 'Missing symbol' });

  const refPrice = Number(req.query.refPrice);
  const hasRefPrice = Number.isFinite(refPrice) && refPrice > 0;
  const cacheKey = symbol.toUpperCase();
  const cached = spotPriceCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return res.json(cached.data);

  try {
    const allVenues = await orderBooks.getSpotVenuePrices(symbol);
    const filtered = allVenues.filter((venue) => {
      if (!hasRefPrice) return true;
      return venue.price >= refPrice / PRICE_BAND && venue.price <= refPrice * PRICE_BAND;
    });
    const venues = filtered.slice(0, SPOT_VENUE_LIMIT);
    const data = { symbol, coingeckoId: marketcap.lookupId(symbol), venues };
    spotPriceCache.set(cacheKey, { data, expiresAt: Date.now() + SPOT_PRICE_CACHE_MS });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message || String(err) });
  }
});

app.post('/api/orderbook-check', async (req, res) => {
  const {
    futuresExchange,
    futuresSymbol,
    spotExchangeId,
    base,
    quote,
    sizeUsdt,
  } = req.body || {};

  if (!futuresExchange || !futuresSymbol || !spotExchangeId || !base || !quote) {
    return res.status(400).json({ error: 'Не хватает параметров для проверки стакана.' });
  }
  if (!Number.isFinite(Number(sizeUsdt)) || Number(sizeUsdt) <= 0) {
    return res.status(400).json({ error: 'Укажите размер позиции в USDT больше нуля.' });
  }

  try {
    const result = await orderBooks.checkOrderBook({
      futuresExchange,
      futuresSymbol,
      spotExchangeId,
      base,
      quote,
      sizeUsdt,
    });
    return res.json(result);
  } catch (err) {
    return res.status(502).json({ error: err.message || String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Funding tracker listening on port ${PORT}`);
  // Load the RWA coin list alongside market-cap ranks, before the very first
  // funding refresh — marketcap.js's own RWA exclusion checks it (see
  // lib/marketcap.js), and lib/cryptoassets.js's unranked-coin fallback needs
  // it loaded to do anything useful from the first cycle, instead of every
  // outside-top-1500 row reading as "not a coin" until the next cycle.
  Promise.all([
    marketcap.refresh().catch((err) => console.error('Initial CoinGecko rank fetch failed:', err)),
    rwaCoinList.refresh().catch((err) => console.error('Initial CoinGecko RWA/coin-list fetch failed:', err)),
  ]).finally(() => {
    marketcap.startAutoRefresh();
    rwaCoinList.startAutoRefresh();
    cache.startAutoRefresh();
    aprHistory.startAutoSnapshot();
  });
});

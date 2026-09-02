const path = require('path');
const express = require('express');
const cache = require('./lib/cache');
const marketcap = require('./lib/marketcap');
const exchanges = require('./lib/exchanges');

const app = express();
const PORT = process.env.PORT || 3000;
const HISTORY_DAYS = 30;
const HISTORY_MAX_LIMIT = 750; // safety cap for exchanges with short funding intervals (e.g. 1h)

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

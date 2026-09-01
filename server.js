const path = require('path');
const express = require('express');
const cache = require('./lib/cache');
const marketcap = require('./lib/marketcap');

const app = express();
const PORT = process.env.PORT || 3000;

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

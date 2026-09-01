const path = require('path');
const express = require('express');
const cache = require('./lib/cache');

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
  cache.startAutoRefresh();
});

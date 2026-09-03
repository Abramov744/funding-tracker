const { EXCHANGES } = require('./exchanges');
const { baseAsset, annualizedPct, historyStats } = require('./metrics');
const { mapWithConcurrency } = require('./pool');
const marketcap = require('./marketcap');

// Only rows currently paying positive funding are worth the extra per-symbol
// history calls (they're the only ones the spot+short strategy would enter).
// Cap how many we fetch history for so a refresh can't balloon into thousands
// of requests against exchanges we don't control the rate limits of.
const HISTORY_LIMIT = 200; // funding settlements looked at per symbol (Aster's 1h interval means 100 was only ~4 days)
const MAX_CANDIDATES_PER_EXCHANGE = 200;
const HISTORY_CONCURRENCY = 6;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MIN_MANUAL_REFRESH_GAP_MS = 30 * 1000;

const state = {
  rows: [],
  updatedAt: null,
  lastRefreshStartedAt: 0,
  refreshing: false,
  errors: {},
};

async function buildRowsForExchange(ex) {
  const current = await ex.fetchCurrent();

  const candidates = current
    .filter((c) => c.fundingRate > 0)
    .sort((a, b) => b.fundingRate - a.fundingRate)
    .slice(0, MAX_CANDIDATES_PER_EXCHANGE);

  const enriched = await mapWithConcurrency(candidates, HISTORY_CONCURRENCY, async (c) => {
    const history = await ex.fetchHistory(c.symbol, HISTORY_LIMIT, c.intervalHours);
    let intervalHours = c.intervalHours;
    let nextFundingTime = c.nextFundingTime;
    if (!intervalHours && ex.fetchIntervalHours) {
      const extra = await ex.fetchIntervalHours(c.symbol);
      intervalHours = extra.intervalHours;
      nextFundingTime = nextFundingTime || extra.nextFundingTime;
    }
    return { symbol: c.symbol, history, intervalHours, nextFundingTime };
  });

  const enrichedBySymbol = new Map(enriched.filter((e) => e && !e.error).map((e) => [e.symbol, e]));

  return current.map((c) => {
    const extra = enrichedBySymbol.get(c.symbol);
    const intervalHours = (extra && extra.intervalHours) || c.intervalHours;
    const nextFundingTime = (extra && extra.nextFundingTime) || c.nextFundingTime;
    const stats = extra ? historyStats(extra.history) : historyStats([]);
    const isCandidate = Boolean(extra); // true only when the history fetch actually succeeded
    const base = baseAsset(c.symbol);

    return {
      exchange: ex.id,
      exchangeLabel: ex.label,
      symbol: c.symbol,
      baseAsset: base,
      marketCapRank: marketcap.lookup(base),
      price: c.price ?? null,
      fundingRate: c.fundingRate,
      intervalHours: intervalHours || null,
      aprPct: annualizedPct(c.fundingRate, intervalHours),
      nextFundingTime,
      historyChecked: isCandidate,
      periods: stats.periods,
      positiveRatio: stats.positiveRatio,
      minRate: stats.minRate,
      maxRate: stats.maxRate,
      avgRate: stats.avgRate,
      avgAprPct: intervalHours ? annualizedPct(stats.avgRate, intervalHours) : null,
      currentStreak: stats.currentStreak,
    };
  });
}

async function refresh({ force = false } = {}) {
  const now = Date.now();
  if (state.refreshing) return state;
  if (!force && now - state.lastRefreshStartedAt < MIN_MANUAL_REFRESH_GAP_MS && state.rows.length) return state;

  state.refreshing = true;
  state.lastRefreshStartedAt = now;
  const errors = {};

  // Seed with whatever each exchange produced last cycle, keyed by exchange,
  // so a slow/self-throttled exchange (Hyperliquid's fixed request gap, OKX's
  // per-symbol fan-out) doesn't blank the whole table while it's still
  // working — every other exchange's rows publish to state.rows as soon as
  // that exchange's own promise settles, instead of all ten being gated on
  // Promise.all resolving together.
  const rowsByExchange = new Map();
  for (const row of state.rows) {
    if (!rowsByExchange.has(row.exchange)) rowsByExchange.set(row.exchange, []);
    rowsByExchange.get(row.exchange).push(row);
  }

  function publish() {
    state.rows = EXCHANGES.flatMap((ex) => rowsByExchange.get(ex.id) || []);
    state.updatedAt = Date.now();
    state.errors = { ...errors };
  }

  try {
    await Promise.all(
      EXCHANGES.map((ex) =>
        buildRowsForExchange(ex)
          .then((rows) => {
            rowsByExchange.set(ex.id, rows);
            delete errors[ex.id];
          })
          .catch((err) => {
            errors[ex.id] = err.message || String(err);
            rowsByExchange.set(ex.id, []);
          })
          .finally(publish)
      )
    );
  } finally {
    state.refreshing = false;
  }

  return state;
}

function getState() {
  return state;
}

function startAutoRefresh() {
  refresh().catch((err) => console.error('Initial refresh failed:', err));
  setInterval(() => {
    refresh().catch((err) => console.error('Scheduled refresh failed:', err));
  }, REFRESH_INTERVAL_MS);
}

module.exports = { refresh, getState, startAutoRefresh };

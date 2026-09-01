const aster = require('./exchanges/aster');
const mexc = require('./exchanges/mexc');
const gate = require('./exchanges/gate');
const { baseAsset, annualizedPct, historyStats } = require('./metrics');
const { mapWithConcurrency } = require('./pool');

const EXCHANGES = [aster, mexc, gate];

// Only rows currently paying positive funding are worth the extra per-symbol
// history calls (they're the only ones the spot+short strategy would enter).
// Cap how many we fetch history for so a refresh can't balloon into thousands
// of requests against exchanges we don't control the rate limits of.
const HISTORY_LIMIT = 100; // funding settlements looked at per symbol
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
    const history = await ex.fetchHistory(c.symbol, HISTORY_LIMIT);
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

    return {
      exchange: ex.id,
      exchangeLabel: ex.label,
      symbol: c.symbol,
      baseAsset: baseAsset(c.symbol),
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

  try {
    const results = await Promise.all(
      EXCHANGES.map((ex) =>
        buildRowsForExchange(ex).catch((err) => {
          errors[ex.id] = err.message || String(err);
          return [];
        })
      )
    );

    state.rows = results.flat();
    state.updatedAt = Date.now();
    state.errors = errors;
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

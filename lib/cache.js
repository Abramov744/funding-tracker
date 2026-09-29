const { EXCHANGES } = require('./exchanges');
const { baseAsset, annualizedPct, historyStats } = require('./metrics');
const { mapWithConcurrency } = require('./pool');
const marketcap = require('./marketcap');
const { computeSpreadRows } = require('./spreads');
const favorites = require('./favorites');

// Only rows currently paying positive funding are worth the extra per-symbol
// history calls (they're the only ones the spot+short strategy would enter).
// Cap how many we fetch history for so a refresh can't balloon into thousands
// of requests against exchanges we don't control the rate limits of.
//
// Stats are meant to describe "the last calendar month", not "the last N
// funding settlements" — a fixed period count made the window wildly
// inconsistent across exchanges/coins (~8 days at a 1h interval, ~67 days at
// 8h). So the request size is derived per-coin from its own funding interval
// (see periodsForWindow), and the fetched history is trimmed to the exact
// 30-day window below, in buildRowsForExchange.
const HISTORY_WINDOW_DAYS = 30;
const HISTORY_WINDOW_MS = HISTORY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const HISTORY_LIMIT_FALLBACK = 200; // used only when the interval truly isn't known yet at fetch time
const MAX_HISTORY_LIMIT = 750; // Lighter's endpoint hard-caps here; also under GRVT's documented max of 1000
const MAX_CANDIDATES_PER_EXCHANGE = 200;
// The best *long* leg for the futures-futures spread strategy (lib/spreads.js)
// is often a negative-rate row — being long when funding is negative means
// you get paid too — so those need history fetched as well, not just the
// positive candidates the spot+short strategy cares about. Kept smaller than
// the positive cap since it's extra load exchanges that fan history out one
// request per symbol (OKX, GRVT) weren't sized around.
const MAX_NEGATIVE_CANDIDATES_PER_EXCHANGE = 100;
const HISTORY_CONCURRENCY = 6;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MIN_MANUAL_REFRESH_GAP_MS = 30 * 1000;

// How many funding periods to request so the response comfortably covers the
// 30-day window regardless of the coin's own funding interval (1h/4h/8h).
// Some exchanges (Bybit, Pacifica) cap their history endpoint below what a 1h
// interval would need for a full 30 days — for those we simply get whatever
// history they're willing to give, same as a coin with a shorter real history.
function periodsForWindow(intervalHours) {
  if (!intervalHours) return HISTORY_LIMIT_FALLBACK;
  const needed = Math.ceil(HISTORY_WINDOW_MS / (intervalHours * 60 * 60 * 1000)) + 2; // +2: boundary settlements
  return Math.min(MAX_HISTORY_LIMIT, needed);
}

// Trims a (possibly longer) oldest-first history array down to the last 30
// calendar days, so avg/positive-ratio/min/streak all describe the same
// window no matter how much extra history an exchange handed back.
function last30Days(history) {
  const cutoff = Date.now() - HISTORY_WINDOW_MS;
  return history.filter((h) => h.time >= cutoff);
}

const state = {
  rows: [],
  spreadRows: [],
  updatedAt: null,
  lastRefreshStartedAt: 0,
  refreshing: false,
  errors: {},
};

async function buildRowsForExchange(ex) {
  const current = await ex.fetchCurrent();

  const positive = current
    .filter((c) => c.fundingRate > 0)
    .sort((a, b) => b.fundingRate - a.fundingRate)
    .slice(0, MAX_CANDIDATES_PER_EXCHANGE);

  const negative = current
    .filter((c) => c.fundingRate < 0)
    .sort((a, b) => a.fundingRate - b.fundingRate) // most negative first
    .slice(0, MAX_NEGATIVE_CANDIDATES_PER_EXCHANGE);

  // A coin favorited on EITHER tab must keep being monitored regardless of
  // where its current rate ranks — without this, a coin that drifts out of
  // the top MAX_CANDIDATES_PER_EXCHANGE/MAX_NEGATIVE_CANDIDATES_PER_EXCHANGE
  // cut would silently stop getting history fetched (and so lose its stats
  // and its "matches strategy" eligibility) the moment its rate becomes
  // unremarkable, exactly the kind of silent drop the cap exists to protect
  // everything else from. favorites.hasAny() checks both tabs' lists — which
  // tab starred it doesn't matter here, only that something needs its history.
  const rankedSymbols = new Set(positive.concat(negative).map((c) => c.symbol));
  const forcedFavorites = current.filter(
    (c) => !rankedSymbols.has(c.symbol) && favorites.hasAny(baseAsset(c.symbol))
  );

  const candidates = positive.concat(negative).concat(forcedFavorites);

  const enriched = await mapWithConcurrency(candidates, HISTORY_CONCURRENCY, async (c) => {
    let intervalHours = c.intervalHours;
    let nextFundingTime = c.nextFundingTime;
    if (!intervalHours && ex.fetchIntervalHours) {
      const extra = await ex.fetchIntervalHours(c.symbol);
      intervalHours = extra.intervalHours;
      nextFundingTime = nextFundingTime || extra.nextFundingTime;
    }
    const history = await ex.fetchHistory(c.symbol, periodsForWindow(intervalHours), intervalHours);
    // Some exchanges (Aster) don't offer a bulk open-interest endpoint — OI
    // has to be fetched per symbol, same as history above, so it's only ever
    // paid for candidates, not fetchCurrent()'s full unfiltered list. Errors
    // here degrade to null rather than failing the candidate's history/rank.
    let openInterestUsd = null;
    if (ex.fetchOpenInterest) {
      openInterestUsd = await ex.fetchOpenInterest(c.symbol, c.price).catch(() => null);
    }
    return { symbol: c.symbol, history, intervalHours, nextFundingTime, openInterestUsd };
  });

  const enrichedBySymbol = new Map(enriched.filter((e) => e && !e.error).map((e) => [e.symbol, e]));

  const rows = current.map((c) => {
    const extra = enrichedBySymbol.get(c.symbol);
    const intervalHours = (extra && extra.intervalHours) || c.intervalHours;
    const nextFundingTime = (extra && extra.nextFundingTime) || c.nextFundingTime;
    const stats = extra ? historyStats(last30Days(extra.history)) : historyStats([]);
    const isCandidate = Boolean(extra); // true only when the history fetch actually succeeded
    const base = baseAsset(c.symbol);

    return {
      exchange: ex.id,
      exchangeLabel: ex.label,
      symbol: c.symbol,
      baseAsset: base,
      marketCapRank: marketcap.lookup(base),
      // Notional value of open positions on this specific market — a liquidity
      // signal independent of the coin's overall market-cap rank. Most
      // exchanges set this directly on fetchCurrent()'s row (c); a few
      // (Aster) can only fetch it per candidate, via fetchOpenInterest above.
      // Unverified exchanges carry null until checked against real API data.
      openInterestUsd: (extra && extra.openInterestUsd) ?? c.openInterestUsd ?? null,
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

  // Raw material for the futures-futures spread tab (lib/spreads.js) — the
  // trimmed 30-day history that's otherwise discarded once `rows` above is
  // built. Kept only for the duration of this refresh cycle, not retained on
  // `rows` itself (a full history array per row, times every candidate on
  // every exchange, would add up to real standing memory for no ongoing use).
  const spreadCandidates = candidates
    .map((c) => {
      const extra = enrichedBySymbol.get(c.symbol);
      if (!extra) return null;
      const intervalHours = extra.intervalHours || c.intervalHours;
      if (!intervalHours) return null;
      const history = last30Days(extra.history);
      if (history.length < 2) return null;
      return {
        exchange: ex.id,
        exchangeLabel: ex.label,
        symbol: c.symbol,
        baseAsset: baseAsset(c.symbol),
        price: c.price ?? null,
        intervalHours,
        fundingRate: c.fundingRate,
        openInterestUsd: extra.openInterestUsd ?? c.openInterestUsd ?? null,
        nextFundingTime: extra.nextFundingTime || c.nextFundingTime,
        history,
      };
    })
    .filter(Boolean);

  return { rows, spreadCandidates };
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

  const spreadCandidatesByExchange = new Map();

  try {
    await Promise.all(
      EXCHANGES.map((ex) =>
        buildRowsForExchange(ex)
          .then(({ rows, spreadCandidates }) => {
            rowsByExchange.set(ex.id, rows);
            spreadCandidatesByExchange.set(ex.id, spreadCandidates);
            delete errors[ex.id];
          })
          .catch((err) => {
            errors[ex.id] = err.message || String(err);
            rowsByExchange.set(ex.id, []);
            spreadCandidatesByExchange.set(ex.id, []);
          })
          .finally(publish)
      )
    );

    // TEMP DIAGNOSTIC: confirm Phemex resolves cleanly in production —
    // remove once confirmed.
    console.log(`phemex: rows=${(rowsByExchange.get('phemex') || []).length} error=${errors.phemex || 'none'}`);

    // Needs at least two exchanges' candidates for the same coin, so unlike
    // the per-exchange rows above there's no useful incremental version of
    // this — computed once every exchange has settled.
    const allSpreadCandidates = [].concat(...spreadCandidatesByExchange.values());
    state.spreadRows = computeSpreadRows(allSpreadCandidates);
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

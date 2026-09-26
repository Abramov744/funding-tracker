// Cross-exchange funding-rate spread: long one exchange's perp, short another
// exchange's perp on the same coin — delta-neutral (no spot leg, no price
// exposure), profit is purely the funding-rate differential between the two
// legs. Computed as a derived pass over the same per-candidate history
// lib/cache.js already fetches for the single-exchange spot+short strategy;
// no extra exchange API calls.
const { historyStats, annualizedPct } = require('./metrics');
const marketcap = require('./marketcap');

const HOUR_MS = 60 * 60 * 1000;

// Every exchange settles on its own schedule (1h/4h/8h, sometimes per-coin),
// so two legs' raw history isn't directly comparable. Both get resampled onto
// a shared hourly grid instead: at each hour, a leg's "rate in effect" is
// forward-filled from its most recent settlement at or before that hour, then
// divided by its own intervalHours so a 8h-interval rate and a 1h-interval
// rate land in the same per-hour units before they're ever compared.
function buildHourGrid(startMs, endMs) {
  const hours = [];
  const first = Math.ceil(startMs / HOUR_MS) * HOUR_MS;
  for (let t = first; t <= endMs; t += HOUR_MS) hours.push(t);
  return hours;
}

// history: [{rate, time}], oldest first. Returns Map<hour, hourlyRate>, only
// for hours at/after this leg's own first known settlement — never
// extrapolated backwards past where its real data starts.
function toHourlyRateMap(history, intervalHours, hours) {
  const map = new Map();
  let idx = -1;
  for (const hour of hours) {
    while (idx + 1 < history.length && history[idx + 1].time <= hour) idx++;
    if (idx === -1) continue;
    map.set(hour, history[idx].rate / intervalHours);
  }
  return map;
}

// candidates: flattened list across every exchange of
// { exchange, exchangeLabel, symbol, baseAsset, price, intervalHours,
//   fundingRate, openInterestUsd, nextFundingTime, history }
// — both the positive- and negative-funding candidates lib/cache.js fetched
// history for (a negative-rate leg is often the *better* long side: being
// long when funding is negative means you get paid too).
//
// Returns one row per (coin, exchange pair) that's currently profitable on
// average over the lookback window — short the leg with the higher
// annualized rate, long the one with the lower. Pairs that were only
// profitable in the past, or aren't right now, are left out entirely rather
// than shown with a losing sign.
function computeSpreadRows(candidates) {
  const nowHour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;

  const byBaseAsset = new Map();
  const hourlyByLeg = new Map(); // `${exchange}:${symbol}` -> Map<hour, hourlyRate>
  for (const c of candidates) {
    if (!c.history || c.history.length < 2) continue;
    if (!byBaseAsset.has(c.baseAsset)) byBaseAsset.set(c.baseAsset, []);
    byBaseAsset.get(c.baseAsset).push(c);
    const hours = buildHourGrid(c.history[0].time, nowHour);
    hourlyByLeg.set(`${c.exchange}:${c.symbol}`, toHourlyRateMap(c.history, c.intervalHours, hours));
  }

  const rows = [];

  for (const [base, legs] of byBaseAsset) {
    if (legs.length < 2) continue;

    for (let i = 0; i < legs.length; i++) {
      for (let j = i + 1; j < legs.length; j++) {
        const a = legs[i];
        const b = legs[j];
        const aprA = annualizedPct(a.fundingRate, a.intervalHours);
        const aprB = annualizedPct(b.fundingRate, b.intervalHours);
        if (aprA === null || aprB === null || aprA === aprB) continue;

        const short = aprA > aprB ? a : b;
        const long = aprA > aprB ? b : a;

        const overlapStart = Math.max(short.history[0].time, long.history[0].time);
        const hours = buildHourGrid(overlapStart, nowHour);
        if (hours.length < 2) continue;

        const shortHourly = hourlyByLeg.get(`${short.exchange}:${short.symbol}`);
        const longHourly = hourlyByLeg.get(`${long.exchange}:${long.symbol}`);

        const spreadHistory = [];
        for (const hour of hours) {
          const sr = shortHourly.get(hour);
          const lr = longHourly.get(hour);
          if (sr === undefined || lr === undefined) continue;
          spreadHistory.push({ rate: sr - lr, time: hour });
        }
        if (spreadHistory.length < 2) continue;

        const stats = historyStats(spreadHistory);
        const avgAprPct = annualizedPct(stats.avgRate, 1);
        if (avgAprPct === null || avgAprPct <= 0) continue;

        const currentSpreadRate = short.fundingRate / short.intervalHours - long.fundingRate / long.intervalHours;

        rows.push({
          baseAsset: base,
          marketCapRank: marketcap.lookup(base),
          shortExchange: short.exchange,
          shortExchangeLabel: short.exchangeLabel,
          shortSymbol: short.symbol,
          shortRate: short.fundingRate,
          shortIntervalHours: short.intervalHours,
          shortPrice: short.price,
          shortOpenInterestUsd: short.openInterestUsd,
          shortNextFundingTime: short.nextFundingTime,
          longExchange: long.exchange,
          longExchangeLabel: long.exchangeLabel,
          longSymbol: long.symbol,
          longRate: long.fundingRate,
          longIntervalHours: long.intervalHours,
          longPrice: long.price,
          longOpenInterestUsd: long.openInterestUsd,
          longNextFundingTime: long.nextFundingTime,
          spreadAprPct: annualizedPct(currentSpreadRate, 1),
          periods: stats.periods,
          positiveRatio: stats.positiveRatio,
          minAprPct: annualizedPct(stats.minRate, 1),
          maxAprPct: annualizedPct(stats.maxRate, 1),
          avgAprPct,
          currentStreak: stats.currentStreak,
        });
      }
    }
  }

  return rows;
}

module.exports = { computeSpreadRows };

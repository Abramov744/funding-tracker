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

// Same series with every rate's sign flipped — used to re-derive stats for
// the opposite short/long assignment without re-scanning the raw history.
function negateHistory(history) {
  return history.map((h) => ({ rate: -h.rate, time: h.time }));
}

// candidates: flattened list across every exchange of
// { exchange, exchangeLabel, symbol, baseAsset, price, intervalHours,
//   fundingRate, openInterestUsd, nextFundingTime, history }
// — both the positive- and negative-funding candidates lib/cache.js fetched
// history for (a negative-rate leg is often the *better* long side: being
// long when funding is negative means you get paid too).
//
// Returns one row per (coin, exchange pair) that's profitable on average
// over the lookback window. Which side is short and which is long is decided
// by that 30-day average, not by whichever side happens to be paying more
// right now — two exchanges' rates for the same coin are usually correlated
// and swap which one's higher fairly often, so picking direction off the
// current tick alone would frequently pick the *wrong*, historically-losing
// side and miss a pair that's actually been stably profitable the other way
// round. The current-moment rate is still shown (as spreadAprPct) alongside
// the average, so a current reversal relative to the historical norm is
// visible rather than hidden.
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

        const overlapStart = Math.max(a.history[0].time, b.history[0].time);
        const hours = buildHourGrid(overlapStart, nowHour);
        if (hours.length < 2) continue;

        const aHourly = hourlyByLeg.get(`${a.exchange}:${a.symbol}`);
        const bHourly = hourlyByLeg.get(`${b.exchange}:${b.symbol}`);

        const diffHistory = []; // a's rate minus b's, hour by hour
        for (const hour of hours) {
          const ar = aHourly.get(hour);
          const br = bHourly.get(hour);
          if (ar === undefined || br === undefined) continue;
          diffHistory.push({ rate: ar - br, time: hour });
        }
        if (diffHistory.length < 2) continue;

        const rawStats = historyStats(diffHistory);
        if (!rawStats.avgRate) continue; // null, or exactly 0 -> no direction to pick

        // a averaged higher than b -> a is the historically-favorable short
        // side; otherwise it's the other way round and every stat needs
        // re-deriving on the negated series rather than just swapped.
        const favorsA = rawStats.avgRate > 0;
        const short = favorsA ? a : b;
        const long = favorsA ? b : a;
        const stats = favorsA ? rawStats : historyStats(negateHistory(diffHistory));

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

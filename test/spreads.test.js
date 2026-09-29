// No-network unit test for lib/spreads.js's computeSpreadRows — pure
// function, tested with synthetic candidates (no exchange adapters involved).
const path = require('path');
const { computeSpreadRows } = require(path.join(__dirname, '..', 'lib', 'spreads.js'));
const marketcap = require(path.join(__dirname, '..', 'lib', 'marketcap.js'));
marketcap.state.rankBySymbol.set('btc', { rank: 1, name: 'Bitcoin', id: 'bitcoin', price: 90000 });

const HOUR = 60 * 60 * 1000;
const now = Date.now();
const THIRTY_DAYS_HOURS = 720;

function buildHistory(stepHours, rate, hoursBack) {
  const rows = [];
  for (let h = hoursBack; h >= 0; h -= stepHours) {
    rows.push({ rate, time: now - h * HOUR });
  }
  return rows; // oldest first
}

(async () => {
  // --- Test 1: a clear, stable, profitable spread between two exchanges ---
  const exA = {
    exchange: 'aster',
    exchangeLabel: 'Aster',
    symbol: 'BTCUSDT',
    baseAsset: 'BTC',
    price: 90000,
    intervalHours: 8,
    fundingRate: 0.001, // current: 0.001/8h -> high positive APR
    openInterestUsd: 5e6,
    nextFundingTime: now + HOUR,
    history: buildHistory(8, 0.001, THIRTY_DAYS_HOURS),
  };
  const exB = {
    exchange: 'hyperliquid',
    exchangeLabel: 'Hyperliquid',
    symbol: 'BTC',
    baseAsset: 'BTC',
    price: 90010,
    intervalHours: 1,
    fundingRate: -0.0001, // current: negative -> good long leg, gets paid too
    openInterestUsd: 8e6,
    nextFundingTime: now + HOUR,
    history: buildHistory(1, -0.0001, THIRTY_DAYS_HOURS),
  };
  // An unrelated third exchange/coin that must NOT produce any row (only one
  // leg for ETH -> nothing to pair against).
  const exC = {
    exchange: 'bybit',
    exchangeLabel: 'Bybit',
    symbol: 'ETHUSDT',
    baseAsset: 'ETH',
    price: 3000,
    intervalHours: 8,
    fundingRate: 0.0005,
    openInterestUsd: 1e6,
    nextFundingTime: now + HOUR,
    history: buildHistory(8, 0.0005, THIRTY_DAYS_HOURS),
  };

  const rows = computeSpreadRows([exA, exB, exC]);
  console.log(`computeSpreadRows(): ${rows.length} row(s)`);
  if (rows.length !== 1) throw new Error(`FAIL: expected exactly 1 spread row, got ${rows.length}`);

  const row = rows[0];

  if (row.baseAsset !== 'BTC') throw new Error(`FAIL: baseAsset ${row.baseAsset}`);
  if (row.shortExchange !== 'aster') throw new Error(`FAIL: expected Aster as short leg (higher rate), got ${row.shortExchange}`);
  if (row.longExchange !== 'hyperliquid') throw new Error(`FAIL: expected Hyperliquid as long leg, got ${row.longExchange}`);
  if (row.marketCapRank !== 1) throw new Error(`FAIL: marketCapRank ${row.marketCapRank}`);

  // Expected current hourly spread: 0.001/8 - (-0.0001) = 0.000225 -> APR = 0.000225 * 8760 * 100
  const expectedSpreadApr = 0.000225 * 8760 * 100;
  if (Math.abs(row.spreadAprPct - expectedSpreadApr) > 0.5) {
    throw new Error(`FAIL: spreadAprPct ${row.spreadAprPct}, expected ~${expectedSpreadApr}`);
  }
  // Constant rates throughout -> the spread never wavers: 100% positive, streak == periods.
  if (row.positiveRatio !== 1) throw new Error(`FAIL: positiveRatio ${row.positiveRatio}, expected 1`);
  if (row.currentStreak !== row.periods) throw new Error(`FAIL: currentStreak ${row.currentStreak} != periods ${row.periods}`);
  if (Math.abs(row.avgAprPct - expectedSpreadApr) > 0.5) {
    throw new Error(`FAIL: avgAprPct ${row.avgAprPct}, expected ~${expectedSpreadApr}`);
  }
  if (Math.abs(row.minAprPct - row.maxAprPct) > 0.01) {
    throw new Error(`FAIL: minAprPct/maxAprPct should match for a constant spread: ${row.minAprPct} vs ${row.maxAprPct}`);
  }
  // ~720 hourly buckets expected (30-day overlap window).
  if (row.periods < 700 || row.periods > 721) throw new Error(`FAIL: periods ${row.periods}, expected ~720`);

  console.log('Test 1 (clear profitable spread) PASS');

  // --- Test 2: direction must follow the 30-day average, not the current tick ---
  // exE's *current* rate is higher than exD's, so a current-rate-based
  // direction pick would wrongly make exE the short leg. But exD averaged
  // higher over the full 30-day window, so exD is the real historically-
  // favorable short side, and the pair should still show up (correctly
  // oriented) rather than being dropped as "unprofitable".
  const exD = {
    exchange: 'okx',
    exchangeLabel: 'OKX',
    symbol: 'SOLUSDT',
    baseAsset: 'SOL',
    price: 200,
    intervalHours: 8,
    fundingRate: 0.0001, // lower current rate...
    openInterestUsd: 1e6,
    nextFundingTime: now + HOUR,
    history: buildHistory(8, 0.0002, THIRTY_DAYS_HOURS), // ...but higher historical average
  };
  const exE = {
    exchange: 'bitget',
    exchangeLabel: 'Bitget',
    symbol: 'SOLUSDT',
    baseAsset: 'SOL',
    price: 200,
    intervalHours: 8,
    fundingRate: 0.00015, // higher current rate...
    openInterestUsd: 1e6,
    nextFundingTime: now + HOUR,
    history: buildHistory(8, 0.00005, THIRTY_DAYS_HOURS), // ...but lower historical average
  };
  const rows2 = computeSpreadRows([exD, exE]);
  console.log(`Test 2: ${rows2.length} row(s)`);
  if (rows2.length !== 1) throw new Error(`FAIL: expected exactly 1 row (correctly re-oriented), got ${rows2.length}`);
  const row2 = rows2[0];
  if (row2.shortExchange !== 'okx') throw new Error(`FAIL: expected OKX (higher historical average) as short, got ${row2.shortExchange}`);
  if (row2.longExchange !== 'bitget') throw new Error(`FAIL: expected Bitget as long, got ${row2.longExchange}`);
  // Historical hourly spread: 0.0002/8 - 0.00005/8 = 0.00001875 -> APR
  const expectedAvgApr2 = 0.00001875 * 8760 * 100;
  if (Math.abs(row2.avgAprPct - expectedAvgApr2) > 0.5) {
    throw new Error(`FAIL: avgAprPct ${row2.avgAprPct}, expected ~${expectedAvgApr2}`);
  }
  // Current-tick spread is in the *opposite* direction from the historical
  // average (exE's current rate is actually higher) — shown as a negative
  // spreadAprPct rather than hidden, since short/long stays fixed by history.
  if (row2.spreadAprPct >= 0) {
    throw new Error(`FAIL: expected a negative current-tick spreadAprPct (reversal vs. the historical norm), got ${row2.spreadAprPct}`);
  }
  console.log('Test 2 (direction follows historical average, not current tick) PASS');

  // --- Test 3: a pair with no edge either way (identical rates) must be dropped ---
  const exF = {
    exchange: 'kucoin',
    exchangeLabel: 'KuCoin',
    symbol: 'ADAUSDT',
    baseAsset: 'ADA',
    price: 0.5,
    intervalHours: 8,
    fundingRate: 0.0001,
    openInterestUsd: 1e6,
    nextFundingTime: now + HOUR,
    history: buildHistory(8, 0.0001, THIRTY_DAYS_HOURS),
  };
  const exG = {
    exchange: 'gate',
    exchangeLabel: 'Gate.io',
    symbol: 'ADAUSDT',
    baseAsset: 'ADA',
    price: 0.5,
    intervalHours: 8,
    fundingRate: 0.0001,
    openInterestUsd: 1e6,
    nextFundingTime: now + HOUR,
    history: buildHistory(8, 0.0001, THIRTY_DAYS_HOURS), // identical to exF throughout
  };
  const rows3 = computeSpreadRows([exF, exG]);
  console.log(`Test 3: identical-rate pair -> ${rows3.length} row(s)`);
  if (rows3.length !== 0) throw new Error(`FAIL: expected a pair with zero average edge to be dropped, got ${rows3.length}`);
  console.log('Test 3 (no-edge pair dropped) PASS');

  console.log('ALL PASS');
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

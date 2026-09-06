// Pure helper functions: symbol normalization, annualization, history-based stability stats.

// Longest suffixes first — KuCoin futures symbols end in "USDTM" (e.g. XBTUSDTM),
// which would otherwise get caught by a bare "USDT" check applied in the wrong order.
const QUOTE_SUFFIXES = ['_USDT', '_USDC', '-USDT-SWAP', '-USDT', '-USDC', '-USD', 'USDTM', 'USDT', 'USDC'];

// A handful of exchanges use a legacy/alternate ticker for the same coin.
const TICKER_ALIASES = { XBT: 'BTC' };

// Cheap coins are often quoted in bulk units, and exchanges disagree on how to
// spell that: Bybit lists 1000PEPE, Pacifica kPEPE, others 1MPEPE. Folding
// them onto the underlying coin is what lets the UI match them across
// exchanges and look up a market-cap rank at all.
//
// The "k" form is always written lowercase (kPEPE, kBONK, kSHIB), which is
// what keeps KAITO from being read as 1000x "AITO".
const MULTIPLIER_PREFIXES = [
  [/^1000000(?=[A-Z]{2,})/, 1e6],
  [/^1M(?=[A-Z]{2,})/, 1e6],
  [/^1000(?=[A-Z]{2,})/, 1e3],
  [/^k(?=[A-Z]{2,})/, 1e3],
];

// Tickers that merely look like they carry a multiplier prefix.
const NOT_MULTIPLIERS = new Set(['1000SATS']);

// "1000PEPEUSDT" -> { base: "PEPE", multiplier: 1000 }. The multiplier matters
// when comparing an exchange's quoted price against the coin's own price:
// 1000PEPE trades at 1000x what PEPE does.
function splitSymbol(symbol) {
  let base = symbol;
  for (const suf of QUOTE_SUFFIXES) {
    if (base.endsWith(suf)) {
      base = base.slice(0, -suf.length);
      break;
    }
  }

  let multiplier = 1;
  if (!NOT_MULTIPLIERS.has(base.toUpperCase())) {
    for (const [prefix, factor] of MULTIPLIER_PREFIXES) {
      if (prefix.test(base)) {
        base = base.replace(prefix, '');
        multiplier = factor;
        break;
      }
    }
  }

  return { base: TICKER_ALIASES[base] || base, multiplier };
}

// "BTC_USDT" / "BTCUSDT" / "XBTUSDTM" -> "BTC" (lets the UI compare/search the same coin across exchanges)
function baseAsset(symbol) {
  return splitSymbol(symbol).base;
}

function annualizedPct(rate, intervalHours) {
  if (!intervalHours || !Number.isFinite(rate)) return null;
  const periodsPerYear = 8760 / intervalHours; // 24 * 365
  return rate * periodsPerYear * 100;
}

// history: array of { rate, time }, oldest first.
function historyStats(history) {
  if (!history || history.length === 0) {
    return {
      periods: 0,
      positiveCount: 0,
      positiveRatio: null,
      minRate: null,
      maxRate: null,
      avgRate: null,
      currentStreak: 0,
    };
  }

  const rates = history.map((h) => h.rate);
  const positiveCount = rates.filter((r) => r > 0).length;
  const minRate = Math.min(...rates);
  const maxRate = Math.max(...rates);
  const avgRate = rates.reduce((a, b) => a + b, 0) / rates.length;

  // history is oldest-first; walk backwards from the newest entry to find the current streak.
  let currentStreak = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].rate > 0) currentStreak++;
    else break;
  }

  return {
    periods: history.length,
    positiveCount,
    positiveRatio: positiveCount / history.length,
    minRate,
    maxRate,
    avgRate,
    currentStreak,
  };
}

module.exports = { baseAsset, splitSymbol, annualizedPct, historyStats };

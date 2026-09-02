// Pure helper functions: symbol normalization, annualization, history-based stability stats.

// Longest suffixes first — KuCoin futures symbols end in "USDTM" (e.g. XBTUSDTM),
// which would otherwise get caught by a bare "USDT" check applied in the wrong order.
const QUOTE_SUFFIXES = ['_USDT', '_USDC', '-USDT', '-USDC', '-PERP', 'USDTM', 'USDT', 'USDC'];

// A handful of exchanges use a legacy/alternate ticker for the same coin.
const TICKER_ALIASES = { XBT: 'BTC' };

// "BTC_USDT" / "BTCUSDT" / "XBTUSDTM" -> "BTC" (lets the UI compare/search the same coin across exchanges)
function baseAsset(symbol) {
  for (const suf of QUOTE_SUFFIXES) {
    if (symbol.endsWith(suf)) {
      const base = symbol.slice(0, -suf.length);
      return TICKER_ALIASES[base] || base;
    }
  }
  return symbol;
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

module.exports = { baseAsset, annualizedPct, historyStats };

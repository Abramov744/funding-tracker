// Tells real cryptocurrencies apart from tokenized stocks/commodities/forex.
//
// Newer perp DEXes (Lighter, Orderly, GRVT, ...) list AAPL, TSLA, EURUSD and
// XAU as ordinary perpetuals, side by side with BTC and SOL, and expose no
// field that says which is which — contract kind, asset class, venue list and
// settlement period all read identically for both. Those markets are useless
// for this scanner's spot+short strategy: their funding is a flat exchange
// carry fee rather than a market-driven rate (on Orderly, 88% of them sit in a
// narrow band around the baseline and only 2% ever go negative, against 16%
// and 16% for real coins), most trade no volume at all (63% of them did zero
// over 24h), and the spot leg would be a brokerage share that can't be hedged
// overnight or over a weekend. Left in, they'd also score perfectly on every
// metric this scanner ranks by and crowd out the real opportunities.
//
// Classification therefore leans on CoinGecko's coin list, which the app
// already fetches for market-cap ranks, plus a price sanity check. Measured
// against real API dumps: 75/75 on Pacifica (which does publish a reliable
// flag of its own, so it could serve as ground truth) and 132/138 on Orderly,
// with zero stocks let through in either — every miss was a low-cap coin
// outside CoinGecko's top 1500, which is a poor strategy candidate anyway.
const marketcap = require('./marketcap');
const { splitSymbol } = require('./metrics');

// Below this the CoinGecko map is too thin to classify against (a rate-limited
// refresh, or a boot where every page 429'd). Callers surface an error rather
// than quietly emptying an exchange or waving stocks through.
const MIN_USABLE_MAP_SIZE = 100;

// A perp's mark price must land within this factor of CoinGecko's price for
// the same ticker. Catches ticker collisions in both directions: exchanges
// list META as Meta Platforms (~$600) while CoinGecko's "meta" is MetaDAO
// (~$5), and NOW/ADI/MET/ROBO/EWT collide the same way. The band is wide
// because the two prices are sampled at different moments (ranks refresh
// hourly) — it only needs to separate order-of-magnitude mismatches.
const PRICE_BAND = 2;

function isMapUsable() {
  return marketcap.size() >= MIN_USABLE_MAP_SIZE;
}

// True when `symbol` names a real cryptocurrency. `price` is the exchange's
// mark price and is optional — without it only the ticker is checked, which
// still rejects outright stock/forex/commodity tickers but can't catch a
// collision, so pass it whenever the exchange gives one.
function isCrypto(symbol, price) {
  if (!symbol) return false;
  // Case is load-bearing: the bulk-unit prefix in kPEPE is lowercase, which is
  // what separates it from tickers that merely start with a capital K.
  const { base, multiplier } = splitSymbol(String(symbol));

  const entry = marketcap.lookupEntry(base);
  if (!entry) return false; // not a coin CoinGecko ranks (tokenized-equity wrappers are dropped there)

  if (!Number.isFinite(price) || price <= 0 || !entry.price) return true; // nothing to cross-check against
  const ratio = price / multiplier / entry.price;
  return ratio >= 1 / PRICE_BAND && ratio <= PRICE_BAND;
}

// Keeps only the crypto markets. Throws (rather than returning an empty list)
// when the CoinGecko map isn't loaded enough to judge — an exchange that goes
// silently empty is the harder failure to notice, so it surfaces as an error
// banner instead.
function filterToCrypto(rows, { exchange, symbolOf, priceOf }) {
  if (!isMapUsable()) {
    throw new Error(
      `${exchange}: CoinGecko map unavailable (${marketcap.size()} coins) — cannot separate crypto from tokenized stocks`
    );
  }
  return rows.filter((row) => isCrypto(symbolOf(row), priceOf(row)));
}

module.exports = { isCrypto, filterToCrypto, isMapUsable, PRICE_BAND };

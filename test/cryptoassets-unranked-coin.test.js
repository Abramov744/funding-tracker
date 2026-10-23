// Verifies the unranked-coin fallback added to isCrypto(): a ticker outside
// marketcap.js's top-1500-by-market-cap map must no longer read identically
// to a ticker CoinGecko has never heard of at all. It should fall through to
// lib/rwaCoinList.js's full coin list (any rank) minus its own RWA list, and
// get rescued there — unless it's actually one of the tokenized stocks/ETFs/
// commodities that fallback exists to keep excluded.
const path = require('path');
const marketcap = require(path.join(__dirname, '..', 'lib', 'marketcap.js'));
const rwaCoinList = require(path.join(__dirname, '..', 'lib', 'rwaCoinList.js'));
const cryptoassets = require(path.join(__dirname, '..', 'lib', 'cryptoassets.js'));

// Clean slate: neither map has this test's tickers yet.
marketcap.state.rankBySymbol.clear();
rwaCoinList.state.coinSymbols.clear();
rwaCoinList.state.rwaSymbols.clear();

// Case 1: unranked, and the full coin/RWA lists haven't loaded at all —
// must fail closed, exactly like today's behavior, not silently wave
// anything through just because the fallback exists.
if (cryptoassets.isCrypto('FAKEALTUSDT', 1.23)) {
  throw new Error('FAIL: an unrecognized ticker must stay rejected when neither list is loaded');
}

// Case 2: a genuine low-cap alt — never ranked in the top 1500, but present
// in CoinGecko's full coin list and NOT in its RWA list. This is the actual
// gap being fixed: it used to be indistinguishable from "not a coin".
rwaCoinList.state.coinSymbols.add('fakealt');
if (!cryptoassets.isCrypto('FAKEALTUSDT', 1.23)) {
  throw new Error('FAIL: a real low-cap coin outside the top-1500 map should be rescued by the full-list fallback');
}

// Case 3: a tokenized-stock ticker that also happens to be in the full coin
// list (as it would be — CoinGecko tracks RWAs as coin-like entries too)
// must still be excluded, because it's also in the RWA list.
rwaCoinList.state.coinSymbols.add('aapl');
rwaCoinList.state.rwaSymbols.add('aapl');
if (cryptoassets.isCrypto('AAPLUSDT', 230)) {
  throw new Error('FAIL: a ticker on the RWA list must stay excluded even though it is in the full coin list too');
}

// Case 4: once marketcap.js has a ranked entry for a ticker, that path
// governs regardless of what the unranked fallback would have said — a bad
// price-collision ratio must still reject it, even if the base ticker also
// happens to sit in the full coin list (it will, since the ranked map is a
// subset of it in practice).
rwaCoinList.state.coinSymbols.add('meta');
marketcap.state.rankBySymbol.set('meta', { rank: 9999, name: 'MetaDAO', id: 'metadao', price: 5 });
if (cryptoassets.isCrypto('METAUSDT', 600)) {
  throw new Error('FAIL: a ranked entry with a failing price-collision check must not be rescued by the fallback');
}

console.log('ALL PASS');

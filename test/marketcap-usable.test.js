// Verifies the bootstrap-retry gap fix: previously the retry only fired when
// the map was EXACTLY empty (size === 0), leaving a silent gap where a
// partial fetch (1..99 coins) left the map below the 100-coin usability bar
// but never triggered a retry, stranding it there for up to an hour.
const path = require('path');
const marketcap = require(path.join(__dirname, '..', 'lib', 'marketcap.js'));
const cryptoassets = require(path.join(__dirname, '..', 'lib', 'cryptoassets.js'));

// Empty map: not usable (both old and new logic agree here).
if (marketcap.isUsable()) throw new Error('FAIL: empty map should not be usable');
if (cryptoassets.isMapUsable()) throw new Error('FAIL: cryptoassets should delegate to the same threshold');

// Partial map (50 coins, below the 100 threshold): this is the exact gap —
// old bootstrap condition (`size === 0`) would NOT have retried here, since
// size is 50, not 0. New condition (`!isUsable()`) must still say "retry".
for (let i = 0; i < 50; i++) {
  marketcap.state.rankBySymbol.set(`coin${i}`, { rank: i + 1, name: `Coin ${i}`, id: `coin${i}`, price: 1 });
}
if (marketcap.size() !== 50) throw new Error(`FAIL: expected size 50, got ${marketcap.size()}`);
if (marketcap.isUsable()) throw new Error('FAIL: 50 coins should still be below the usability threshold');
if (cryptoassets.isMapUsable()) throw new Error('FAIL: cryptoassets should agree the map is still unusable at 50');
// This is the actual bug being fixed: old code checked `size === 0`, which is
// false here even though the map is genuinely unusable.
if (marketcap.size() === 0) throw new Error('FAIL (test bug): size should be 50, not 0, to actually exercise the gap');

// Fill past the threshold: now usable.
for (let i = 50; i < 120; i++) {
  marketcap.state.rankBySymbol.set(`coin${i}`, { rank: i + 1, name: `Coin ${i}`, id: `coin${i}`, price: 1 });
}
if (!marketcap.isUsable()) throw new Error('FAIL: 120 coins should clear the usability threshold');
if (!cryptoassets.isMapUsable()) throw new Error('FAIL: cryptoassets should agree the map is usable at 120');

console.log('ALL PASS');

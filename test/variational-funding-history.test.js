// No-network test for lib/variationalFundingHistory.js — Variational Omni's
// public API has no history endpoint at all (see lib/exchanges/variational.js's
// comments), so this module reconstructs funding history itself by watching
// each market's funding-period boundary (nextFundingTime) roll over between
// polls. Verifies the period-crossing detection, that it records the
// PREVIOUS rate/timestamp (not the new one), and that it survives a
// simulated process restart (reload from disk).
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'variational-history-test-'));
process.env.RAILWAY_VOLUME_MOUNT_PATH = tmpDir;

const storePath = path.join(__dirname, '..', 'lib', 'variationalFundingHistory.js');

function freshStore() {
  delete require.cache[require.resolve(storePath)];
  return require(storePath);
}

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('PASS:', msg);
}

(async () => {
  let store = freshStore();

  const period1End = Date.now() + 150; // short enough to actually wait past it below
  store.recordObservation('BTC-PERP', { rate: 0.0001, nextFundingTime: period1End });
  store.flush();
  assert(store.getHistory('BTC-PERP').length === 0, 'no history point after the very first observation (no prior cursor)');

  store.recordObservation('BTC-PERP', { rate: 0.0001, nextFundingTime: period1End });
  store.flush();
  assert(store.getHistory('BTC-PERP').length === 0, 'no history point while the funding boundary has not been crossed yet');

  await new Promise((resolve) => setTimeout(resolve, Math.max(0, period1End - Date.now() + 20)));

  const period2End = period1End + 60 * 1000;
  store.recordObservation('BTC-PERP', { rate: 0.00015, nextFundingTime: period2End });
  store.flush();
  const h1 = store.getHistory('BTC-PERP');
  assert(h1.length === 1, 'exactly one history point recorded after crossing the first boundary');
  assert(h1[0].rate === 0.0001, 'recorded point uses the PREVIOUS rate, not the new one just observed');
  assert(h1[0].time === period1End, 'recorded point uses the settlement timestamp, not the observation time');

  store.recordObservation('BTC-PERP', { rate: 0.00015, nextFundingTime: period2End });
  store.flush();
  assert(store.getHistory('BTC-PERP').length === 1, 'repeated observation before the next boundary adds no new point');

  store = freshStore(); // simulates a process restart: module re-required, state rebuilt from disk
  const h2 = store.getHistory('BTC-PERP');
  assert(h2.length === 1 && h2[0].rate === 0.0001, 'history survives a reload from disk');

  assert(store.getHistory('BTC-PERP', 0).length === 0, 'limit=0 returns an empty slice, not the full array (slice(-0) pitfall)');
  assert(store.getHistory('UNKNOWN-PERP').length === 0, 'unknown symbol returns an empty array, not an error');

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('ALL PASS');
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

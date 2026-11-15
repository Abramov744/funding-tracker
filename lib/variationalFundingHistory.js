// Compatibility wrapper for callers/tests that used the previous
// Variational-specific API. The implementation and storage now live in the
// exchange-agnostic fundingHistory module.
const storePath = require.resolve('./fundingHistory');
delete require.cache[storePath];
const fundingHistory = require(storePath);

module.exports = {
  recordObservation(symbol, observation) {
    return fundingHistory.recordObservation('variational', symbol, observation);
  },
  flush: fundingHistory.flush,
  getHistory(symbol, limit) {
    return fundingHistory.getHistory('variational', symbol, limit);
  },
};

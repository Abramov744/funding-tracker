// Central registry of exchange adapters, keyed by id — shared by the cache
// (bulk refresh) and the server (on-demand per-symbol history lookups).
const aster = require('./aster');
const mexc = require('./mexc');
const gate = require('./gate');
const kucoin = require('./kucoin');
const bybit = require('./bybit');
const bingx = require('./bingx');

const EXCHANGES = [aster, mexc, gate, kucoin, bybit, bingx];
const byId = new Map(EXCHANGES.map((ex) => [ex.id, ex]));

module.exports = { EXCHANGES, byId };

// Central registry of exchange adapters, keyed by id — shared by the cache
// (bulk refresh) and the server (on-demand per-symbol history lookups).
const aster = require('./aster');
const mexc = require('./mexc');
const gate = require('./gate');
const kucoin = require('./kucoin');
const bybit = require('./bybit');
const paradex = require('./paradex');

const EXCHANGES = [aster, mexc, gate, kucoin, bybit, paradex];
const byId = new Map(EXCHANGES.map((ex) => [ex.id, ex]));

module.exports = { EXCHANGES, byId };

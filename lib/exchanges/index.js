// Central registry of exchange adapters, keyed by id — shared by the cache
// (bulk refresh) and the server (on-demand per-symbol history lookups).
const aster = require('./aster');
const mexc = require('./mexc');
const ourbit = require('./ourbit');
const gate = require('./gate');
const kucoin = require('./kucoin');
const bybit = require('./bybit');
const bingx = require('./bingx');
const okx = require('./okx');
const hyperliquid = require('./hyperliquid');
const dydx = require('./dydx');
const edgex = require('./edgex');
const pacifica = require('./pacifica');
const lighter = require('./lighter');
const grvt = require('./grvt');
const paradex = require('./paradex');
const bitget = require('./bitget');
const bitfinex = require('./bitfinex');
const extended = require('./extended');
const orderly = require('./orderly');
const htx = require('./htx');
const phemex = require('./phemex');
const gmx = require('./gmx'); // kept for now, intentionally excluded from the active scanner registry
const rise = require('./rise');
const variational = require('./variational');
const lbank = require('./lbank');
const blofin = require('./blofin');
const bitunix = require('./bitunix');
const toobit = require('./toobit');
const xt = require('./xt');

const EXCHANGES = [aster, mexc, ourbit, gate, kucoin, bybit, bingx, okx, hyperliquid, dydx, edgex, pacifica, lighter, grvt, paradex, bitget, bitfinex, extended, orderly, htx, phemex, rise, variational, lbank, blofin, bitunix, toobit, xt];
const byId = new Map(EXCHANGES.map((ex) => [ex.id, ex]));

module.exports = { EXCHANGES, byId };

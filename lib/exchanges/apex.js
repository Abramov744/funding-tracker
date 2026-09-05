// ApeX Omni — perpetual DEX, public REST API, no key needed for market data.
// The docs site (https://api-docs.omni.apex.exchange/) isn't reachable from
// here, so these endpoints/fields are confirmed against the official Node
// connector's source instead: https://github.com/ApeX-Protocol/apexomni-connector-node
const BASE = 'https://omni.apex.exchange';
const INTERVAL_HOURS = 1; // ApeX Omni settles funding hourly (most CEXs use 8h)

async function getJson(path) {
  const res = await fetch(BASE + path, { headers: { 'User-Agent': 'funding-tracker/1.0' } });
  if (!res.ok) throw new Error(`ApeX ${path} -> HTTP ${res.status}`);
  return res.json();
}

// Some exchange APIs (this one included, going by convention elsewhere in
// ApeX's stack) wrap the payload in { data: ... }; others return the array
// directly. Accept either shape rather than guessing wrong and crashing.
function unwrapList(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  return [];
}

// The ticker and history-funding endpoints disagree on symbol format: ticker
// uses the concatenated form ("BTCUSDT"), history-funding wants it hyphenated
// ("BTC-USDT"). Every Omni perpetual is USDT-margined, so this just splits
// before the trailing USDT.
function toHyphenatedSymbol(symbol) {
  return symbol.endsWith('USDT') ? `${symbol.slice(0, -4)}-USDT` : symbol;
}

// Returns current funding snapshot for every USDT-margined perpetual.
// Omitting `symbol` is expected to return every ticker in one call — the
// connector's own tickers() method always types its result as an array, even
// though its `symbol` parameter isn't marked optional there.
async function fetchCurrent() {
  const rows = unwrapList(await getJson('/api/v3/ticker'));

  return rows
    .filter((t) => t && typeof t.symbol === 'string' && t.symbol.endsWith('USDT'))
    .map((t) => ({
      exchange: 'apex',
      symbol: t.symbol,
      fundingRate: Number(t.fundingRate),
      intervalHours: INTERVAL_HOURS,
      nextFundingTime: Number(t.nextFundingTime) || null,
      price: Number(t.oraclePrice) || Number(t.lastPrice) || null,
    }))
    .filter((row) => Number.isFinite(row.fundingRate));
}

// Returns the last `limit` funding-rate settlements for one symbol, oldest first.
async function fetchHistory(symbol, limit = 200) {
  const hyphenated = toHyphenatedSymbol(symbol);
  const rows = unwrapList(
    await getJson(`/api/v3/history-funding?symbol=${encodeURIComponent(hyphenated)}&limit=${limit}`)
  );

  return rows
    .map((r) => {
      const rate = Number(r.rate);
      let time = Number(r.fundingTimestamp ?? r.fundingTime);
      if (Number.isFinite(time) && time > 0 && time < 1e12) time *= 1000; // some timestamps come back in seconds
      return { rate, time };
    })
    .filter((r) => Number.isFinite(r.rate) && Number.isFinite(r.time))
    .sort((a, b) => a.time - b.time)
    .slice(-limit);
}

module.exports = { id: 'apex', label: 'ApeX', fetchCurrent, fetchHistory };

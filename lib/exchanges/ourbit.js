// Ourbit — USDT-margined perpetual futures, public market data, no API key
// needed. Its futures API is a byte-for-byte match of MEXC's own contract API
// (same base paths, same field names — confirmed live: /api/v1/contract/detail,
// /api/v1/contract/ticker, /api/v1/contract/funding_rate/{symbol} and
// /api/v1/contract/funding_rate/history all return identical shapes to MEXC's),
// so this adapter mirrors lib/exchanges/mexc.js almost exactly.
const BASE = 'https://futures.ourbit.com';

async function getJson(path) {
  const res = await fetch(BASE + path, { headers: { 'User-Agent': 'funding-tracker/1.0' } });
  if (!res.ok) throw new Error(`Ourbit ${path} -> HTTP ${res.status}`);
  const body = await res.json();
  if (body.success === false) throw new Error(`Ourbit ${path} -> ${body.code}`);
  return body.data;
}

// Unlike MEXC, Ourbit's contract list also carries ~230 tokenized stocks,
// ETFs, commodities, metals and forex pairs (AAPL, SPY, XAU, EUR, even
// ANTHROPIC/OPENAI as pre-IPO speculation — same handful seen on Lighter/
// GRVT/Pacifica) under the same USDT-margined "perpetual" contracts. Each
// instrument carries an explicit conceptPlate tag array for its trading
// "zone" — confirmed on a real 757-contract dump that every non-crypto
// instrument carries at least one of the eight root tags below (e.g.
// AAPL/GOOGL/TSLA: ob_trade_zone_stock; XAU: ob_trade_zone_commodities;
// EUR: ob_trade_zone_forex), while every real crypto coin either has an
// empty conceptPlate or a crypto-only tag (meme/defi/infra/...). A handful
// of secondary tags (preipo, robinhood, private_technology) are NOT used
// here because they also appear alone on genuine crypto tokens (e.g.
// POLYMARKET_USDT: preipo+web3, no stock tag; CASHCAT_USDT: meme+robinhood)
// — only instruments additionally carrying one of these root tags get
// excluded, which still catches ANTHROPIC_USDT/OPENAI_USDT (tagged
// preipo+stock+private_technology) correctly.
const RWA_CONCEPT_TAGS = new Set([
  'ob_trade_zone_stock',
  'ob_trade_zone_hk_stocks',
  'ob_trade_zone_tw_stocks',
  'ob_trade_zone_stock_indices',
  'ob_trade_zone_etf',
  'ob_trade_zone_commodities',
  'ob_trade_zone_metals',
  'ob_trade_zone_forex',
]);

function isRwaTagged(detail) {
  return (detail.conceptPlate || []).some((tag) => RWA_CONCEPT_TAGS.has(tag));
}

// Returns current funding snapshot for every active, non-RWA USDT-margined
// perpetual on Ourbit.
async function fetchCurrent() {
  const [details, tickers] = await Promise.all([getJson('/api/v1/contract/detail'), getJson('/api/v1/contract/ticker')]);

  const activeSymbols = new Set(
    (details || [])
      .filter((d) => d.state === 0 && d.quoteCoin === 'USDT' && d.apiAllowed !== false && !isRwaTagged(d))
      .map((d) => d.symbol)
  );
  const contractSizeBySymbol = new Map((details || []).map((d) => [d.symbol, Number(d.contractSize)]));

  const list = Array.isArray(tickers) ? tickers : [tickers];

  return list
    .filter((t) => activeSymbols.has(t.symbol) && t.fundingRate !== undefined && t.fundingRate !== null)
    .map((t) => {
      const price = Number(t.fairPrice ?? t.lastPrice) || null;
      const contractSize = contractSizeBySymbol.get(t.symbol);
      return {
        exchange: 'ourbit',
        symbol: t.symbol,
        fundingRate: Number(t.fundingRate),
        intervalHours: null, // fetched lazily per-symbol only for shortlisted candidates, see fetchIntervalHours
        nextFundingTime: null,
        price,
        // holdVol is a raw contract count, not a base-asset quantity —
        // contractSize (from the same /contract/detail call already fetched
        // above, no extra request) converts contracts to base-asset units.
        // Same convention as MEXC (confirmed on a real BTC_USDT sample:
        // holdVol=1,095,906 contracts * contractSize=0.0001 BTC/contract *
        // fairPrice ≈ $89.4M, a plausible single-market OI figure).
        openInterestUsd: price && contractSize ? Number(t.holdVol) * contractSize * price : null,
        // amount24 is already USDT-denominated 24h volume, distinct from the
        // base-unit volume24 field — same convention as MEXC, confirmed on a
        // real BTC_USDT sample: amount24=4,543,185,596.3835.
        volume24hUsd: Number(t.amount24) || null,
      };
    });
}

// collectCycle (funding interval in hours) is only available on the per-symbol endpoint.
async function fetchIntervalHours(symbol) {
  const data = await getJson(`/api/v1/contract/funding_rate/${encodeURIComponent(symbol)}`);
  return { intervalHours: data.collectCycle, nextFundingTime: data.nextSettleTime };
}

// Returns the last `limit` funding-rate settlements for one symbol, oldest first.
async function fetchHistory(symbol, limit = 100) {
  const data = await getJson(
    `/api/v1/contract/funding_rate/history?symbol=${encodeURIComponent(symbol)}&page_num=1&page_size=${limit}`
  );
  const rows = (data && data.resultList) || [];
  return rows.map((r) => ({ rate: Number(r.fundingRate), time: r.settleTime })).reverse(); // API returns newest-first
}

module.exports = { id: 'ourbit', label: 'Ourbit', fetchCurrent, fetchHistory, fetchIntervalHours };

// edgeX — perpetual DEX offering both crypto perpetuals and tokenized
// stocks/RWA. Public REST API, no key needed. Base URL and endpoints
// confirmed against the official Python SDK source (the docs site,
// edgex-1.gitbook.io, isn't reachable from here) and real response samples:
// https://github.com/edgex-Tech/edgex-python-sdk
const BASE = 'https://edgex-prod-v2.edgex.exchange';

async function getJson(path) {
  const res = await fetch(BASE + path, { headers: { 'User-Agent': 'funding-tracker/1.0' } });
  if (!res.ok) throw new Error(`edgeX ${path} -> HTTP ${res.status}`);
  const body = await res.json();
  if (body.code !== 'SUCCESS') throw new Error(`edgeX ${path} -> ${body.code} ${body.msg || ''}`);
  return body.data;
}

// contractId -> contractName ("BTCUSDC" etc), populated by fetchCurrent() and
// reused by fetchHistory() — the history endpoint only accepts the numeric
// contractId, not the display symbol.
let contractIdBySymbol = new Map();

// Returns current funding snapshot for every tradable crypto perpetual.
// edgeX's metadata also lists ~90 tokenized-stock/RWA "contracts" alongside
// the crypto ones (isStock: true) — excluded here, this scanner is crypto-only.
// Unlike ApeX/OKX, edgeX's current-funding endpoint accepts a comma-joined
// list of contract IDs, so this fetches every contract in a single request
// instead of fanning out one call per symbol.
async function fetchCurrent() {
  const config = await getJson('/api/v2/public/meta/getMetaData');
  const contracts = ((config && config.contractList) || []).filter((c) => c.enableTrade && !c.isStock);
  if (!contracts.length) return [];

  const nameById = new Map(contracts.map((c) => [c.contractId, c.contractName]));
  contractIdBySymbol = new Map(contracts.map((c) => [c.contractName, c.contractId]));

  const ids = contracts.map((c) => c.contractId).join(',');
  const tickers = await getJson(`/api/v2/public/funding/getLatestFundingRate?contractId=${encodeURIComponent(ids)}`);

  // Open interest lives on a separate 24h-ticker endpoint, not the funding
  // one. contractId is documented as a plain string here (not array[string]
  // like getLatestFundingRate's), so a comma-joined list isn't confirmed to
  // work — omitting it entirely returns every contract in one call instead,
  // same bulk shape as getMetaData. OI is a nice-to-have: if this call fails
  // funding rows must still come through, just with openInterestUsd: null.
  let oiByContractId = new Map();
  try {
    const quotes = await getJson('/api/v2/public/quote/getTicker');
    // TEMP DIAGNOSTIC: raw shape of the omitted-contractId response — remove
    // once the real field/array shape is confirmed against production.
    console.log(
      'edgeX: getTicker raw ->',
      JSON.stringify(quotes).slice(0, 500)
    );
    for (const q of Array.isArray(quotes) ? quotes : []) {
      const oi = Number(q.openInterest);
      if (q.contractId && Number.isFinite(oi)) oiByContractId.set(q.contractId, oi);
    }
  } catch (err) {
    console.error('edgeX: open-interest fetch failed —', err.message || err);
  }
  // Endpoint behavior (bulk-without-contractId, field shape) was inferred
  // from docs/SDK source rather than a live response — log coverage once per
  // refresh so a format change or partial response shows up in the deploy
  // logs instead of silently degrading to nulls.
  console.log(`edgeX: OI available for ${oiByContractId.size}/${contracts.length} contracts`);

  return (Array.isArray(tickers) ? tickers : [])
    .map((t) => {
      const symbol = nameById.get(t.contractId);
      if (!symbol) return null;

      const intervalMin = Number(t.fundingRateIntervalMin);
      const intervalHours = intervalMin > 0 ? intervalMin / 60 : null;
      // t.fundingTime is the *last* settlement mark, not the next one (it's
      // also what shows up as the most recent isSettlement:true row in
      // fetchHistory) — the actual next funding time is one interval later.
      const lastFundingTime = Number(t.fundingTime);
      const nextFundingTime =
        Number.isFinite(lastFundingTime) && intervalHours ? lastFundingTime + intervalHours * 60 * 60 * 1000 : null;
      const price = Number(t.markPrice) || Number(t.oraclePrice) || Number(t.indexPrice) || null;

      // openInterest is base-asset units (e.g. BTC, not USD), same convention
      // as this exchange's other size fields — needs multiplying by price.
      const oiBase = oiByContractId.get(t.contractId);
      const openInterestUsd = price && oiBase !== undefined ? oiBase * price : null;

      return {
        exchange: 'edgex',
        symbol,
        fundingRate: Number(t.fundingRate),
        intervalHours,
        nextFundingTime,
        price,
        openInterestUsd,
      };
    })
    .filter((r) => r && Number.isFinite(r.fundingRate));
}

const HISTORY_PAGE_SIZE = 100;
const HISTORY_MAX_PAGES = 10; // safety cap regardless of how large `limit` is

// Returns the last `limit` *settled* funding events for one symbol, oldest
// first. Without filterSettlementFundingRate, this endpoint instead returns
// once-a-minute premium-index snapshots leading up to the next settlement
// (all sharing the same fundingTime/fundingRate) rather than real history —
// the filter is required to get actual past settlements.
async function fetchHistory(symbol, limit = 200) {
  const contractId = contractIdBySymbol.get(symbol);
  if (!contractId) throw new Error(`edgeX: unknown contractId for symbol ${symbol}`);

  const raw = [];
  let offsetData;

  for (let page = 0; page < HISTORY_MAX_PAGES && raw.length < limit; page++) {
    const qs = new URLSearchParams({
      contractId,
      size: String(HISTORY_PAGE_SIZE),
      filterSettlementFundingRate: 'true',
    });
    if (offsetData) qs.set('offsetData', offsetData);

    const result = await getJson(`/api/v2/public/funding/getFundingRatePage?${qs.toString()}`);
    const rows = (result && result.dataList) || [];
    if (!rows.length) break;

    for (const r of rows) raw.push({ rate: Number(r.fundingRate), time: Number(r.fundingTime) });

    if (rows.length < HISTORY_PAGE_SIZE || !result.nextPageOffsetData) break;
    offsetData = result.nextPageOffsetData;
  }

  return raw
    .filter((r) => Number.isFinite(r.rate) && Number.isFinite(r.time))
    .sort((a, b) => a.time - b.time)
    .slice(-limit);
}

module.exports = { id: 'edgex', label: 'edgeX', fetchCurrent, fetchHistory };

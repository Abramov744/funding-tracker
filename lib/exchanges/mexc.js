// MEXC contract (futures) — public market data, no API key needed.
// Docs: https://mexcdevelop.github.io/apidocs/contract_v1_en/
const BASE = 'https://contract.mexc.com';

async function getJson(path) {
  const res = await fetch(BASE + path, { headers: { 'User-Agent': 'funding-tracker/1.0' } });
  if (!res.ok) throw new Error(`MEXC ${path} -> HTTP ${res.status}`);
  const body = await res.json();
  if (body.success === false) throw new Error(`MEXC ${path} -> ${body.code}`);
  return body.data;
}

// Returns current funding snapshot for every active USDT-margined perpetual on MEXC.
async function fetchCurrent() {
  const [details, tickers] = await Promise.all([getJson('/api/v1/contract/detail'), getJson('/api/v1/contract/ticker')]);

  const activeSymbols = new Set(
    (details || []).filter((d) => d.state === 0 && d.quoteCoin === 'USDT' && d.apiAllowed !== false).map((d) => d.symbol)
  );
  const contractSizeBySymbol = new Map((details || []).map((d) => [d.symbol, Number(d.contractSize)]));

  const list = Array.isArray(tickers) ? tickers : [tickers];

  return list
    .filter((t) => activeSymbols.has(t.symbol) && t.fundingRate !== undefined && t.fundingRate !== null)
    .map((t) => {
      const price = Number(t.fairPrice ?? t.lastPrice) || null;
      const contractSize = contractSizeBySymbol.get(t.symbol);
      return {
        exchange: 'mexc',
        symbol: t.symbol,
        fundingRate: Number(t.fundingRate),
        intervalHours: null, // fetched lazily per-symbol only for shortlisted candidates, see fetchIntervalHours
        nextFundingTime: null,
        price,
        // holdVol is a raw contract count, not a base-asset quantity —
        // contractSize (from the same /contract/detail call already fetched
        // above, no extra request) converts contracts to base-asset units.
        // Confirmed on a real BTC_USDT sample: holdVol=553,474,054 contracts *
        // contractSize=0.0001 BTC/contract * fairPrice ≈ $4.67B, plausible
        // given MEXC's large trading volume (bigger than Bybit's $2.44B, but
        // MEXC is a comparably large exchange).
        openInterestUsd: price && contractSize ? Number(t.holdVol) * contractSize * price : null,
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

module.exports = { id: 'mexc', label: 'MEXC', fetchCurrent, fetchHistory, fetchIntervalHours };

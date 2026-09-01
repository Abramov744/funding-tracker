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

  const list = Array.isArray(tickers) ? tickers : [tickers];

  return list
    .filter((t) => activeSymbols.has(t.symbol) && t.fundingRate !== undefined && t.fundingRate !== null)
    .map((t) => ({
      exchange: 'mexc',
      symbol: t.symbol,
      fundingRate: Number(t.fundingRate),
      intervalHours: null, // fetched lazily per-symbol only for shortlisted candidates, see fetchIntervalHours
      nextFundingTime: null,
    }));
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

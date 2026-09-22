// Bitget USDT-margined perpetual futures — public market data, no API key needed.
// Docs: https://www.bitget.com/api-doc/contract/market/Get-Tickers
const BASE = 'https://api.bitget.com';
const PRODUCT_TYPE = 'USDT-FUTURES';
const PAGE_SIZE = 100;

async function getJson(path) {
  const res = await fetch(BASE + path, { headers: { 'User-Agent': 'funding-tracker/1.0' } });
  if (!res.ok) throw new Error(`Bitget ${path} -> HTTP ${res.status}`);
  const body = await res.json();
  if (body.code !== '00000') throw new Error(`Bitget ${path} -> ${body.code} ${body.msg}`);
  return body.data;
}

// Returns current funding for every active, non-RWA USDT-margined perpetual.
//
// Bitget's bulk /tickers endpoint already carries price, fundingRate (a plain
// fraction, same convention the rest of the app uses — confirmed on a real
// BTCUSDT sample) and holdingAmount (open interest, in base-asset units —
// confirmed: 34,735.7453 BTC * $85,980.9 ~= $2.99B, in line with Bybit/OKX's
// scale). It does not carry the funding interval, so /contracts is fetched
// alongside it for fundInterval (hours; genuinely varies 1h/4h/8h per
// instrument, confirmed across a real 801-symbol dump) and for symbolType/
// symbolStatus/isRwa. isRwa is an explicit per-instrument flag Bitget
// provides for its ~335 tokenized-stock/commodity listings (AAPL, TSLA,
// XAUT, ...) alongside real crypto — same idea as Paradex's `tags`, no
// CoinGecko cross-check needed.
async function fetchCurrent() {
  const [tickers, contracts] = await Promise.all([
    getJson(`/api/v2/mix/market/tickers?productType=${PRODUCT_TYPE}`),
    getJson(`/api/v2/mix/market/contracts?productType=${PRODUCT_TYPE}`),
  ]);

  const contractBySymbol = new Map((contracts || []).map((c) => [c.symbol, c]));

  return (tickers || [])
    .map((t) => {
      const c = contractBySymbol.get(t.symbol);
      if (!c || c.symbolType !== 'perpetual' || c.symbolStatus !== 'normal' || c.isRwa === 'YES') return null;

      const price = Number(t.markPrice) || Number(t.lastPr) || null;
      const oi = Number(t.holdingAmount);

      return {
        exchange: 'bitget',
        symbol: t.symbol,
        fundingRate: Number(t.fundingRate),
        intervalHours: Number(c.fundInterval) || null,
        // Not present on either endpoint's response — left null, same as
        // Hyperliquid/Lighter/GRVT/Paradex/Pacifica.
        nextFundingTime: null,
        price,
        openInterestUsd: price && Number.isFinite(oi) ? oi * price : null,
      };
    })
    .filter((r) => r && Number.isFinite(r.fundingRate));
}

// Returns the last `limit` funding-rate settlements for one symbol, oldest
// first. /history-fund-rate caps each response at 100 rows, paginated via
// pageNo — confirmed on a real BTCUSDT sample: page 2's newest row lands
// exactly one funding period before page 1's oldest row, with no gap or
// overlap. Rates use the same plain-fraction convention as /tickers.
async function fetchHistory(symbol, limit = 200) {
  const maxPages = Math.ceil(limit / PAGE_SIZE) + 1;
  let rows = [];
  for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
    const page = await getJson(
      `/api/v2/mix/market/history-fund-rate?symbol=${encodeURIComponent(symbol)}&productType=${PRODUCT_TYPE}&pageSize=${PAGE_SIZE}&pageNo=${pageNo}`
    );
    if (!page || !page.length) break;
    rows = rows.concat(page);
    if (rows.length >= limit || page.length < PAGE_SIZE) break;
  }

  return rows
    .map((r) => ({ rate: Number(r.fundingRate), time: Number(r.fundingTime) }))
    .filter((r) => Number.isFinite(r.rate) && Number.isFinite(r.time))
    .sort((a, b) => a.time - b.time)
    .slice(-limit);
}

module.exports = { id: 'bitget', label: 'Bitget', fetchCurrent, fetchHistory };

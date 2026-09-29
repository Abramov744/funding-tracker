// HTX (formerly Huobi) USDT-margined linear perpetual swaps — public REST API,
// no key needed. Docs: https://huobiapi.github.io/docs/usdt_swap/v1/en/
const BASE = 'https://api.hbdm.com';

async function getJson(path) {
  const res = await fetch(BASE + path, { headers: { 'User-Agent': 'funding-tracker/1.0' } });
  if (!res.ok) throw new Error(`HTX ${path} -> HTTP ${res.status}`);
  const body = await res.json();
  if (body.status !== 'ok') throw new Error(`HTX ${path} -> ${body.status} ${body.err_msg || ''}`);
  return body.data;
}

// Returns current funding for every active USDT-margined perpetual.
//
// Four bulk calls, no per-symbol fan-out:
// - swap_contract_info carries contract_status (filter to 1 = "Listing") and
//   settlement_period — the funding interval in hours, confirmed NOT uniform
//   across contracts (8h/4h/1h all seen on a real 368-contract dump).
// - swap_batch_funding_rate carries funding_rate for every contract in one
//   call. A handful of dated-delivery contract codes leak in with
//   funding_rate: null (confirmed live) — filtered out by intersecting with
//   swap_contract_info's listing.
// - next_funding_time is unpopulated on every contract right now (confirmed
//   live, contradicting the docs' old example) — funding_time here is
//   actually the *upcoming* settlement timestamp, not a past one, so it's
//   used directly as nextFundingTime.
// - swap_index has no bulk "mark price" field to use instead; index_price is
//   the closest bulk price available (confirmed close to batch_merged's last
//   trade price on a real BTC-USDT sample).
// - swap_open_interest's `value` field is already USD-denominated position
//   value (per docs: amount = volume * contract_size, value = amount's USD
//   value) — no price multiplication needed, unlike Aster/edgeX.
async function fetchCurrent() {
  const [contracts, fundingRows, indexRows, oiRows] = await Promise.all([
    getJson('/linear-swap-api/v1/swap_contract_info?business_type=swap'),
    getJson('/linear-swap-api/v1/swap_batch_funding_rate'),
    getJson('/linear-swap-api/v1/swap_index'),
    getJson('/linear-swap-api/v1/swap_open_interest'),
  ]);

  const contractByCode = new Map(
    (contracts || []).filter((c) => c.contract_status === 1).map((c) => [c.contract_code, c])
  );
  const priceByCode = new Map((indexRows || []).map((r) => [r.contract_code, Number(r.index_price)]));
  const oiUsdByCode = new Map((oiRows || []).map((r) => [r.contract_code, Number(r.value)]));

  return (fundingRows || [])
    .map((r) => {
      const c = contractByCode.get(r.contract_code);
      const rate = Number(r.funding_rate);
      if (!c || !Number.isFinite(rate)) return null;

      const price = priceByCode.get(r.contract_code) || null;
      const oi = oiUsdByCode.get(r.contract_code);

      return {
        exchange: 'htx',
        symbol: r.contract_code,
        fundingRate: rate,
        intervalHours: Number(c.settlement_period) || null,
        nextFundingTime: Number(r.funding_time) || null,
        price,
        openInterestUsd: Number.isFinite(oi) ? oi : null,
      };
    })
    .filter((r) => r);
}

const HISTORY_PAGE_SIZE = 50; // API max

// Returns the last `limit` funding-rate settlements for one symbol, oldest
// first. /swap_historical_funding_rate comes back newest-first (confirmed on
// a real BTC-USDT sample), so pages are collected then reversed.
async function fetchHistory(symbol, limit = 200) {
  const maxPages = Math.ceil(limit / HISTORY_PAGE_SIZE);
  let rows = [];

  for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
    const page = await getJson(
      `/linear-swap-api/v1/swap_historical_funding_rate?contract_code=${encodeURIComponent(symbol)}&page_index=${pageIndex}&page_size=${HISTORY_PAGE_SIZE}`
    );
    const pageRows = (page && page.data) || [];
    if (!pageRows.length) break;
    rows = rows.concat(pageRows);
    if (pageRows.length < HISTORY_PAGE_SIZE) break;
  }

  return rows
    .map((r) => ({ rate: Number(r.funding_rate), time: Number(r.funding_time) }))
    .filter((r) => Number.isFinite(r.rate) && Number.isFinite(r.time))
    .sort((a, b) => a.time - b.time)
    .slice(-limit);
}

module.exports = { id: 'htx', label: 'HTX', fetchCurrent, fetchHistory };

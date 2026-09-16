// Paradex — perpetual DEX on StarkNet (Paradigm-backed). Public REST API, no
// key needed. Base URL and endpoints confirmed against real API responses
// (docs.paradex.trade isn't reachable from this environment).
const BASE = 'https://api.prod.paradex.trade/v1';

// Paradex explicitly tags every market — real crypto gets a category tag
// (LAYER-1, DEFI, MEME, AI, LAYER-2, or none at all), while tokenized
// stocks/commodities/indices get "RWA". Confirmed against a real dump: NG
// (natural gas), XAU/XPT/XAG/XCU (metals), CL (crude oil), MSFT/GOOGL/META/
// MRVL/MU/SNDK/INTC/CRCL/MSTR/SPCX/EWY (stocks/ETF) and US100/US500
// (indices) all carry "RWA"; BTC/ETH/SOL/... carry real category tags. No
// CoinGecko cross-check needed here, unlike Lighter/GRVT — the exchange
// tells us directly.
function isRwaTagged(market) {
  return Array.isArray(market.tags) && market.tags.includes('RWA');
}

// History for one coin costs dozens of requests here (see fetchHistory) —
// far more than any other exchange in this scanner — so the candidate list
// itself is capped to the most liquid markets rather than every listed one,
// to keep total request volume for a refresh cycle bounded.
const TOP_N_BY_VOLUME = 70;

const HTTP_RETRIES = 2; // for HTTP 429 specifically — this exchange gets hit with a lot of requests
const RETRY_BASE_DELAY_MS = 1000;

async function getJson(path) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(BASE + path, { headers: { 'User-Agent': 'funding-tracker/1.0' } });
    if (res.ok) return res.json();
    if (res.status === 429 && attempt < HTTP_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * (attempt + 1)));
      continue;
    }
    const body = await res.json().catch(() => null);
    throw new Error(`Paradex ${path} -> HTTP ${res.status}${body && body.message ? `: ${body.message}` : ''}`);
  }
}

// base ticker ("BTC") -> full market symbol ("BTC-USD-PERP"), filled by
// fetchCurrent and read by fetchHistory — Paradex's history endpoint needs
// the full market symbol, not the bare ticker this app displays/groups by.
let marketSymbolByBase = new Map();
let intervalByBase = new Map();

// Returns current funding for the most liquid non-RWA perpetuals.
// /markets carries metadata (tags, funding_period_hours) but not live
// numbers; /markets/summary carries the live funding rate/price/volume but
// not tags — both are needed and merged by market symbol. /markets/summary
// also mixes in Paradex's options markets (same endpoint, "market=ALL"), so
// results are filtered to symbols ending in "-PERP" alongside the RWA check.
async function fetchCurrent() {
  const [marketsRes, summaryRes] = await Promise.all([getJson('/markets'), getJson('/markets/summary?market=ALL')]);

  const markets = (marketsRes && marketsRes.results) || [];
  const summaries = (summaryRes && summaryRes.results) || [];

  const metaBySymbol = new Map(
    markets.filter((m) => m.symbol && m.symbol.endsWith('-PERP') && !isRwaTagged(m)).map((m) => [m.symbol, m])
  );

  const rows = summaries
    .filter((s) => metaBySymbol.has(s.symbol))
    .map((s) => {
      const meta = metaBySymbol.get(s.symbol);
      return {
        symbol: s.symbol,
        base: meta.base_currency,
        fundingRate: Number(s.funding_rate),
        intervalHours: Number(meta.funding_period_hours) || 8,
        price: Number(s.mark_price) || null,
        volume24h: Number(s.volume_24h) || 0,
      };
    })
    .filter((r) => r.base && Number.isFinite(r.fundingRate));

  rows.sort((a, b) => b.volume24h - a.volume24h);
  const top = rows.slice(0, TOP_N_BY_VOLUME);

  marketSymbolByBase = new Map(top.map((r) => [r.base, r.symbol]));
  intervalByBase = new Map(top.map((r) => [r.base, r.intervalHours]));

  return top.map((r) => ({
    exchange: 'paradex',
    symbol: r.base,
    fundingRate: r.fundingRate,
    intervalHours: r.intervalHours,
    // Settles on a fixed schedule (every funding_period_hours) that Paradex
    // doesn't expose a per-market next-settlement timestamp for — left null
    // rather than guessed at, same as Hyperliquid/Lighter/GRVT.
    nextFundingTime: null,
    price: r.price,
  }));
}

// symbol -> { limit, history, fetchedAt }. Building history here costs one
// request *per period* (~90 for 30 days — see below), by far the heaviest of
// any exchange in this scanner. cache.js's background refresh already pays
// that cost once per candidate; without caching, the "click a coin" chart
// popup (server.js's /api/history, calling this same fetchHistory) paid it
// AGAIN on every click — not an error, just ~90 sequential requests, so the
// popup sat on "Загрузка…" for a long time with nothing to show for it. Same
// fix already applied to Hyperliquid: reuse the background refresh's result
// instead of re-fetching. A TTL (rather than trusting it forever) keeps a
// coin that has since dropped out of the candidate set from serving stale
// data indefinitely.
const CACHE_TTL_MS = 10 * 60 * 1000; // a bit over 2 refresh cycles
let historyBySymbol = new Map();

// Returns up to `limit` funding-rate settlements for one symbol, oldest first.
//
// Paradex's /funding/data doesn't expose discrete per-period settlements —
// it streams a raw funding-index tick every 5 seconds (confirmed against a
// real dump: consecutive created_at values exactly 5000ms apart, regardless
// of the 8h funding_period_hours), so "give me the last N records" only
// covers a few minutes, not real history. Instead this samples one tick
// anchored at each real funding-period boundary going back `limit` periods,
// using `end_at` to anchor each request to that specific point in time —
// confirmed against a real response that end_at in the past returns ticks
// clustered around *that* time, not around "now". That's one request per
// period (accepted trade-off for genuine full-depth history on a
// continuous-funding exchange — see TOP_N_BY_VOLUME above for how the
// resulting request volume is kept bounded, and the cache above for why a
// popup click doesn't pay this cost live).
async function fetchHistory(symbol, limit = 90, intervalHours) {
  const cached = historyBySymbol.get(symbol);
  if (cached && cached.limit >= limit && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.history.slice(-limit);
  }

  const marketSymbol = marketSymbolByBase.get(symbol);
  if (!marketSymbol) throw new Error(`Paradex: unknown market for symbol ${symbol}`);
  const periodMs = (intervalHours || intervalByBase.get(symbol) || 8) * 60 * 60 * 1000;

  const now = Date.now();
  const history = [];

  for (let i = 0; i < limit; i++) {
    const endAt = now - i * periodMs;
    const data = await getJson(`/funding/data?market=${encodeURIComponent(marketSymbol)}&page_size=1&end_at=${endAt}`);
    const results = (data && data.results) || [];
    if (!results.length) continue;

    const rate = Number(results[0].funding_rate);
    const time = Number(results[0].created_at);
    if (Number.isFinite(rate) && Number.isFinite(time)) history.push({ rate, time });
  }

  history.sort((a, b) => a.time - b.time);
  historyBySymbol.set(symbol, { limit, history, fetchedAt: now });
  return history;
}

module.exports = { id: 'paradex', label: 'Paradex', fetchCurrent, fetchHistory };

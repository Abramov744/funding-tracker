// Hyperliquid — perpetual DEX, public "info" API, no key needed (single POST
// endpoint, request type selects the query).
// Docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals
const BASE = 'https://api.hyperliquid.xyz';
const INTERVAL_HOURS = 1; // Hyperliquid settles funding hourly

const RATE_LIMIT_RETRIES = 4;
const RATE_LIMIT_BASE_DELAY_MS = 2000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// cache.js fans out fetchHistory across several candidates at once (up to
// HISTORY_CONCURRENCY in parallel), and each of those makes its own paginated
// calls in here — enough concurrent traffic to the same /info endpoint to trip
// Hyperliquid's rate limit even with retries. So on top of the retry-on-429
// below, every request (fetchCurrent's included) is funneled through this
// single queue with a fixed minimum gap, self-throttling our outbound rate
// instead of just reacting after we've already been rate limited.
const MIN_GAP_MS = 300;
let queueTail = Promise.resolve();

function enqueue(fn) {
  const run = queueTail.then(async () => {
    try {
      return await fn();
    } finally {
      await sleep(MIN_GAP_MS);
    }
  });
  // Keep the chain alive even if this call ends up rejecting — otherwise every
  // later queued call would fail too, cascading one bad request into all of them.
  queueTail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function postJson(body) {
  return enqueue(async () => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${BASE}/info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'funding-tracker/1.0' },
        body: JSON.stringify(body),
      });
      if (res.ok) return res.json();
      if (res.status === 429 && attempt < RATE_LIMIT_RETRIES) {
        await sleep(RATE_LIMIT_BASE_DELAY_MS * (attempt + 1));
        continue;
      }
      throw new Error(`Hyperliquid /info (${body.type}) -> HTTP ${res.status}`);
    }
  });
}

// Returns current funding snapshot for every listed perpetual.
// metaAndAssetCtxs replies [meta, assetCtxs] — parallel arrays: meta.universe[i]
// describes the asset, assetCtxs[i] carries its live funding/price.
async function fetchCurrent() {
  const [meta, ctxs] = await postJson({ type: 'metaAndAssetCtxs' });
  const universe = (meta && meta.universe) || [];

  return universe
    .map((asset, i) => {
      const ctx = ctxs && ctxs[i];
      if (asset.isDelisted || !ctx || ctx.funding === undefined || ctx.funding === null) return null;
      return {
        exchange: 'hyperliquid',
        symbol: asset.name,
        fundingRate: Number(ctx.funding),
        intervalHours: INTERVAL_HOURS,
        nextFundingTime: null, // not exposed per-asset here; settles on the hour
        price: Number(ctx.markPx) || null,
      };
    })
    .filter((row) => row && Number.isFinite(row.fundingRate));
}

const HISTORY_STEP_MS = 7 * 24 * 60 * 60 * 1000; // API docs recommend querying ~7 days at a time
const HISTORY_MAX_PAGES = 6; // 6 * 7 days = 42-day span, comfortably covers a 30-day request

// symbol -> { limit, history, fetchedAt }. cache.js's background refresh already
// pages through each candidate's full 30-day history to compute its stats — this
// keeps that result around so the "click a coin" chart popup (server.js's
// /api/history, hitting this same fetchHistory) can be served instantly instead
// of joining the back of the shared rate-limit queue behind whatever the
// background refresh has already queued up, which is what made the popup slow
// and occasionally time out. A short TTL (rather than forever, like Lighter/GRVT
// cache their *entire* market) keeps a coin that has since dropped out of the
// candidate set (funding went negative / fell out of the top 200) from serving
// stale data indefinitely.
const CACHE_TTL_MS = 10 * 60 * 1000; // a bit over 2 refresh cycles
let historyBySymbol = new Map();

// Returns the last `limit` funding-rate settlements for one symbol, oldest first.
async function fetchHistory(symbol, limit = 200, intervalHours = INTERVAL_HOURS) {
  const cached = historyBySymbol.get(symbol);
  if (cached && cached.limit >= limit && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.history.slice(-limit);
  }

  const now = Date.now();
  const windowStart = now - limit * intervalHours * 60 * 60 * 1000;
  const raw = [];
  let cursor = windowStart;

  for (let page = 0; page < HISTORY_MAX_PAGES && cursor < now; page++) {
    const endTime = Math.min(cursor + HISTORY_STEP_MS, now);
    const rows = await postJson({ type: 'fundingHistory', coin: symbol, startTime: cursor, endTime });
    for (const r of rows || []) {
      const rate = Number(r.fundingRate);
      const time = Number(r.time);
      if (Number.isFinite(rate) && Number.isFinite(time)) raw.push({ rate, time });
    }
    cursor = endTime;
  }

  const history = raw.sort((a, b) => a.time - b.time).slice(-limit);
  historyBySymbol.set(symbol, { limit, history, fetchedAt: now });
  return history;
}

module.exports = { id: 'hyperliquid', label: 'Hyperliquid', fetchCurrent, fetchHistory };

// Worked example / template for the pw-preview skill. Copy this file into
// your scratchpad, rename it, and adapt the fixtures + interactions for
// whatever you're previewing — don't edit this one in place, it's also the
// skill's own smoke test (see "node example.js" in SKILL.md).
//
// Run with the static server already running (server.js on port 8901) and:
//   NODE_PATH=/opt/node22/lib/node_modules node example.js
const { chromium } = require('playwright');
const {
  fundingRow,
  spreadRow,
  history,
  aprTrendPoints,
  favoritesPayload,
  resolveChromiumExecutable,
} = require('./fixtures');

(async () => {
  const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

  // --- Fixtures --------------------------------------------------------
  const fundingRows = [
    fundingRow({ symbol: 'BTCUSDT', baseAsset: 'BTC', marketCapRank: 1, price: 90000 }),
    fundingRow({
      symbol: 'ETHUSDT',
      baseAsset: 'ETH',
      marketCapRank: 2,
      price: 3000,
      fundingRate: 0.00001,
      historyChecked: false,
      periods: 0,
      positiveRatio: null,
      minRate: null,
      maxRate: null,
      avgRate: null,
      avgAprPct: null,
    }),
  ];
  const spreadRows = [spreadRow()];
  let favorites = favoritesPayload(); // { funding: [], spread: [] }
  const favoriteCalls = [];

  // --- Route mocks -------------------------------------------------------
  await page.route('**/api/funding*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rows: fundingRows, updatedAt: Date.now(), refreshing: false, errors: {} }) })
  );
  await page.route('**/api/spreads*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rows: spreadRows, updatedAt: Date.now(), refreshing: false, errors: {} }) })
  );
  // NOTE the {,/**} glob: matches both /api/favorites (GET, no suffix) and
  // /api/favorites/<tab>/<baseAsset> (POST/DELETE) in one route. A plain
  // '**/api/favorites*' silently misses the two-segment POST/DELETE path,
  // since a bare '*' in Playwright's glob never crosses a '/'.
  await page.route('**/api/favorites{,/**}', (route) => {
    const req = route.request();
    const method = req.method();
    if (method === 'GET') {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(favorites) });
      return;
    }
    const parts = new URL(req.url()).pathname.split('/').filter(Boolean); // ['api','favorites', tab, baseAsset]
    const tab = parts[2];
    const baseAsset = decodeURIComponent(parts[3] || '');
    favoriteCalls.push(`${method} ${tab} ${baseAsset}`);
    if (method === 'POST') favorites[tab] = [...new Set([...(favorites[tab] || []), baseAsset])];
    if (method === 'DELETE') favorites[tab] = (favorites[tab] || []).filter((f) => f !== baseAsset);
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(favorites) });
  });
  await page.route('**/api/history*', (route) => {
    const url = new URL(route.request().url());
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        exchange: url.searchParams.get('exchange'),
        symbol: url.searchParams.get('symbol'),
        intervalHours: 8,
        history: history(90, 8, (h) => (h <= 16 ? 0.002 : 0.0005)), // recent spike vs. flat baseline
      }),
    });
  });
  await page.route('**/api/apr-history*', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ exchange: 'bitget', symbol: 'BTCUSDT', points: aprTrendPoints(90, 8, (h) => 60 + h / 20) }),
    });
  });
  await page.route('**/api/spot-prices*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ symbol: 'BTC', coingeckoId: null, venues: [] }) })
  );

  // --- Drive the page ------------------------------------------------
  await page.goto('http://localhost:8901/index.html');
  await page.waitForTimeout(400); // initial loadData() + loadFavorites()

  const visibleCoins = await page.locator('#tbody .coin-link').allInnerTexts();
  console.log('funding tab coins:', visibleCoins);
  if (!visibleCoins.includes('BTC')) throw new Error('FAIL: expected BTC row on the funding tab');

  // Star BTC, then open its popup and switch the APR window.
  await page.click('.fav-star[data-symbol="BTC"]');
  await page.waitForTimeout(150);
  if (!favoriteCalls.includes('POST funding BTC')) throw new Error(`FAIL: expected POST funding BTC, got ${favoriteCalls}`);

  await page.click('#tbody .coin-link');
  await page.waitForTimeout(400);
  const aprBefore = await page.locator('#chartWindowApr').innerText();
  await page.click('.apr-window-btn[data-window="1"]');
  await page.waitForTimeout(150);
  const aprAfter = await page.locator('#chartWindowApr').innerText();
  console.log('APR 30Д ->', aprBefore, '| APR 1Д ->', aprAfter);
  if (aprBefore === aprAfter) throw new Error('FAIL: switching to 1Д should change the displayed APR (spike is in the fixture)');

  await page.screenshot({ path: 'example_output.png', clip: { x: 0, y: 0, width: 800, height: 700 } });

  console.log('ALL PASS');
  await browser.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

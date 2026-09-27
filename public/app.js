// Favorites are keyed by base asset (e.g. "BTC"), not by exchange+symbol — the same
// coin usually shows up as several rows (one per exchange), and starring it once
// should mark all of them, so the favorites view can compare where funding is best
// right now for a coin you're already tracking. Stored server-side (see
// /api/favorites) rather than in localStorage: the backend uses this same list
// to force-monitor the coin on every refresh regardless of its current rate,
// so it has to be shared with the server, not just remembered in this browser.
async function loadFavorites() {
  try {
    const res = await fetch('/api/favorites');
    if (!res.ok) return new Set();
    const data = await res.json();
    return new Set(Array.isArray(data.favorites) ? data.favorites : []);
  } catch {
    return new Set();
  }
}

async function addFavorite(baseAsset) {
  try {
    await fetch(`/api/favorites/${encodeURIComponent(baseAsset)}`, { method: 'POST' });
  } catch {
    // Best-effort — the star still reflects the intended state locally, and
    // the next successful sync will reconcile it.
  }
}

async function removeFavorite(baseAsset) {
  try {
    await fetch(`/api/favorites/${encodeURIComponent(baseAsset)}`, { method: 'DELETE' });
  } catch {
    // Same as addFavorite — best-effort.
  }
}

const state = {
  rows: [],
  spreadRows: [],
  updatedAt: null,
  refreshing: false,
  sortKey: 'avgAprPct',
  sortDir: 'desc',
  spreadSortKey: 'avgAprPct',
  spreadSortDir: 'desc',
  favorites: new Set(),
  showFavoritesOnly: false,
  activeTab: 'funding',
};

const els = {
  tbody: document.getElementById('tbody'),
  status: document.getElementById('status'),
  errorBanner: document.getElementById('errorBanner'),
  emptyState: document.getElementById('emptyState'),
  table: document.getElementById('table'),
  search: document.getElementById('search'),
  minAvgApr: document.getElementById('minAvgApr'),
  minPositiveRatio: document.getElementById('minPositiveRatio'),
  minDays: document.getElementById('minDays'),
  maxRank: document.getElementById('maxRank'),
  minOi: document.getElementById('minOi'),
  noNegatives: document.getElementById('noNegatives'),
  onlyMatch: document.getElementById('onlyMatch'),
  refreshBtn: document.getElementById('refreshBtn'),
  chartOverlay: document.getElementById('chartOverlay'),
  chartClose: document.getElementById('chartClose'),
  chartTitle: document.getElementById('chartTitle'),
  chartSubtitle: document.getElementById('chartSubtitle'),
  chartFuturesPrice: document.getElementById('chartFuturesPrice'),
  chartBody: document.getElementById('chartBody'),
  chartCanvas: document.getElementById('chartCanvas'),
  chartMessage: document.getElementById('chartMessage'),
  aprTrendBody: document.getElementById('aprTrendBody'),
  aprTrendCanvas: document.getElementById('aprTrendCanvas'),
  aprTrendMessage: document.getElementById('aprTrendMessage'),
  spotList: document.getElementById('spotList'),
  spotMessage: document.getElementById('spotMessage'),
  mobileSortKey: document.getElementById('mobileSortKey'),
  mobileSortDir: document.getElementById('mobileSortDir'),
  favToggle: document.getElementById('favToggle'),
  selectAllExchanges: document.getElementById('selectAllExchanges'),
  deselectAllExchanges: document.getElementById('deselectAllExchanges'),
  exDropdown: document.getElementById('exDropdown'),
  exDropdownToggle: document.getElementById('exDropdownToggle'),
  filtersDropdown: document.getElementById('filtersDropdown'),
  filtersDropdownToggle: document.getElementById('filtersDropdownToggle'),
  filtersDropdownPanel: document.getElementById('filtersDropdownPanel'),
  exDropdownPanel: document.getElementById('exDropdownPanel'),
  exDropdownLabel: document.getElementById('exDropdownLabel'),

  // --- Futures-futures spread tab ---
  fundingTabBtn: document.getElementById('fundingTabBtn'),
  spreadTabBtn: document.getElementById('spreadTabBtn'),
  fundingTabPanel: document.getElementById('fundingTabPanel'),
  spreadTabPanel: document.getElementById('spreadTabPanel'),
  spreadTbody: document.getElementById('spreadTbody'),
  spreadTable: document.getElementById('spreadTable'),
  spreadEmptyState: document.getElementById('spreadEmptyState'),
  spreadErrorBanner: document.getElementById('spreadErrorBanner'),
  spreadMobileSortKey: document.getElementById('spreadMobileSortKey'),
  spreadMobileSortDir: document.getElementById('spreadMobileSortDir'),
  spreadFiltersDropdown: document.getElementById('spreadFiltersDropdown'),
  spreadFiltersDropdownToggle: document.getElementById('spreadFiltersDropdownToggle'),
  spreadFiltersDropdownPanel: document.getElementById('spreadFiltersDropdownPanel'),
  spreadMinAvgApr: document.getElementById('spreadMinAvgApr'),
  spreadMinPositiveRatio: document.getElementById('spreadMinPositiveRatio'),
  spreadMinDays: document.getElementById('spreadMinDays'),
  spreadMaxRank: document.getElementById('spreadMaxRank'),
  spreadMinOi: document.getElementById('spreadMinOi'),
  spreadNoNegatives: document.getElementById('spreadNoNegatives'),

  // --- Spread pair funding-history chart popup ---
  spreadChartOverlay: document.getElementById('spreadChartOverlay'),
  spreadChartClose: document.getElementById('spreadChartClose'),
  spreadChartTitle: document.getElementById('spreadChartTitle'),
  spreadChartSubtitle: document.getElementById('spreadChartSubtitle'),
  spreadChartLegend: document.getElementById('spreadChartLegend'),
  spreadChartBody: document.getElementById('spreadChartBody'),
  spreadChartCanvas: document.getElementById('spreadChartCanvas'),
  spreadChartMessage: document.getElementById('spreadChartMessage'),
};

function fmtPct(v, digits = 4) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return (v * 100).toFixed(digits) + '%';
}

function fmtAprPct(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return v.toFixed(1) + '%';
}

function fmtRatio(v) {
  if (v === null || v === undefined) return '—';
  return (v * 100).toFixed(0) + '%';
}

// Periods alone don't tell you the lookback window since the funding interval
// differs by exchange/coin (1h/4h/8h) — this converts to actual calendar days.
function historyDays(row) {
  if (!row.intervalHours) return 0;
  return (row.periods * row.intervalHours) / 24;
}

// "190" -> "190 (63.3 дн.)"
function fmtPeriods(row) {
  if (!row.intervalHours) return String(row.periods);
  return `${row.periods} (${historyDays(row).toFixed(1)} дн.)`;
}

// Crypto prices span many orders of magnitude (BTC ~ 100000, some tokens ~ 0.00000012),
// so pick the decimal precision from the magnitude instead of a fixed digit count.
function fmtPrice(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const abs = Math.abs(v);
  let digits;
  if (abs === 0) digits = 2;
  else if (abs >= 100) digits = 2;
  else if (abs >= 1) digits = 4;
  else if (abs >= 0.01) digits = 6;
  else digits = 8;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

// Compact notation for large USD figures ($850.4M / $18.3M / $46K) — OI values
// span from a few thousand to hundreds of millions, where fmtPrice's fixed
// decimal places would be unreadable.
function fmtCompactUsd(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e9) return '$' + (v / 1e9).toFixed(1) + 'B';
  if (abs >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
  if (abs >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
  return '$' + v.toFixed(0);
}

function rowMatchesStrategy(row) {
  const minAvgApr = Number(els.minAvgApr.value);
  const minRatio = Number(els.minPositiveRatio.value) / 100;
  if (row.avgAprPct === null || row.avgAprPct < minAvgApr) return false;
  if (row.positiveRatio === null || row.positiveRatio < minRatio) return false;
  // historyDays(row) < minDays isn't checked here — getFilteredRows already
  // excludes those rows from the table entirely, so anything reaching this
  // function already clears the threshold.
  if (els.noNegatives.checked && (row.minRate === null || row.minRate < 0)) return false;
  const maxRank = els.maxRank.value ? Number(els.maxRank.value) : null;
  if (maxRank !== null && (row.marketCapRank === null || row.marketCapRank > maxRank)) return false;
  const minOi = els.minOi.value ? Number(els.minOi.value) * 1000 : null; // input is in thousands of $
  if (minOi !== null && (row.openInterestUsd === null || row.openInterestUsd === undefined || row.openInterestUsd < minOi)) return false;
  return true;
}

function getFilteredRows() {
  const activeExchanges = new Set(
    Array.from(document.querySelectorAll('.ex-filter:checked')).map((el) => el.value)
  );
  const search = els.search.value.trim().toUpperCase();
  const onlyMatch = els.onlyMatch.checked;
  const minDays = Number(els.minDays.value);

  return state.rows.filter((row) => {
    if (!activeExchanges.has(row.exchange)) return false;
    if (search && !row.baseAsset.toUpperCase().includes(search)) return false;
    if (state.showFavoritesOnly && !state.favorites.has(row.baseAsset)) return false;
    // A favorited coin is never cut off by the strategy/threshold filters below
    // — it stays visible (and monitored, see lib/cache.js's forced-favorites
    // candidate logic) until it's removed from favorites. Exchange filter,
    // search, and "only favorites" above still apply — those are explicit
    // navigation choices, not the strategy screening this exemption is for.
    if (state.favorites.has(row.baseAsset)) return true;
    // Replaces the old separate "Только проверенные (есть история)" checkbox —
    // a row with no successful history fetch has 0 days, so it's excluded by
    // this alone whenever minDays > 0 (the default), same net effect with one
    // control instead of two overlapping ones.
    if (historyDays(row) < minDays) return false;
    if (onlyMatch && !rowMatchesStrategy(row)) return false;
    return true;
  });
}

// Generic sort usable for both tables — which state fields it reads/writes is
// the only difference, passed in rather than hardcoded.
function sortByKey(rows, sortKey, sortDir) {
  const dir = sortDir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    let av = a[sortKey];
    let bv = b[sortKey];
    if (av === null || av === undefined) av = -Infinity;
    if (bv === null || bv === undefined) bv = -Infinity;
    if (typeof av === 'string') return av.localeCompare(bv) * dir;
    return (av - bv) * dir;
  });
}

function sortRows(rows) {
  return sortByKey(rows, state.sortKey, state.sortDir);
}

function updateSortArrows() {
  document.querySelectorAll('#table th[data-key]').forEach((th) => {
    const arrow = th.querySelector('.sort-arrow');
    if (!arrow) return;
    arrow.textContent = th.dataset.key === state.sortKey ? (state.sortDir === 'asc' ? '▲' : '▼') : '';
  });
  // Table headers are hidden on mobile (cards have no room for a header row to tap),
  // so this dropdown+button pair is the mobile equivalent — keep it in sync either way.
  els.mobileSortKey.value = state.sortKey;
  els.mobileSortDir.textContent = state.sortDir === 'asc' ? '▲' : '▼';
}

// --- Futures-futures spread tab: filtering/sorting/rendering ----------------
// Both legs are already normalized to a common hourly basis in lib/spreads.js,
// so `periods` here always means hours, not "whatever this exchange's own
// funding interval is" — the days conversion is a plain /24, no intervalHours.
function spreadHistoryDays(row) {
  return row.periods / 24;
}

function fmtSpreadPeriods(row) {
  return `${row.periods} (${spreadHistoryDays(row).toFixed(1)} дн.)`;
}

function spreadRowMatchesStrategy(row) {
  const minAvgApr = Number(els.spreadMinAvgApr.value);
  const minRatio = Number(els.spreadMinPositiveRatio.value) / 100;
  if (row.avgAprPct === null || row.avgAprPct < minAvgApr) return false;
  if (row.positiveRatio === null || row.positiveRatio < minRatio) return false;
  if (els.spreadNoNegatives.checked && (row.minAprPct === null || row.minAprPct < 0)) return false;
  const maxRank = els.spreadMaxRank.value ? Number(els.spreadMaxRank.value) : null;
  if (maxRank !== null && (row.marketCapRank === null || row.marketCapRank > maxRank)) return false;
  const minOi = els.spreadMinOi.value ? Number(els.spreadMinOi.value) * 1000 : null;
  if (minOi !== null) {
    if (row.shortOpenInterestUsd === null || row.shortOpenInterestUsd === undefined || row.shortOpenInterestUsd < minOi) return false;
    if (row.longOpenInterestUsd === null || row.longOpenInterestUsd === undefined || row.longOpenInterestUsd < minOi) return false;
  }
  return true;
}

function getFilteredSpreadRows() {
  const activeExchanges = new Set(
    Array.from(document.querySelectorAll('.ex-filter:checked')).map((el) => el.value)
  );
  const search = els.search.value.trim().toUpperCase();
  const minDays = Number(els.spreadMinDays.value);

  return state.spreadRows.filter((row) => {
    if (!activeExchanges.has(row.shortExchange) || !activeExchanges.has(row.longExchange)) return false;
    if (search && !row.baseAsset.toUpperCase().includes(search)) return false;
    if (state.showFavoritesOnly && !state.favorites.has(row.baseAsset)) return false;
    // Same exemption as the funding table: a favorited coin stays visible
    // here too, regardless of the strategy/threshold filters, until it's
    // removed from favorites.
    if (state.favorites.has(row.baseAsset)) return true;
    if (spreadHistoryDays(row) < minDays) return false;
    if (!spreadRowMatchesStrategy(row)) return false;
    return true;
  });
}

function sortSpreadRows(rows) {
  return sortByKey(rows, state.spreadSortKey, state.spreadSortDir);
}

function updateSpreadSortArrows() {
  document.querySelectorAll('#spreadTable th[data-key]').forEach((th) => {
    const arrow = th.querySelector('.sort-arrow');
    if (!arrow) return;
    arrow.textContent = th.dataset.key === state.spreadSortKey ? (state.spreadSortDir === 'asc' ? '▲' : '▼') : '';
  });
  els.spreadMobileSortKey.value = state.spreadSortKey;
  els.spreadMobileSortDir.textContent = state.spreadSortDir === 'asc' ? '▲' : '▼';
}

function renderSpreadTable() {
  updateSpreadSortArrows();
  const rows = sortSpreadRows(getFilteredSpreadRows());
  els.spreadTbody.innerHTML = '';
  els.spreadEmptyState.hidden = rows.length > 0;
  els.spreadTable.hidden = rows.length === 0;

  for (const row of rows) {
    const tr = document.createElement('tr');
    const aprClass = row.spreadAprPct > 0 ? 'positive' : row.spreadAprPct < 0 ? 'negative' : '';
    const isFav = state.favorites.has(row.baseAsset);

    tr.innerHTML = `
      <td class="cell-coin" data-label="Монета">
        <button type="button" class="fav-star${isFav ? ' active' : ''}" data-symbol="${row.baseAsset}" aria-pressed="${isFav}" aria-label="${isFav ? 'Убрать из избранного' : 'В избранное'}">${isFav ? '★' : '☆'}</button>
        <button type="button" class="coin-link" data-base="${row.baseAsset}" data-short-exchange="${row.shortExchange}" data-short-label="${row.shortExchangeLabel}" data-short-symbol="${row.shortSymbol}" data-short-interval="${row.shortIntervalHours ?? ''}" data-long-exchange="${row.longExchange}" data-long-label="${row.longExchangeLabel}" data-long-symbol="${row.longSymbol}" data-long-interval="${row.longIntervalHours ?? ''}">${row.baseAsset}</button>
      </td>
      <td data-label="Ранг CMC*">${row.marketCapRank ?? '—'}</td>
      <td class="cell-exchange" data-label="Шорт (биржа)">${row.shortExchangeLabel}</td>
      <td class="positive" data-label="Ставка шорт">${fmtPct(row.shortRate)}</td>
      <td data-label="OI шорт">${fmtCompactUsd(row.shortOpenInterestUsd)}</td>
      <td class="cell-exchange" data-label="Лонг (биржа)">${row.longExchangeLabel}</td>
      <td class="${row.longRate < 0 ? 'positive' : ''}" data-label="Ставка лонг">${fmtPct(row.longRate)}</td>
      <td data-label="OI лонг">${fmtCompactUsd(row.longOpenInterestUsd)}</td>
      <td class="${aprClass}" data-label="Спред APR">${fmtAprPct(row.spreadAprPct)}</td>
      <td data-label="Периодов">${fmtSpreadPeriods(row)}</td>
      <td data-label="% выигрышных">${fmtRatio(row.positiveRatio)}</td>
      <td class="${row.minAprPct < 0 ? 'negative' : ''}" data-label="Мин. спред APR">${fmtAprPct(row.minAprPct)}</td>
      <td data-label="Ср. спред APR">${fmtAprPct(row.avgAprPct)}</td>
    `;
    els.spreadTbody.appendChild(tr);
  }
}

function updateFavToggle() {
  const count = state.favorites.size;
  els.favToggle.textContent = `${state.showFavoritesOnly ? '★' : '☆'} Избранное${count ? ` (${count})` : ''}`;
  els.favToggle.classList.toggle('active', state.showFavoritesOnly);
  els.favToggle.setAttribute('aria-pressed', String(state.showFavoritesOnly));
}

function render() {
  updateFavToggle();
  renderFundingTable();
  renderSpreadTable();
}

function renderFundingTable() {
  updateSortArrows();
  const rows = sortRows(getFilteredRows());
  els.tbody.innerHTML = '';
  els.emptyState.hidden = rows.length > 0;
  els.table.hidden = rows.length === 0;

  for (const row of rows) {
    const tr = document.createElement('tr');
    if (rowMatchesStrategy(row)) tr.classList.add('match');

    const rateClass = row.fundingRate > 0 ? 'positive' : row.fundingRate < 0 ? 'negative' : '';
    const aprClass = row.aprPct > 0 ? 'positive' : row.aprPct < 0 ? 'negative' : '';
    const isFav = state.favorites.has(row.baseAsset);

    tr.innerHTML = `
      <td class="cell-exchange" data-label="Биржа">${row.exchangeLabel}</td>
      <td class="cell-coin" data-label="Монета">
        <button type="button" class="fav-star${isFav ? ' active' : ''}" data-symbol="${row.baseAsset}" aria-pressed="${isFav}" aria-label="${isFav ? 'Убрать из избранного' : 'В избранное'}">${isFav ? '★' : '☆'}</button>
        <button type="button" class="coin-link" data-exchange="${row.exchange}" data-symbol="${row.symbol}" data-interval="${row.intervalHours ?? ''}">${row.baseAsset}</button>
      </td>
      <td data-label="Ранг CMC*">${row.marketCapRank ?? '—'}</td>
      <td data-label="OI**">${fmtCompactUsd(row.openInterestUsd)}</td>
      <td class="${rateClass}" data-label="Ставка (период)">${fmtPct(row.fundingRate)}</td>
      <td class="${aprClass}" data-label="APR %">${fmtAprPct(row.aprPct)}</td>
      <td data-label="Периодов">${fmtPeriods(row)}</td>
      <td data-label="% полож.">${fmtRatio(row.positiveRatio)}</td>
      <td class="${row.minRate < 0 ? 'negative' : ''}" data-label="Мин. ставка">${fmtPct(row.minRate)}</td>
      <td data-label="Ср. APR %">${fmtAprPct(row.avgAprPct)}</td>
    `;
    els.tbody.appendChild(tr);
  }

  const ts = state.updatedAt ? new Date(state.updatedAt).toLocaleTimeString('ru-RU') : '—';
  // A background auto-refresh (every 5 min) can be in progress when this renders
  // too, not just a manual click — either way, make it unambiguous that the
  // table below might still be a bit stale rather than silently showing old data.
  els.status.textContent = state.refreshing
    ? `Обновляется… (данные на ${ts})`
    : `Обновлено: ${ts} · строк: ${rows.length}/${state.rows.length}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadData() {
  const res = await fetch('/api/funding');
  if (res.status === 401) {
    window.location.href = '/login.html';
    return { rows: [], updatedAt: null, refreshing: false, errors: {} };
  }
  const data = await res.json();
  state.rows = data.rows || [];
  state.updatedAt = data.updatedAt;
  state.refreshing = Boolean(data.refreshing);

  const errorEntries = Object.entries(data.errors || {});
  const errorText = errorEntries.length
    ? 'Ошибки при опросе бирж: ' + errorEntries.map(([ex, msg]) => `${ex} — ${msg}`).join(' · ')
    : '';
  els.errorBanner.hidden = !errorText;
  els.errorBanner.textContent = errorText;
  // Same underlying per-exchange errors as /api/funding (both are views over
  // the same cache), shown again here since the spread tab has its own banner.
  els.spreadErrorBanner.hidden = !errorText;
  els.spreadErrorBanner.textContent = errorText;

  // Independent of /api/funding — a spread-fetch failure shouldn't block the
  // funding table from rendering, or vice versa.
  try {
    const spreadRes = await fetch('/api/spreads');
    if (spreadRes.ok) {
      const spreadData = await spreadRes.json();
      state.spreadRows = spreadData.rows || [];
    }
  } catch {
    // Leaves state.spreadRows as whatever it was last cycle rather than
    // blanking the tab over one failed request.
  }

  render();
  return data;
}

// After POSTing /api/refresh (which now returns immediately rather than waiting
// for the whole multi-exchange cycle to finish — see server.js), poll until the
// backend reports it's done so the "Обновляется…" status is never left stuck.
async function pollUntilIdle() {
  const POLL_INTERVAL_MS = 2000;
  const MAX_WAIT_MS = 3 * 60 * 1000; // safety cap — don't poll forever if something wedges
  const deadline = Date.now() + MAX_WAIT_MS;

  while (Date.now() < deadline) {
    const data = await loadData();
    if (!data.refreshing) return;
    await sleep(POLL_INTERVAL_MS);
  }
}

document.querySelectorAll('#table th[data-key]').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.dataset.key;
    if (state.sortKey === key) {
      state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      state.sortKey = key;
      state.sortDir = 'desc';
    }
    render();
  });
});

document.querySelectorAll('#spreadTable th[data-key]').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.dataset.key;
    if (state.spreadSortKey === key) {
      state.spreadSortDir = state.spreadSortDir === 'asc' ? 'desc' : 'asc';
    } else {
      state.spreadSortKey = key;
      state.spreadSortDir = 'desc';
    }
    render();
  });
});

[
  els.search,
  els.minAvgApr,
  els.minPositiveRatio,
  els.minDays,
  els.maxRank,
  els.minOi,
  els.noNegatives,
  els.onlyMatch,
  els.spreadMinAvgApr,
  els.spreadMinPositiveRatio,
  els.spreadMinDays,
  els.spreadMaxRank,
  els.spreadMinOi,
  els.spreadNoNegatives,
].forEach((el) => el.addEventListener('input', render));

const allExFilters = Array.from(document.querySelectorAll('.ex-filter'));

function updateExDropdownLabel() {
  const checkedCount = allExFilters.filter((el) => el.checked).length;
  els.exDropdownLabel.textContent = `Биржи: ${checkedCount}/${allExFilters.length}`;
}

allExFilters.forEach((el) =>
  el.addEventListener('change', () => {
    updateExDropdownLabel();
    render();
  })
);

function setAllExchangeFilters(checked) {
  allExFilters.forEach((el) => {
    el.checked = checked;
  });
  updateExDropdownLabel();
  render();
}

els.selectAllExchanges.addEventListener('click', () => setAllExchangeFilters(true));
els.deselectAllExchanges.addEventListener('click', () => setAllExchangeFilters(false));

// Shared open/close wiring for the top-bar pill dropdowns (exchanges, filters):
// click the toggle to open/close, click outside or Escape to close, and
// opening one closes the other so they don't stack.
const dropdowns = [
  { container: els.exDropdown, toggle: els.exDropdownToggle, panel: els.exDropdownPanel },
  { container: els.filtersDropdown, toggle: els.filtersDropdownToggle, panel: els.filtersDropdownPanel },
  { container: els.spreadFiltersDropdown, toggle: els.spreadFiltersDropdownToggle, panel: els.spreadFiltersDropdownPanel },
];

function setDropdownOpen(dropdown, open) {
  dropdown.panel.hidden = !open;
  dropdown.toggle.setAttribute('aria-expanded', String(open));
}

function closeAllDropdowns(except) {
  dropdowns.forEach((d) => {
    if (d !== except) setDropdownOpen(d, false);
  });
}

dropdowns.forEach((d) => {
  d.toggle.addEventListener('click', () => {
    const opening = d.panel.hidden;
    closeAllDropdowns(d);
    setDropdownOpen(d, opening);
  });
});

document.addEventListener('click', (e) => {
  dropdowns.forEach((d) => {
    if (!d.panel.hidden && !d.container.contains(e.target)) setDropdownOpen(d, false);
  });
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  dropdowns.forEach((d) => {
    if (!d.panel.hidden) {
      setDropdownOpen(d, false);
      d.toggle.focus();
    }
  });
});

updateExDropdownLabel();

els.mobileSortKey.addEventListener('change', () => {
  state.sortKey = els.mobileSortKey.value;
  render();
});

els.mobileSortDir.addEventListener('click', () => {
  state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
  render();
});

els.spreadMobileSortKey.addEventListener('change', () => {
  state.spreadSortKey = els.spreadMobileSortKey.value;
  render();
});

els.spreadMobileSortDir.addEventListener('click', () => {
  state.spreadSortDir = state.spreadSortDir === 'asc' ? 'desc' : 'asc';
  render();
});

// --- Tab switching (spot+short funding table vs. futures-futures spread) ---
function setActiveTab(tab) {
  state.activeTab = tab;
  els.fundingTabBtn.classList.toggle('active', tab === 'funding');
  els.spreadTabBtn.classList.toggle('active', tab === 'spread');
  els.fundingTabPanel.hidden = tab !== 'funding';
  els.spreadTabPanel.hidden = tab !== 'spread';
  els.filtersDropdown.hidden = tab !== 'funding';
  els.spreadFiltersDropdown.hidden = tab !== 'spread';
  closeAllDropdowns();
}

els.fundingTabBtn.addEventListener('click', () => setActiveTab('funding'));
els.spreadTabBtn.addEventListener('click', () => setActiveTab('spread'));

els.refreshBtn.addEventListener('click', async () => {
  const originalLabel = els.refreshBtn.textContent;
  els.refreshBtn.disabled = true;
  els.refreshBtn.textContent = 'Обновляется…';
  els.status.textContent = 'Обновляется…';
  try {
    await fetch('/api/refresh', { method: 'POST' });
    await pollUntilIdle();
  } catch (err) {
    els.status.textContent = 'Не удалось обновить: ' + (err.message || err);
  } finally {
    els.refreshBtn.disabled = false;
    els.refreshBtn.textContent = originalLabel;
  }
});

// --- Funding history chart popup (click on a coin name) ---------------------

function drawFundingChart(history) {
  const canvas = els.chartCanvas;
  const ctx = canvas.getContext('2d');
  const cssWidth = canvas.clientWidth || canvas.width;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = cssWidth * dpr;
  canvas.height = 320 * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const W = cssWidth;
  const H = 320;
  const padL = 56;
  const padR = 12;
  const padT = 14;
  const padB = 28;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  ctx.clearRect(0, 0, W, H);

  const rates = history.map((h) => h.rate * 100); // as %
  const maxAbs = Math.max(0.001, ...rates.map((r) => Math.abs(r)));
  const yMax = maxAbs * 1.15;
  const yMin = -yMax;

  const yFor = (r) => padT + plotH * (1 - (r - yMin) / (yMax - yMin));
  const zeroY = yFor(0);

  // grid + y-axis labels
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.fillStyle = '#8a90a0';
  ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const ySteps = 4;
  for (let i = -ySteps; i <= ySteps; i++) {
    const v = (yMax / ySteps) * i;
    const y = yFor(v);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(W - padR, y);
    ctx.stroke();
    ctx.fillText(v.toFixed(3) + '%', padL - 8, y);
  }

  // zero line, emphasized
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.beginPath();
  ctx.moveTo(padL, zeroY);
  ctx.lineTo(W - padR, zeroY);
  ctx.stroke();

  if (history.length === 0) return;

  // bars, one per settlement
  const n = history.length;
  const slot = plotW / n;
  const barW = Math.max(1, Math.min(14, slot * 0.7));

  history.forEach((h, i) => {
    const r = h.rate * 100;
    const x = padL + slot * i + slot / 2 - barW / 2;
    const y = yFor(Math.max(0, r));
    const yEnd = yFor(Math.min(0, r));
    ctx.fillStyle = r >= 0 ? '#3ddc97' : '#ff6b6b';
    ctx.fillRect(x, y, barW, Math.max(1, yEnd - y));
  });

  // x-axis date labels (first, middle, last)
  ctx.fillStyle = '#8a90a0';
  ctx.textBaseline = 'top';
  const labelIdx = [0, Math.floor((n - 1) / 2), n - 1];
  const seen = new Set();
  labelIdx.forEach((i) => {
    if (seen.has(i)) return;
    seen.add(i);
    const x = padL + slot * i + slot / 2;
    const d = new Date(history[i].time);
    const label = d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
    ctx.textAlign = i === 0 ? 'left' : i === n - 1 ? 'right' : 'center';
    ctx.fillText(label, x, H - padB + 6);
  });
}

function closeChart() {
  els.chartOverlay.hidden = true;
}

async function loadFundingChart(row) {
  els.chartMessage.hidden = true;
  els.chartBody.hidden = false;
  els.chartCanvas.getContext('2d').clearRect(0, 0, els.chartCanvas.width, els.chartCanvas.height);

  const params = new URLSearchParams({ exchange: row.exchange, symbol: row.symbol });
  if (row.intervalHours) params.set('intervalHours', row.intervalHours);

  try {
    const res = await fetch(`/api/history?${params.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    if (!data.history || data.history.length === 0) {
      els.chartBody.hidden = true;
      els.chartMessage.hidden = false;
      els.chartMessage.textContent = 'Нет данных по истории фандинга за последние 30 дней.';
      return;
    }

    drawFundingChart(data.history);
  } catch (err) {
    els.chartBody.hidden = true;
    els.chartMessage.hidden = false;
    els.chartMessage.textContent = 'Не удалось загрузить историю: ' + (err.message || err);
  }
}

// --- Average-APR trend chart (how the "Ср. APR %" number itself has moved) --

function drawAprTrendChart(points) {
  const canvas = els.aprTrendCanvas;
  const ctx = canvas.getContext('2d');
  const cssWidth = canvas.clientWidth || canvas.width;
  const cssHeight = 200;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const W = cssWidth;
  const H = cssHeight;
  const padL = 56;
  const padR = 12;
  const padT = 14;
  const padB = 24;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  ctx.clearRect(0, 0, W, H);

  const values = points.map((p) => p.value);
  const minV = Math.min(0, ...values);
  const maxV = Math.max(0.001, ...values);
  const pad = (maxV - minV) * 0.12 || 1;
  const yMin = minV - pad;
  const yMax = maxV + pad;

  const n = points.length;
  const xFor = (i) => padL + (n === 1 ? plotW / 2 : (plotW * i) / (n - 1));
  const yFor = (v) => padT + plotH * (1 - (v - yMin) / (yMax - yMin));

  // grid + y-axis labels
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.fillStyle = '#8a90a0';
  ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const ySteps = 4;
  for (let i = 0; i <= ySteps; i++) {
    const v = yMin + ((yMax - yMin) / ySteps) * i;
    const y = yFor(v);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(W - padR, y);
    ctx.stroke();
    ctx.fillText(v.toFixed(1) + '%', padL - 8, y);
  }

  if (minV < 0 && maxV > 0) {
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    const zeroY = yFor(0);
    ctx.beginPath();
    ctx.moveTo(padL, zeroY);
    ctx.lineTo(W - padR, zeroY);
    ctx.stroke();
  }

  if (n === 0) return;

  // filled area under the line
  ctx.beginPath();
  ctx.moveTo(xFor(0), yFor(points[0].value));
  points.forEach((p, i) => ctx.lineTo(xFor(i), yFor(p.value)));
  ctx.lineTo(xFor(n - 1), yFor(yMin));
  ctx.lineTo(xFor(0), yFor(yMin));
  ctx.closePath();
  ctx.fillStyle = 'rgba(61, 220, 151, 0.12)';
  ctx.fill();

  // the line itself
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = xFor(i);
    const y = yFor(p.value);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#3ddc97';
  ctx.lineWidth = 1.75;
  ctx.stroke();

  // endpoint dot
  const lastX = xFor(n - 1);
  const lastY = yFor(points[n - 1].value);
  ctx.beginPath();
  ctx.arc(lastX, lastY, 3, 0, Math.PI * 2);
  ctx.fillStyle = '#3ddc97';
  ctx.fill();

  // x-axis date labels (first, middle, last)
  ctx.fillStyle = '#8a90a0';
  ctx.textBaseline = 'top';
  const labelIdx = [0, Math.floor((n - 1) / 2), n - 1];
  const seen = new Set();
  labelIdx.forEach((i) => {
    if (seen.has(i)) return;
    seen.add(i);
    const x = xFor(i);
    const d = new Date(points[i].time);
    const label = d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
    ctx.textAlign = i === 0 ? 'left' : i === n - 1 ? 'right' : 'center';
    ctx.fillText(label, x, H - padB + 6);
  });
}

async function loadAprTrend(row) {
  els.aprTrendMessage.hidden = true;
  els.aprTrendBody.hidden = false;
  els.aprTrendCanvas.getContext('2d').clearRect(0, 0, els.aprTrendCanvas.width, els.aprTrendCanvas.height);

  const params = new URLSearchParams({ exchange: row.exchange, symbol: row.symbol });

  try {
    const res = await fetch(`/api/apr-history?${params.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    if (!data.points || data.points.length < 2) {
      els.aprTrendBody.hidden = true;
      els.aprTrendMessage.hidden = false;
      els.aprTrendMessage.textContent = 'Пока недостаточно данных для тренда — снимки собираются раз в час, загляните позже.';
      return;
    }

    drawAprTrendChart(data.points);
  } catch (err) {
    els.aprTrendBody.hidden = true;
    els.aprTrendMessage.hidden = false;
    els.aprTrendMessage.textContent = 'Не удалось загрузить тренд: ' + (err.message || err);
  }
}

function spotRowHtml(v) {
  // v.quote is omitted server-side when it isn't a real ticker (DEX pools often
  // report their quote token as a raw contract address instead of e.g. "USDT").
  const quote = v.quote ? ` <span class="muted">${v.quote}</span>` : '';
  return `
    <div class="spot-row">
      <span class="spot-exchange">${v.name}</span>
      <span class="spot-price">${fmtPrice(v.price)}${quote}</span>
    </div>
  `;
}

async function loadSpotVenues(baseAsset, refPrice) {
  els.spotMessage.hidden = true;
  els.spotList.hidden = false;
  els.spotList.innerHTML = '<p class="chart-message">Загрузка…</p>';

  try {
    const params = new URLSearchParams({ symbol: baseAsset });
    if (Number.isFinite(refPrice) && refPrice > 0) params.set('refPrice', refPrice);
    const res = await fetch(`/api/spot-prices?${params.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    if (!data.venues || data.venues.length === 0) {
      els.spotList.hidden = true;
      els.spotMessage.hidden = false;
      els.spotMessage.textContent = data.coingeckoId
        ? 'Не нашлось данных о спот-торговле этой монетой ни на одной бирже.'
        : 'Монета не найдена в базе CoinGecko — сравнение спот-цен недоступно.';
      return;
    }

    els.spotList.innerHTML = data.venues.map(spotRowHtml).join('');
  } catch (err) {
    els.spotList.hidden = true;
    els.spotMessage.hidden = false;
    els.spotMessage.textContent = 'Не удалось загрузить спот-цены: ' + (err.message || err);
  }
}

function openCoinChart(row) {
  els.chartOverlay.hidden = false;
  els.chartTitle.textContent = `${row.baseAsset} — фандинг за 30 дней`;
  els.chartSubtitle.textContent = `${row.exchangeLabel} · ${row.symbol}`;
  els.chartFuturesPrice.textContent = fmtPrice(row.price);

  // Independent lookups — kick all three off at once instead of chaining them.
  loadFundingChart(row);
  loadAprTrend(row);
  loadSpotVenues(row.baseAsset, row.price);
}

// --- Spread pair funding-history chart popup (click a coin name in the
// futures-futures tab) — one canvas, two overlaid line series (short leg's
// exchange vs. long leg's exchange), so the two rates that make up the
// spread can be compared visually over the same 30-day window. Plotted on a
// shared real-time x-axis (not by index) since the two legs' exchanges
// usually settle on different intervals (e.g. 1h vs 8h) and so have very
// different point counts/spacing.
const SPREAD_CHART_COLORS = { short: '#3ddc97', long: '#5b8dee' };

function drawSpreadPairChart(shortHistory, longHistory) {
  const canvas = els.spreadChartCanvas;
  const ctx = canvas.getContext('2d');
  const cssWidth = canvas.clientWidth || canvas.width;
  const H = 320;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = cssWidth * dpr;
  canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const W = cssWidth;
  const padL = 56;
  const padR = 12;
  const padT = 14;
  const padB = 28;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  ctx.clearRect(0, 0, W, H);

  const series = [shortHistory, longHistory].filter((s) => s && s.length);
  if (series.length === 0) return;

  const allTimes = series.flatMap((s) => s.map((h) => h.time));
  const minTime = Math.min(...allTimes);
  const maxTime = Math.max(...allTimes);

  const allRates = series.flatMap((s) => s.map((h) => h.rate * 100));
  const maxAbs = Math.max(0.001, ...allRates.map((r) => Math.abs(r)));
  const yMax = maxAbs * 1.15;
  const yMin = -yMax;

  const xFor = (t) => (maxTime === minTime ? padL + plotW / 2 : padL + (plotW * (t - minTime)) / (maxTime - minTime));
  const yFor = (r) => padT + plotH * (1 - (r - yMin) / (yMax - yMin));
  const zeroY = yFor(0);

  // grid + y-axis labels
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.fillStyle = '#8a90a0';
  ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const ySteps = 4;
  for (let i = -ySteps; i <= ySteps; i++) {
    const v = (yMax / ySteps) * i;
    const y = yFor(v);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(W - padR, y);
    ctx.stroke();
    ctx.fillText(v.toFixed(3) + '%', padL - 8, y);
  }

  // zero line, emphasized
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.beginPath();
  ctx.moveTo(padL, zeroY);
  ctx.lineTo(W - padR, zeroY);
  ctx.stroke();

  function drawLine(history, color) {
    if (!history || history.length === 0) return;
    ctx.beginPath();
    history.forEach((h, i) => {
      const x = xFor(h.time);
      const y = yFor(h.rate * 100);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.75;
    ctx.stroke();

    const last = history[history.length - 1];
    ctx.beginPath();
    ctx.arc(xFor(last.time), yFor(last.rate * 100), 3, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  drawLine(shortHistory, SPREAD_CHART_COLORS.short);
  drawLine(longHistory, SPREAD_CHART_COLORS.long);

  // x-axis date labels (first, middle, last of the overall time range)
  ctx.fillStyle = '#8a90a0';
  ctx.textBaseline = 'top';
  [minTime, (minTime + maxTime) / 2, maxTime].forEach((t, i) => {
    const x = xFor(t);
    const d = new Date(t);
    const label = d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
    ctx.textAlign = i === 0 ? 'left' : i === 2 ? 'right' : 'center';
    ctx.fillText(label, x, H - padB + 6);
  });
}

function closeSpreadChart() {
  els.spreadChartOverlay.hidden = true;
}

async function loadSpreadPairChart(data) {
  els.spreadChartMessage.hidden = true;
  els.spreadChartBody.hidden = false;
  els.spreadChartCanvas.getContext('2d').clearRect(0, 0, els.spreadChartCanvas.width, els.spreadChartCanvas.height);

  const fetchLeg = async (exchange, symbol, intervalHours) => {
    const params = new URLSearchParams({ exchange, symbol });
    if (intervalHours) params.set('intervalHours', intervalHours);
    const res = await fetch(`/api/history?${params.toString()}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json.history || [];
  };

  try {
    const [shortHistory, longHistory] = await Promise.all([
      fetchLeg(data.shortExchange, data.shortSymbol, data.shortIntervalHours),
      fetchLeg(data.longExchange, data.longSymbol, data.longIntervalHours),
    ]);

    if (shortHistory.length === 0 && longHistory.length === 0) {
      els.spreadChartBody.hidden = true;
      els.spreadChartMessage.hidden = false;
      els.spreadChartMessage.textContent = 'Нет данных по истории фандинга за последние 30 дней.';
      return;
    }

    drawSpreadPairChart(shortHistory, longHistory);
  } catch (err) {
    els.spreadChartBody.hidden = true;
    els.spreadChartMessage.hidden = false;
    els.spreadChartMessage.textContent = 'Не удалось загрузить историю: ' + (err.message || err);
  }
}

function openSpreadChart(data) {
  els.spreadChartOverlay.hidden = false;
  els.spreadChartTitle.textContent = `${data.baseAsset} — ставка фандинга за 30 дней`;
  els.spreadChartSubtitle.textContent = `${data.shortLabel} (шорт) · ${data.shortSymbol}  vs  ${data.longLabel} (лонг) · ${data.longSymbol}`;
  els.spreadChartLegend.innerHTML = `
    <span><span class="dot" style="background:${SPREAD_CHART_COLORS.short}"></span>${data.shortLabel} — шорт</span>
    <span><span class="dot" style="background:${SPREAD_CHART_COLORS.long}"></span>${data.longLabel} — лонг</span>
  `;
  loadSpreadPairChart(data);
}

els.tbody.addEventListener('click', (e) => {
  const starBtn = e.target.closest('.fav-star');
  if (starBtn) {
    const symbol = starBtn.dataset.symbol;
    if (state.favorites.has(symbol)) {
      state.favorites.delete(symbol);
      removeFavorite(symbol);
    } else {
      state.favorites.add(symbol);
      addFavorite(symbol);
    }
    render();
    return;
  }

  const btn = e.target.closest('.coin-link');
  if (!btn) return;
  const { exchange, symbol } = btn.dataset;
  const row = state.rows.find((r) => r.exchange === exchange && r.symbol === symbol);
  if (row) openCoinChart(row);
});

els.favToggle.addEventListener('click', () => {
  state.showFavoritesOnly = !state.showFavoritesOnly;
  render();
});

els.spreadTbody.addEventListener('click', (e) => {
  const starBtn = e.target.closest('.fav-star');
  if (starBtn) {
    const symbol = starBtn.dataset.symbol;
    if (state.favorites.has(symbol)) {
      state.favorites.delete(symbol);
      removeFavorite(symbol);
    } else {
      state.favorites.add(symbol);
      addFavorite(symbol);
    }
    render();
    return;
  }

  const btn = e.target.closest('.coin-link');
  if (!btn) return;
  const d = btn.dataset;
  openSpreadChart({
    baseAsset: d.base,
    shortExchange: d.shortExchange,
    shortSymbol: d.shortSymbol,
    shortIntervalHours: d.shortInterval,
    shortLabel: d.shortLabel,
    longExchange: d.longExchange,
    longSymbol: d.longSymbol,
    longIntervalHours: d.longInterval,
    longLabel: d.longLabel,
  });
});

els.chartClose.addEventListener('click', closeChart);
els.chartOverlay.addEventListener('click', (e) => {
  if (e.target === els.chartOverlay) closeChart();
});
els.spreadChartClose.addEventListener('click', closeSpreadChart);
els.spreadChartOverlay.addEventListener('click', (e) => {
  if (e.target === els.spreadChartOverlay) closeSpreadChart();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.chartOverlay.hidden) closeChart();
  if (e.key === 'Escape' && !els.spreadChartOverlay.hidden) closeSpreadChart();
});

loadFavorites().then((favorites) => {
  state.favorites = favorites;
  render();
});
loadData();
setInterval(loadData, 60 * 1000);

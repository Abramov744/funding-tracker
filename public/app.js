const state = {
  rows: [],
  updatedAt: null,
  sortKey: 'aprPct',
  sortDir: 'desc',
};

const els = {
  tbody: document.getElementById('tbody'),
  status: document.getElementById('status'),
  errorBanner: document.getElementById('errorBanner'),
  emptyState: document.getElementById('emptyState'),
  table: document.getElementById('table'),
  search: document.getElementById('search'),
  minApr: document.getElementById('minApr'),
  minPositiveRatio: document.getElementById('minPositiveRatio'),
  minPeriods: document.getElementById('minPeriods'),
  maxRank: document.getElementById('maxRank'),
  noNegatives: document.getElementById('noNegatives'),
  onlyChecked: document.getElementById('onlyChecked'),
  onlyMatch: document.getElementById('onlyMatch'),
  refreshBtn: document.getElementById('refreshBtn'),
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

function fmtRelativeTime(ts) {
  if (!ts) return '—';
  const diffMs = ts - Date.now();
  const mins = Math.round(diffMs / 60000);
  if (mins <= 0) return 'скоро';
  if (mins < 60) return `через ${mins} мин`;
  const hours = (mins / 60).toFixed(1);
  return `через ${hours} ч`;
}

function rowMatchesStrategy(row) {
  const minApr = Number(els.minApr.value);
  const minRatio = Number(els.minPositiveRatio.value) / 100;
  const minPeriods = Number(els.minPeriods.value);
  if (row.aprPct === null || row.aprPct < minApr) return false;
  if (row.positiveRatio === null || row.positiveRatio < minRatio) return false;
  if (row.periods < minPeriods) return false;
  if (els.noNegatives.checked && (row.minRate === null || row.minRate < 0)) return false;
  const maxRank = els.maxRank.value ? Number(els.maxRank.value) : null;
  if (maxRank !== null && (row.marketCapRank === null || row.marketCapRank > maxRank)) return false;
  return true;
}

function getFilteredRows() {
  const activeExchanges = new Set(
    Array.from(document.querySelectorAll('.ex-filter:checked')).map((el) => el.value)
  );
  const search = els.search.value.trim().toUpperCase();
  const onlyChecked = els.onlyChecked.checked;
  const onlyMatch = els.onlyMatch.checked;

  return state.rows.filter((row) => {
    if (!activeExchanges.has(row.exchange)) return false;
    if (search && !row.baseAsset.toUpperCase().includes(search)) return false;
    if (onlyChecked && !row.historyChecked) return false;
    if (onlyMatch && !rowMatchesStrategy(row)) return false;
    return true;
  });
}

function sortRows(rows) {
  const { sortKey, sortDir } = state;
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

function updateSortArrows() {
  document.querySelectorAll('th[data-key]').forEach((th) => {
    const arrow = th.querySelector('.sort-arrow');
    if (!arrow) return;
    arrow.textContent = th.dataset.key === state.sortKey ? (state.sortDir === 'asc' ? '▲' : '▼') : '';
  });
}

function render() {
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

    tr.innerHTML = `
      <td>${row.exchangeLabel}</td>
      <td><strong>${row.baseAsset}</strong></td>
      <td>${row.marketCapRank ?? '—'}</td>
      <td class="muted">${row.symbol}</td>
      <td class="${rateClass}">${fmtPct(row.fundingRate)}</td>
      <td>${row.intervalHours ?? '—'}</td>
      <td class="${aprClass}">${fmtAprPct(row.aprPct)}</td>
      <td class="muted">${fmtRelativeTime(row.nextFundingTime)}</td>
      <td>${row.periods}</td>
      <td>${fmtRatio(row.positiveRatio)}</td>
      <td class="${row.minRate < 0 ? 'negative' : ''}">${fmtPct(row.minRate)}</td>
      <td>${fmtAprPct(row.avgAprPct)}</td>
    `;
    els.tbody.appendChild(tr);
  }

  const ts = state.updatedAt ? new Date(state.updatedAt).toLocaleTimeString('ru-RU') : '—';
  els.status.textContent = `Обновлено: ${ts} · строк: ${rows.length}/${state.rows.length}`;
}

async function loadData() {
  const res = await fetch('/api/funding');
  const data = await res.json();
  state.rows = data.rows || [];
  state.updatedAt = data.updatedAt;

  const errorEntries = Object.entries(data.errors || {});
  if (errorEntries.length) {
    els.errorBanner.hidden = false;
    els.errorBanner.textContent =
      'Ошибки при опросе бирж: ' + errorEntries.map(([ex, msg]) => `${ex} — ${msg}`).join(' · ');
  } else {
    els.errorBanner.hidden = true;
  }

  render();
}

document.querySelectorAll('th[data-key]').forEach((th) => {
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

[
  els.search,
  els.minApr,
  els.minPositiveRatio,
  els.minPeriods,
  els.maxRank,
  els.noNegatives,
  els.onlyChecked,
  els.onlyMatch,
].forEach((el) => el.addEventListener('input', render));

document.querySelectorAll('.ex-filter').forEach((el) => el.addEventListener('change', render));

els.refreshBtn.addEventListener('click', async () => {
  els.refreshBtn.disabled = true;
  els.status.textContent = 'Обновление...';
  try {
    await fetch('/api/refresh', { method: 'POST' });
    await loadData();
  } finally {
    els.refreshBtn.disabled = false;
  }
});

loadData();
setInterval(loadData, 60 * 1000);

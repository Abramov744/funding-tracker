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
  chartOverlay: document.getElementById('chartOverlay'),
  chartClose: document.getElementById('chartClose'),
  chartTitle: document.getElementById('chartTitle'),
  chartSubtitle: document.getElementById('chartSubtitle'),
  chartFuturesPrice: document.getElementById('chartFuturesPrice'),
  chartBody: document.getElementById('chartBody'),
  chartCanvas: document.getElementById('chartCanvas'),
  chartMessage: document.getElementById('chartMessage'),
  spotList: document.getElementById('spotList'),
  spotMessage: document.getElementById('spotMessage'),
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
      <td><button type="button" class="coin-link" data-exchange="${row.exchange}" data-symbol="${row.symbol}" data-interval="${row.intervalHours ?? ''}">${row.baseAsset}</button></td>
      <td>${row.marketCapRank ?? '—'}</td>
      <td class="${rateClass}">${fmtPct(row.fundingRate)}</td>
      <td class="${aprClass}">${fmtAprPct(row.aprPct)}</td>
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

function spotRowHtml(v) {
  return `
    <div class="spot-row">
      <span class="spot-exchange">${v.name}</span>
      <span class="spot-price">${fmtPrice(v.price)} <span class="muted">${v.quote}</span></span>
    </div>
  `;
}

async function loadSpotVenues(baseAsset) {
  els.spotMessage.hidden = true;
  els.spotList.hidden = false;
  els.spotList.innerHTML = '<p class="chart-message">Загрузка…</p>';

  try {
    const res = await fetch(`/api/spot-prices?symbol=${encodeURIComponent(baseAsset)}`);
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

  // Independent lookups — kick both off at once instead of chaining them.
  loadFundingChart(row);
  loadSpotVenues(row.baseAsset);
}

els.tbody.addEventListener('click', (e) => {
  const btn = e.target.closest('.coin-link');
  if (!btn) return;
  const { exchange, symbol } = btn.dataset;
  const row = state.rows.find((r) => r.exchange === exchange && r.symbol === symbol);
  if (row) openCoinChart(row);
});

els.chartClose.addEventListener('click', closeChart);
els.chartOverlay.addEventListener('click', (e) => {
  if (e.target === els.chartOverlay) closeChart();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.chartOverlay.hidden) closeChart();
});

loadData();
setInterval(loadData, 60 * 1000);

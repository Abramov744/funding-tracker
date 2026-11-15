// Locally accumulated funding settlements for exchanges without a public
// per-market history endpoint. Keep this store exchange-agnostic so each
// venue's data has the same hard 30-day retention window.
const fs = require('fs');
const path = require('path');
const { dataDir } = require('./dataDir');

const HISTORY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const STALE_SYMBOL_MS = 3 * 24 * 60 * 60 * 1000;
const STORE_PATH = path.join(dataDir(), 'funding-history.json');
const LEGACY_VARIATIONAL_PATH = path.join(dataDir(), 'variational-funding-history.json');

// "exchange:symbol" -> { points: [{ time, rate }], cursor, lastSeenAt }
const state = new Map();
let legacyStoreLoaded = false;

function keyOf(exchange, symbol) {
  return `${exchange}:${symbol}`;
}

function trimPoints(points, now = Date.now()) {
  const cutoff = now - HISTORY_WINDOW_MS;
  return points
    .filter((point) => point && Number.isFinite(point.time) && Number.isFinite(point.rate) && point.time >= cutoff)
    .sort((a, b) => a.time - b.time);
}

function importEntries(parsed, exchange) {
  if (!parsed || typeof parsed !== 'object') return;
  for (const [symbol, entry] of Object.entries(parsed)) {
    if (!entry || !Array.isArray(entry.points)) continue;
    const key = keyOf(exchange, symbol);
    const current = state.get(key);
    const points = trimPoints([...(current?.points || []), ...entry.points]);
    state.set(key, {
      points,
      cursor: entry.cursor || current?.cursor || null,
      lastSeenAt: Math.max(Number(entry.lastSeenAt) || 0, current?.lastSeenAt || 0),
    });
  }
}

function loadFromDisk() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      for (const [key, entry] of Object.entries(parsed)) {
        if (!entry || !Array.isArray(entry.points)) continue;
        state.set(key, {
          points: trimPoints(entry.points),
          cursor: entry.cursor || null,
          lastSeenAt: Number(entry.lastSeenAt) || 0,
        });
      }
    }
  } catch {
    // First boot or no persistent disk yet.
  }

  // Preserve existing Variational history when migrating from the old
  // exchange-specific file to the shared store.
  try {
    const legacy = JSON.parse(fs.readFileSync(LEGACY_VARIATIONAL_PATH, 'utf8'));
    if (legacy && typeof legacy === 'object') {
      importEntries(legacy, 'variational');
      legacyStoreLoaded = true;
    }
  } catch {
    // No legacy file to migrate.
  }
}

function saveToDisk() {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    const obj = {};
    for (const [key, entry] of state) obj[key] = entry;
    fs.writeFileSync(STORE_PATH, JSON.stringify(obj));
    return true;
  } catch (err) {
    console.error('Failed to persist funding history:', err.message || err);
    return false;
  }
}

loadFromDisk();

// Track the funding rate in effect until the next settlement boundary. When
// the exchange's nextFundingTime advances, the previous rate becomes a
// completed history point.
function recordObservation(exchange, symbol, { rate, nextFundingTime }) {
  if (!exchange || !symbol || !Number.isFinite(rate) || !Number.isFinite(nextFundingTime)) return;
  const now = Date.now();
  const key = keyOf(exchange, symbol);
  const entry = state.get(key) || { points: [], cursor: null, lastSeenAt: 0 };
  entry.points = trimPoints(entry.points, now);
  entry.lastSeenAt = now;

  if (entry.cursor && now >= entry.cursor.nextFundingTime && nextFundingTime !== entry.cursor.nextFundingTime) {
    entry.points.push({ time: entry.cursor.nextFundingTime, rate: entry.cursor.rate });
    entry.points = trimPoints(entry.points, now);
  }
  entry.cursor = { nextFundingTime, rate };
  state.set(key, entry);
}

// Call after one bulk observation cycle to persist and prune in one write.
function flush() {
  const now = Date.now();
  for (const [key, entry] of state) {
    entry.points = trimPoints(entry.points, now);
    if (now - entry.lastSeenAt > STALE_SYMBOL_MS && entry.points.length === 0) state.delete(key);
  }
  const saved = saveToDisk();
  if (legacyStoreLoaded && saved) {
    try { fs.unlinkSync(LEGACY_VARIATIONAL_PATH); } catch { /* absent or already migrated */ }
    legacyStoreLoaded = false;
  }
}

function getHistory(exchange, symbol, limit = 750) {
  const entry = state.get(keyOf(exchange, symbol));
  if (!entry || !limit) return [];
  return trimPoints(entry.points).slice(-limit);
}

module.exports = { recordObservation, flush, getHistory, HISTORY_WINDOW_MS };

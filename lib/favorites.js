// Server-side favorites list (by base asset, e.g. "BTC") — shared across
// sessions rather than kept per-browser, because it now drives real scanning
// behavior: lib/cache.js force-includes a favorited coin in every exchange's
// history-fetch candidate set regardless of its current-rate ranking, so it
// keeps getting monitored even if it would otherwise fall out of the
// top-N-by-rate cutoff. Persisted to disk (same pattern as guest-logins.json)
// so it survives a redeploy as long as a volume is mounted.
const fs = require('fs');
const path = require('path');
const { dataDir } = require('./dataDir');

const FAVORITES_PATH = path.join(dataDir(), 'favorites.json');

function loadFromDisk() {
  try {
    const raw = fs.readFileSync(FAVORITES_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

const favorites = loadFromDisk();

function persist() {
  try {
    fs.mkdirSync(path.dirname(FAVORITES_PATH), { recursive: true });
    fs.writeFileSync(FAVORITES_PATH, JSON.stringify([...favorites]));
  } catch (err) {
    console.error('Failed to persist favorites:', err.message || err);
  }
}

function list() {
  return [...favorites];
}

function add(baseAsset) {
  favorites.add(String(baseAsset).toUpperCase());
  persist();
}

function remove(baseAsset) {
  favorites.delete(String(baseAsset).toUpperCase());
  persist();
}

function has(baseAsset) {
  return favorites.has(String(baseAsset).toUpperCase());
}

module.exports = { list, add, remove, has };

// Server-side favorites lists (by base asset, e.g. "BTC") — shared across
// sessions rather than kept per-browser, because they drive real scanning
// behavior: lib/cache.js force-includes a favorited coin in every exchange's
// history-fetch candidate set regardless of its current-rate ranking, so it
// keeps getting monitored even if it would otherwise fall out of the
// top-N-by-rate cutoff. Persisted to disk (same pattern as guest-logins.json)
// so it survives a redeploy as long as a volume is mounted.
//
// Kept as one independent list per tab (funding / spread) rather than one
// shared list — starring a coin on the spot+short table and starring it on
// the futures-futures table are different intents, and conflating them meant
// a star on one tab silently affected what showed up on the other.
const fs = require('fs');
const path = require('path');
const { dataDir } = require('./dataDir');

const FAVORITES_PATH = path.join(dataDir(), 'favorites.json');
const TABS = ['funding', 'spread'];

function normalizeTab(tab) {
  return TABS.includes(tab) ? tab : 'funding';
}

function loadFromDisk() {
  try {
    const raw = fs.readFileSync(FAVORITES_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    // Pre-split format was a flat array — treat it as the funding tab's list,
    // since that's the tab favorites originated on, rather than losing it.
    if (Array.isArray(parsed)) return { funding: new Set(parsed), spread: new Set() };
    const result = {};
    for (const tab of TABS) result[tab] = new Set(Array.isArray(parsed && parsed[tab]) ? parsed[tab] : []);
    return result;
  } catch {
    const result = {};
    for (const tab of TABS) result[tab] = new Set();
    return result;
  }
}

const favoritesByTab = loadFromDisk();

function persist() {
  try {
    fs.mkdirSync(path.dirname(FAVORITES_PATH), { recursive: true });
    const data = {};
    for (const tab of TABS) data[tab] = [...favoritesByTab[tab]];
    fs.writeFileSync(FAVORITES_PATH, JSON.stringify(data));
  } catch (err) {
    console.error('Failed to persist favorites:', err.message || err);
  }
}

function list(tab) {
  return [...favoritesByTab[normalizeTab(tab)]];
}

function add(tab, baseAsset) {
  favoritesByTab[normalizeTab(tab)].add(String(baseAsset).toUpperCase());
  persist();
}

function remove(tab, baseAsset) {
  favoritesByTab[normalizeTab(tab)].delete(String(baseAsset).toUpperCase());
  persist();
}

function has(tab, baseAsset) {
  return favoritesByTab[normalizeTab(tab)].has(String(baseAsset).toUpperCase());
}

// True if `baseAsset` is favorited on ANY tab — lib/cache.js uses this (not
// the per-tab `has`) to decide which coins to force-monitor, since a coin
// starred on either tab should keep getting its history fetched regardless
// of which tab's list it lives in.
function hasAny(baseAsset) {
  const upper = String(baseAsset).toUpperCase();
  return TABS.some((tab) => favoritesByTab[tab].has(upper));
}

module.exports = { list, add, remove, has, hasAny };

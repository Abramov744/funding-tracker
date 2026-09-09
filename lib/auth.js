// Minimal cookie-session auth for the whole app, plus a login log for the
// shared "guest" password so we can see how many people are actually using
// it and when. No session-store dependency: the cookie itself carries a
// signed { role, iat } payload, verified with HMAC on every request.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const USERNAME = 'admin';

// password -> role. "owner" is the real password (full access, including the
// guest-login report); "guest" is the one meant to be handed out publicly —
// every successful login with it gets logged.
const PASSWORDS_BY_ROLE = {
  '7444111': 'owner',
  guest: 'guest',
};

// Falls back to a random secret generated at boot if AUTH_SECRET isn't set
// in the environment — sessions then just don't survive a restart/redeploy
// (everyone has to log in again), which is a safe default rather than a
// broken one. Set AUTH_SECRET in Railway's variables to keep people logged
// in across deploys.
const SECRET = process.env.AUTH_SECRET || crypto.randomBytes(32).toString('hex');

const COOKIE_NAME = 'ft_session';
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Guest-login report: appended to on every guest login, read back by the
// admin-only /api/guest-logins endpoint. Kept as a small JSON file rather
// than only in memory so a process restart doesn't lose the count — note
// this still resets on a Railway *redeploy* without an attached Volume,
// since that's a fresh container filesystem.
const GUEST_LOG_PATH = path.join(__dirname, '..', 'data', 'guest-logins.json');
const GUEST_LOG_LIMIT = 2000; // keep the file from growing forever

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot === -1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || !payload.role || !payload.iat) return null;
    if (Date.now() - payload.iat > SESSION_MAX_AGE_MS) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    if (key) out[key] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

// Returns the role for a username/password pair, or null if it doesn't match.
function checkCredentials(username, password) {
  if (username !== USERNAME) return null;
  return PASSWORDS_BY_ROLE[password] || null;
}

function readGuestLog() {
  try {
    const raw = fs.readFileSync(GUEST_LOG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Called once per successful guest login (not on every request) — logs to
// stdout (Railway keeps deploy logs, so this survives even a redeploy that
// wipes the JSON file below) and appends to the on-disk report.
function recordGuestLogin(req) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
    .toString()
    .split(',')[0]
    .trim();
  const entry = { time: Date.now(), ip: ip || null };

  console.log(`[guest-login] ${new Date(entry.time).toISOString()} from ${entry.ip || 'unknown'}`);

  const log = readGuestLog();
  log.push(entry);
  while (log.length > GUEST_LOG_LIMIT) log.shift();

  try {
    fs.mkdirSync(path.dirname(GUEST_LOG_PATH), { recursive: true });
    fs.writeFileSync(GUEST_LOG_PATH, JSON.stringify(log));
  } catch (err) {
    console.error('Failed to persist guest login log:', err.message || err);
  }
}

// Express middleware: attaches req.session ({role, iat}) from a valid
// cookie, otherwise 401s API calls or redirects page loads to /login.html.
function requireAuth(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  const session = verify(cookies[COOKIE_NAME]);
  if (!session) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
    const next = encodeURIComponent(req.originalUrl || '/');
    return res.redirect(`/login.html?next=${next}`);
  }
  req.session = session;
  next();
}

function requireOwner(req, res, next) {
  if (!req.session || req.session.role !== 'owner') return res.status(403).json({ error: 'Forbidden' });
  next();
}

module.exports = {
  COOKIE_NAME,
  SESSION_MAX_AGE_MS,
  sign,
  checkCredentials,
  recordGuestLogin,
  readGuestLog,
  requireAuth,
  requireOwner,
};

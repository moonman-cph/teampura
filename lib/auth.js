'use strict';

const jwt = require('jsonwebtoken');

const COOKIE_NAME  = 'tp_session';
const JWT_EXPIRES  = '8h';

function getSecret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET env var is not set. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  return s;
}

// ── Token helpers ─────────────────────────────────────────────────────────────

function signToken(payload) {
  return jwt.sign(payload, getSecret(), { expiresIn: JWT_EXPIRES });
}

function verifyToken(token) {
  return jwt.verify(token, getSecret());
}

// ── Cookie helpers ────────────────────────────────────────────────────────────

function setCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge:   8 * 60 * 60 * 1000, // 8 hours in ms
  });
}

function clearCookie(res) {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'strict' });
}

// ── Middleware ────────────────────────────────────────────────────────────────

// Validates JWT cookie and attaches req.user = { userId, orgId, email, role, personId }
// Returns 401 if missing or expired.
// When DATABASE_URL is set, also checks force_logout_at to support server-side session invalidation.
async function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Authentication required.' });
  try {
    const payload = verifyToken(token);

    // Force-logout check: if an admin invalidated this user's sessions, reject JWTs
    // issued before the force_logout_at timestamp.
    if (process.env.DATABASE_URL && payload.userId) {
      const db   = require('../db');
      const user = await db.getUserById(payload.userId);
      if (user?.force_logout_at) {
        const issuedAt     = new Date(payload.iat * 1000);
        const forceLogoutAt = new Date(user.force_logout_at);
        if (issuedAt < forceLogoutAt) {
          clearCookie(res);
          return res.status(401).json({ error: 'Session invalidated. Please log in again.' });
        }
      }
    }

    req.user = payload;
    next();
  } catch {
    clearCookie(res);
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
}

// Requires one of the given roles on top of valid auth.
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Access denied.' });
    next();
  };
}

module.exports = { signToken, verifyToken, requireAuth, requireRole, setCookie, clearCookie, COOKIE_NAME };

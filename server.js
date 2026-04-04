'use strict';

require('dotenv').config();

const express      = require('express');
const cookieParser = require('cookie-parser');
const db           = require('./db');
const { requireAuth } = require('./lib/auth');
const v1Auth       = require('./routes/v1/auth');
const v1Data       = require('./routes/v1/data');
const v1Changelog  = require('./routes/v1/changelog');
const v1Ai         = require('./routes/v1/ai');
const v1Users      = require('./routes/v1/users');
const v1Jobs       = require('./routes/v1/jobs');
const scheduler    = require('./lib/scheduler');

const app  = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// ── Middleware ─────────────────────────────────────────────────────────────────

app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

app.use(express.static(__dirname));

// ── Public routes (no auth) ───────────────────────────────────────────────────

app.use('/api/v1/auth',  v1Auth);
app.use('/api/v1/users', requireAuth, v1Users);

// GET /api/v1/health — public; used as uptime monitor and operator status light
app.get('/api/v1/health', async (req, res) => {
  const checks = [];
  let status = 'green';

  // DB connectivity
  try {
    if (process.env.DATABASE_URL) {
      const { Pool } = require('pg');
      const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      await pool.query('SELECT 1');
      await pool.end();
      checks.push({ name: 'database', status: 'green' });
    } else {
      checks.push({ name: 'database', status: 'green', note: 'file mode' });
    }
  } catch (e) {
    checks.push({ name: 'database', status: 'red', error: 'DB unreachable' });
    status = 'red';
  }

  // Encryption key
  if (process.env.ENCRYPTION_KEY) {
    checks.push({ name: 'encryption', status: 'green' });
  } else {
    checks.push({ name: 'encryption', status: 'amber', note: 'ENCRYPTION_KEY not set — data stored unencrypted' });
    if (status === 'green') status = 'amber';
  }

  // JWT secret
  if (process.env.JWT_SECRET) {
    checks.push({ name: 'jwt', status: 'green' });
  } else {
    checks.push({ name: 'jwt', status: 'red', note: 'JWT_SECRET not set — authentication disabled' });
    status = 'red';
  }

  res.status(status === 'red' ? 503 : 200).json({ status, checks, timestamp: new Date().toISOString() });
});

// GET /api/v1/auth/demo — public; returns demo credentials if DEMO_EMAIL is set
app.get('/api/v1/auth/demo', (req, res) => {
  if (!process.env.DEMO_EMAIL || !process.env.DEMO_PASSWORD) {
    return res.json({ enabled: false });
  }
  res.json({ enabled: true, email: process.env.DEMO_EMAIL, password: process.env.DEMO_PASSWORD });
});

// ── Simulation data (in-memory only, cleared on server restart) ───────────────
let simData = null;

app.get('/api/sim-data',    requireAuth, (req, res) => simData ? res.json(simData) : res.status(404).json({ active: false }));
app.post('/api/sim-data',   requireAuth, (req, res) => { simData = req.body; res.json({ ok: true }); });
app.delete('/api/sim-data', requireAuth, (req, res) => { simData = null; res.json({ ok: true }); });

// ── Authenticated API routes ───────────────────────────────────────────────────

app.use('/api/v1/data',      requireAuth, v1Data);
app.use('/api/v1/changelog', requireAuth, v1Changelog);
app.use('/api/v1/ai',        requireAuth, v1Ai);
app.use('/api/v1/jobs',      requireAuth, v1Jobs);

// M1 backward-compatible aliases (also authenticated)
app.use('/api/data',      requireAuth, v1Data);
app.use('/api/changelog', requireAuth, v1Changelog);

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  const storage = process.env.DATABASE_URL ? 'PostgreSQL' : `file (${db.DATA_FILE})`;
  console.log(`Teampura running at http://localhost:${PORT}`);
  console.log(`Storage: ${storage}`);
  if (!process.env.JWT_SECRET)     console.warn('[warn] JWT_SECRET is not set — authentication will not work.');
  if (!process.env.ENCRYPTION_KEY) console.warn('[warn] ENCRYPTION_KEY is not set — sensitive data is not encrypted at rest.');

  // Sync demo user password from DEMO_PASSWORD env var on every startup.
  // This ensures Azure env var changes take effect immediately after restart
  // without waiting for the first authenticated request to trigger ensureSchema().
  db.syncDemoUser().catch(e => console.error('[startup] demo user sync failed:', e.message));

  // Start background scheduler — executes planned changes and captures daily metrics.
  // Polls every 60s. Safe to call even if DATABASE_URL is unset (no-op in file mode).
  scheduler.start();
});

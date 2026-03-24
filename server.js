'use strict';

require('dotenv').config();

const express = require('express');
const db      = require('./db');
const { generateUUID, diffState } = require('./lib/changelog-diff');

const app  = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// ── Express setup ─────────────────────────────────────────────────────────────

app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

// ── Simulation data (in-memory only, cleared on server restart) ───────────────
let simData = null;

app.get('/api/sim-data', (req, res) => {
  if (simData) res.json(simData);
  else res.status(404).json({ active: false });
});

app.post('/api/sim-data', (req, res) => {
  simData = req.body;
  res.json({ ok: true });
});

app.delete('/api/sim-data', (req, res) => {
  simData = null;
  res.json({ ok: true });
});

// ── Data endpoints ────────────────────────────────────────────────────────────

app.get('/api/data', (req, res) => {
  try {
    res.json(db.getData());
  } catch (e) {
    res.json({});
  }
});

app.post('/api/data', (req, res) => {
  try {
    // 1. Read current state for diffing
    const prev = db.getData();

    // 2. Write new state
    const next = req.body;
    db.setData(next);

    // 3. Extract metadata from headers
    const correlationId  = generateUUID();
    const rawReason      = (req.headers['x-change-reason'] || '').trim();
    const changeReason   = rawReason.slice(0, 500) || null;
    const rawSource      = req.headers['x-source'] || '';
    const source         = ['ui', 'csv_import', 'api', 'system'].includes(rawSource) ? rawSource : 'ui';
    const bulkId         = req.headers['x-bulk-id'] || null;
    const actorIp        = req.ip || req.headers['x-forwarded-for'] || null;
    const actorUserAgent = (req.headers['user-agent'] || '').slice(0, 500) || null;

    const meta = { changeReason, source, bulkId, actorIp, actorUserAgent, actorId: null, actorEmail: null, actorRole: null };

    // 4. Diff and append changelog (non-fatal — a changelog error must never block a save)
    try {
      const entries = diffState(prev, next, correlationId, meta);
      db.appendChangelogEntries(entries);
    } catch (clErr) {
      console.error('[changelog] diff/append failed:', clErr);
    }

    res.json({ ok: true, correlationId });
  } catch (e) {
    console.error('[api/data POST]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Changelog endpoints ───────────────────────────────────────────────────────

app.get('/api/changelog', (req, res) => {
  try {
    const log = db.getChangelog();

    const { correlationId, entityType, entityId, field, operation, source, bulkId, from, to, isSensitive } = req.query;
    const limit  = Math.min(parseInt(req.query.limit  || '200', 10), 1000);
    const offset = parseInt(req.query.offset || '0', 10);

    // Filter
    let filtered = log;
    if (correlationId)      filtered = filtered.filter(e => e.correlationId === correlationId);
    if (entityType)         filtered = filtered.filter(e => e.entityType === entityType);
    if (entityId)           filtered = filtered.filter(e => e.entityId === entityId);
    if (field)              filtered = filtered.filter(e => e.field === field);
    if (operation)          filtered = filtered.filter(e => e.operation === operation);
    if (source)             filtered = filtered.filter(e => e.source === source);
    if (bulkId)             filtered = filtered.filter(e => e.bulkId === bulkId);
    if (from)               filtered = filtered.filter(e => e.timestamp >= from);
    if (to)                 filtered = filtered.filter(e => e.timestamp <= to);
    if (isSensitive !== undefined) {
      const flag = isSensitive === 'true';
      filtered = filtered.filter(e => e.isSensitive === flag);
    }

    const total = filtered.length;
    filtered.reverse(); // newest first so limit always returns the most recent entries
    const page  = filtered.slice(offset, offset + limit);

    res.json({ total, limit, offset, entries: page });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/changelog/summary', (req, res) => {
  try {
    const log = db.getChangelog();

    const days = parseInt(req.query.days || '30', 10);
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const recent = log.filter(e => e.timestamp >= since);

    // Counts by day
    const byDayMap = {};
    for (const e of recent) {
      const day = e.timestamp.slice(0, 10);
      byDayMap[day] = (byDayMap[day] || 0) + 1;
    }
    const byDay = Object.entries(byDayMap).sort().map(([date, count]) => ({ date, count }));

    // Counts by entity type
    const byEntityType = {};
    for (const e of recent) {
      if (e.entityType) byEntityType[e.entityType] = (byEntityType[e.entityType] || 0) + 1;
    }

    // Counts by operation
    const byOperation = {};
    for (const e of recent) {
      byOperation[e.operation] = (byOperation[e.operation] || 0) + 1;
    }

    // Recent save batches (one entry per correlationId, using first entry's timestamp)
    const batchMap = {};
    for (const e of log) {
      if (!batchMap[e.correlationId]) {
        batchMap[e.correlationId] = {
          correlationId: e.correlationId,
          timestamp:     e.timestamp,
          source:        e.source,
          bulkId:        e.bulkId,
          changeReason:  e.changeReason,
          entryCount:    0,
          hasSensitive:  false,
        };
      }
      batchMap[e.correlationId].entryCount++;
      if (e.isSensitive) batchMap[e.correlationId].hasSensitive = true;
    }
    const recentBatches = Object.values(batchMap)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, 50);

    res.json({ byDay, byEntityType, byOperation, recentBatches });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Org chart running at http://localhost:${PORT}`);
  console.log(`Data file: ${db.DATA_FILE}`);
  console.log(`Changelog: ${db.CHANGELOG_FILE}`);
});

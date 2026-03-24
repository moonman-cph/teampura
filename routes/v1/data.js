'use strict';

const express = require('express');
const db      = require('../../db');
const { generateUUID, diffState } = require('../../lib/changelog-diff');

const router = express.Router();

router.get('/', (req, res) => {
  try {
    res.json(db.getData());
  } catch (e) {
    res.json({});
  }
});

router.post('/', (req, res) => {
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

module.exports = router;

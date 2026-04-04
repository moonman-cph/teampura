'use strict';

const express = require('express');
const db      = require('../../db');

const router = express.Router();

const WRITE_ROLES = ['super_admin', 'org_admin', 'hr'];

// ── POST /api/v1/jobs — create a scheduled job ────────────────────────────────
// Called by the UI when the user freezes a planned change (or future triggers).
// Body: { jobType, label, scheduledAt, payload }

router.post('/', async (req, res) => {
  try {
    if (!WRITE_ROLES.includes(req.user.role)) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    const { jobType, label, scheduledAt, payload } = req.body;

    if (!jobType)     return res.status(400).json({ error: 'jobType is required.' });
    if (!scheduledAt) return res.status(400).json({ error: 'scheduledAt is required.' });

    const ALLOWED_JOB_TYPES = ['PLANNED_CHANGE'];
    if (!ALLOWED_JOB_TYPES.includes(jobType)) {
      return res.status(400).json({ error: `Unknown jobType "${jobType}".` });
    }

    if (new Date(scheduledAt) <= new Date()) {
      return res.status(400).json({ error: 'scheduledAt must be in the future.' });
    }

    const job = await db.createScheduledJob({
      orgId:       req.user.orgId,
      jobType,
      label:       label   || null,
      payload:     payload || {},
      scheduledAt,
      createdBy:   req.user.email,
    });

    res.json(job);
  } catch (e) {
    console.error('[jobs POST]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/v1/jobs — list pending/running jobs for this org ─────────────────

router.get('/', async (req, res) => {
  try {
    const jobs = await db.listPendingJobs(req.user.orgId);
    res.json(jobs);
  } catch (e) {
    console.error('[jobs GET]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/v1/jobs/:id — cancel a pending job ───────────────────────────

router.delete('/:id', async (req, res) => {
  try {
    if (!WRITE_ROLES.includes(req.user.role)) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    await db.cancelScheduledJob(req.params.id, req.user.orgId);
    res.json({ ok: true });
  } catch (e) {
    console.error('[jobs DELETE]', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

'use strict';

const crypto = require('crypto');
const db     = require('../db');
const { diffState } = require('./changelog-diff');

const POLL_INTERVAL_MS = 60 * 1000; // 60 seconds

let _timer = null;

// ── Main poll loop ────────────────────────────────────────────────────────────

async function pollAndExecute() {
  if (!process.env.DATABASE_URL) return; // file mode — scheduler disabled

  try {
    // 1. Execute any due scheduled jobs
    const jobs = await db.getDueJobs();
    for (const job of jobs) {
      await executeJob(job);
    }

    // 2. Capture daily metrics if not yet captured today (all known orgs)
    // For M4 with a single default org — extend to multi-org in M4+
    await captureDailyMetricsIfNeeded('default');

  } catch (e) {
    console.error('[scheduler] poll error:', e.message);
  }
}

// ── Job dispatch ─────────────────────────────────────────────────────────────

async function executeJob(job) {
  await db.markJobRunning(job.id);

  try {
    switch (job.job_type) {
      case 'PLANNED_CHANGE':
        await executePlannedChange(job);
        break;
      default:
        throw new Error(`Unknown job_type: ${job.job_type}`);
    }
    await db.markJobCompleted(job.id);
    console.log(`[scheduler] Job ${job.id} (${job.job_type}) completed`);
  } catch (e) {
    console.error(`[scheduler] Job ${job.id} (${job.job_type}) failed:`, e.message);
    await db.markJobFailed(job.id, e.message);
  }
}

// ── PLANNED_CHANGE executor ───────────────────────────────────────────────────

async function executePlannedChange(job) {
  const orgId = job.org_id;
  const { label, data } = job.payload;

  if (!data) throw new Error('Job payload missing "data" field');

  const correlationId = crypto.randomUUID();

  // Load current live state for diffing and snapshot
  const prev = await db.getData(orgId);

  // Auto-snapshot the pre-change state (mirrors what the browser does)
  const beforeSnapshot = {
    id:    Date.now(),
    label: `Before: ${label || 'Planned Change'}`,
    date:  new Date().toISOString(),
    data: {
      departments:     prev.departments,
      teams:           prev.teams,
      roles:           prev.roles,
      persons:         prev.persons,
      roleAssignments: prev.roleAssignments,
    },
  };

  // Build next state: merge planned data on top of live state, clear plannedChange
  const next = {
    ...prev,
    departments:     data.departments     ?? prev.departments,
    teams:           data.teams           ?? prev.teams,
    roles:           data.roles           ?? prev.roles,
    persons:         data.persons         ?? prev.persons,
    roleAssignments: data.roleAssignments ?? prev.roleAssignments,
    snapshots:       [...(prev.snapshots ?? []), beforeSnapshot],
    plannedChange:   null,
  };

  // Persist the new state
  await db.setData(next, orgId);

  // Write field-level audit log entries
  const meta = {
    actorId:        null,
    actorEmail:     'system',
    actorRole:      'system',
    actorIp:        null,
    actorUserAgent: 'Teampura Scheduler',
    source:         'scheduled_job',
    changeReason:   `Scheduled planned change: ${label || 'Planned Change'}`,
    bulkId:         null,
  };

  try {
    const entries = diffState(prev, next, correlationId, meta);
    await db.appendChangelogEntries(entries);
  } catch (diffErr) {
    console.error('[scheduler] changelog diff failed:', diffErr.message);
  }

  console.log(`[scheduler] Planned change "${label}" applied for org ${orgId}`);
}

// ── Daily metrics capture ─────────────────────────────────────────────────────

async function captureDailyMetricsIfNeeded(orgId) {
  try {
    const already = await db.hasDailyMetricsForToday(orgId);
    if (!already) {
      await db.captureDailyMetrics(orgId);
      console.log(`[scheduler] Daily metrics captured for org ${orgId}`);
    }
  } catch (e) {
    console.error(`[scheduler] Daily metrics capture failed for org ${orgId}:`, e.message);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

function start() {
  if (!process.env.DATABASE_URL) {
    console.log('[scheduler] DATABASE_URL not set — scheduler disabled (file mode)');
    return;
  }
  if (_timer) return; // already running

  console.log('[scheduler] Starting background scheduler (poll every 60s)');

  // Immediate first poll (catches any jobs that were due while server was down)
  pollAndExecute().catch(e => console.error('[scheduler] startup poll error:', e.message));

  _timer = setInterval(() => {
    pollAndExecute().catch(e => console.error('[scheduler] interval poll error:', e.message));
  }, POLL_INTERVAL_MS);
}

function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

module.exports = { start, stop };

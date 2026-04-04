'use strict';

const crypto  = require('crypto');
const express = require('express');
const db      = require('../../db');
const { requireAuth, requireRole } = require('../../lib/auth');

const router = express.Router();

// All routes in this file require super_admin
router.use(requireRole('super_admin'));

// ── Helpers ───────────────────────────────────────────────────────────────────

function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

function auditOrgAction(req, operation, orgId, orgLabel, field, oldValue, newValue) {
  db.appendChangelogEntries([{
    id:            newId(),
    orgId:         req.user.orgId,
    correlationId: newId(),
    timestamp:     new Date().toISOString(),
    actorId:       req.user.userId,
    actorEmail:    req.user.email,
    actorRole:     req.user.role,
    actorIp:       req.ip || null,
    actorUserAgent: req.headers['user-agent'] || null,
    operation,
    entityType:    'organisation',
    entityId:      orgId,
    entityLabel:   orgLabel,
    field:         field || null,
    oldValue:      oldValue ?? null,
    newValue:      newValue ?? null,
    changeReason:  req.headers['x-change-reason'] || null,
    source:        'ui',
    bulkId:        null,
    isSensitive:   false,
  }]).catch(err => console.error('[orgs/audit]', err));
}

const VALID_TIERS = ['trial', 'starter', 'pro', 'enterprise'];
const SLUG_RE     = /^[a-z0-9-]+$/;

// ── GET /api/v1/orgs — list all organisations ─────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const orgs = await db.listOrgs();
    res.json(orgs);
  } catch (e) {
    console.error('[orgs/list]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/v1/orgs — create a new organisation ────────────────────────────

router.post('/', async (req, res) => {
  try {
    const { name, slug, planTier = 'trial' } = req.body || {};

    if (!name || typeof name !== 'string' || !name.trim())
      return res.status(400).json({ error: 'name is required.' });
    if (!slug || typeof slug !== 'string')
      return res.status(400).json({ error: 'slug is required.' });
    if (!SLUG_RE.test(slug))
      return res.status(400).json({ error: 'slug must contain only lowercase letters, numbers, and hyphens.' });
    if (!VALID_TIERS.includes(planTier))
      return res.status(400).json({ error: `planTier must be one of: ${VALID_TIERS.join(', ')}` });

    const org = await db.createOrg({
      id:        slug,
      slug,
      name:      name.trim(),
      planTier,
      createdBy: req.user.userId,
    });

    auditOrgAction(req, 'CREATE', org.id, org.name, null, null, { name: org.name, slug: org.slug, planTier: org.planTier });
    res.status(201).json(org);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'An organisation with that slug already exists.' });
    console.error('[orgs/create]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/v1/orgs/:orgId — org detail ─────────────────────────────────────

router.get('/:orgId', async (req, res) => {
  try {
    const org = await db.getOrgById(req.params.orgId);
    if (!org) return res.status(404).json({ error: 'Organisation not found.' });
    res.json(org);
  } catch (e) {
    console.error('[orgs/get]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── PATCH /api/v1/orgs/:orgId — edit org metadata ────────────────────────────

router.patch('/:orgId', async (req, res) => {
  try {
    const { orgId } = req.params;

    // Guard: slug and id are immutable
    if (req.body?.id || req.body?.slug)
      return res.status(400).json({ error: 'id and slug cannot be changed after creation.' });

    const { name, planTier, trialExpiresAt } = req.body || {};

    if (planTier !== undefined && !VALID_TIERS.includes(planTier))
      return res.status(400).json({ error: `planTier must be one of: ${VALID_TIERS.join(', ')}` });

    const before = await db.getOrgById(orgId);
    if (!before) return res.status(404).json({ error: 'Organisation not found.' });

    const updated = await db.updateOrg(orgId, { name, planTier, trialExpiresAt });

    // Audit each changed field
    const corrId = newId();
    const fields = [
      ['name', before.name, updated.name],
      ['planTier', before.planTier, updated.planTier],
      ['trialExpiresAt', before.trialExpiresAt, updated.trialExpiresAt],
    ];
    const entries = fields
      .filter(([, oldVal, newVal]) => oldVal !== newVal)
      .map(([field, oldVal, newVal]) => ({
        id:            newId(),
        orgId:         req.user.orgId,
        correlationId: corrId,
        timestamp:     new Date().toISOString(),
        actorId:       req.user.userId,
        actorEmail:    req.user.email,
        actorRole:     req.user.role,
        actorIp:       req.ip || null,
        actorUserAgent: req.headers['user-agent'] || null,
        operation:     'UPDATE',
        entityType:    'organisation',
        entityId:      orgId,
        entityLabel:   updated.name,
        field,
        oldValue:      oldVal,
        newValue:      newVal,
        changeReason:  req.headers['x-change-reason'] || null,
        source:        'ui',
        bulkId:        null,
        isSensitive:   false,
      }));
    if (entries.length) db.appendChangelogEntries(entries).catch(err => console.error('[orgs/audit]', err));

    res.json(updated);
  } catch (e) {
    console.error('[orgs/update]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/v1/orgs/:orgId/suspend ─────────────────────────────────────────

router.post('/:orgId/suspend', async (req, res) => {
  try {
    const { orgId } = req.params;
    const org = await db.getOrgById(orgId);
    if (!org) return res.status(404).json({ error: 'Organisation not found.' });
    if (org.status === 'suspended') return res.status(409).json({ error: 'Organisation is already suspended.' });

    const updated = await db.setOrgStatus(orgId, 'suspended');
    auditOrgAction(req, 'UPDATE', orgId, org.name, 'status', 'active', 'suspended');
    res.json({ ok: true, status: updated.status });
  } catch (e) {
    console.error('[orgs/suspend]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/v1/orgs/:orgId/reactivate ──────────────────────────────────────

router.post('/:orgId/reactivate', async (req, res) => {
  try {
    const { orgId } = req.params;
    const org = await db.getOrgById(orgId);
    if (!org) return res.status(404).json({ error: 'Organisation not found.' });
    if (org.status === 'active') return res.status(409).json({ error: 'Organisation is already active.' });

    const updated = await db.setOrgStatus(orgId, 'active');
    auditOrgAction(req, 'UPDATE', orgId, org.name, 'status', 'suspended', 'active');
    res.json({ ok: true, status: updated.status });
  } catch (e) {
    console.error('[orgs/reactivate]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/v1/orgs/:orgId/offboard ────────────────────────────────────────
// Exports all org data as JSON, then permanently deletes all rows for that org.
// Requires { confirm: true, confirmSlug: "<slug>" } in the request body.
// The audit entry is written to the OPERATOR's org before deletion.

router.post('/:orgId/offboard', async (req, res) => {
  try {
    const { orgId } = req.params;

    if (req.body?.confirm !== true)
      return res.status(400).json({ error: 'confirm: true is required.' });
    if (!req.body?.confirmSlug)
      return res.status(400).json({ error: 'confirmSlug is required.' });

    const org = await db.getOrgById(orgId);
    if (!org) return res.status(404).json({ error: 'Organisation not found.' });

    if (req.body.confirmSlug !== org.slug)
      return res.status(400).json({ error: `confirmSlug does not match. Expected: "${org.slug}"` });

    // Write audit entry on the operator's org BEFORE deleting target org data
    auditOrgAction(req, 'DELETE', orgId, org.name, null, { name: org.name, slug: org.slug }, null);

    // Export then delete
    const exportData = await db.offboardOrg(orgId);

    res.setHeader('Content-Disposition', `attachment; filename="org-${org.slug}-export-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json(exportData);
  } catch (e) {
    console.error('[orgs/offboard]', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

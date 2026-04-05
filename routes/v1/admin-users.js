'use strict';

const crypto  = require('crypto');
const express = require('express');
const bcrypt  = require('bcryptjs');
const db      = require('../../db');
const { requireRole } = require('../../lib/auth');

const router = express.Router();

// All routes in this file require super_admin
router.use(requireRole('super_admin'));

function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

function auditUserAction(req, operation, userId, userEmail, field, oldValue, newValue) {
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
    entityType:    'user',
    entityId:      userId,
    entityLabel:   userEmail,
    field:         field || null,
    oldValue:      oldValue ?? null,
    newValue:      newValue ?? null,
    changeReason:  req.headers['x-change-reason'] || null,
    source:        'ui',
    bulkId:        null,
    isSensitive:   false,
  }]).catch(err => console.error('[admin-users/audit]', err));
}

// ── POST /api/v1/admin/users — create a user for a specific org ──────────────
// Body: { orgId, email, password, role }

router.post('/', async (req, res) => {
  try {
    const { orgId, email, password, role = 'org_admin' } = req.body || {};

    if (!orgId || typeof orgId !== 'string')
      return res.status(400).json({ error: 'orgId is required.' });
    if (!email || typeof email !== 'string' || !email.includes('@'))
      return res.status(400).json({ error: 'Valid email is required.' });
    if (!password || typeof password !== 'string' || password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    const VALID_ROLES = ['super_admin', 'org_admin', 'hr', 'manager', 'employee'];
    if (!VALID_ROLES.includes(role))
      return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });

    const org = await db.getOrgById(orgId);
    if (!org) return res.status(404).json({ error: 'Organisation not found.' });

    const hash = await bcrypt.hash(password, 12);
    const user = await db.createUser({ orgId, email: email.trim(), passwordHash: hash, role });

    auditUserAction(req, 'CREATE', user.id, user.email, null, null, { orgId, email: user.email, role });
    res.status(201).json({
      id:         user.id,
      org_id:     user.org_id,
      email:      user.email,
      role:       user.role,
      status:     user.status || 'active',
      created_at: user.created_at,
    });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'A user with that email already exists.' });
    console.error('[admin-users/create]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/v1/admin/users — search users across all orgs ───────────────────
// Query params: q (email substring), orgId, status, limit (max 100)

router.get('/', async (req, res) => {
  try {
    const { q = '', orgId, status, limit } = req.query;
    const users = await db.searchUsers({
      q:      q.trim(),
      orgId:  orgId  || null,
      status: status || null,
      limit:  Math.min(Number(limit) || 100, 100),
    });
    res.json(users);
  } catch (e) {
    console.error('[admin-users/search]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/v1/admin/users/:userId — view user detail + recent audit entries ─

router.get('/:userId', async (req, res) => {
  try {
    const user = await db.getUserByIdAdmin(req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    res.json(user);
  } catch (e) {
    console.error('[admin-users/get]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/v1/admin/users/:userId/reset-password ──────────────────────────

router.post('/:userId/reset-password', async (req, res) => {
  try {
    const { newPassword } = req.body || {};
    if (!newPassword || typeof newPassword !== 'string')
      return res.status(400).json({ error: 'newPassword is required.' });
    if (newPassword.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    const user = await db.getUserById(req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const hash = await bcrypt.hash(newPassword, 12);
    await db.adminResetPassword(req.params.userId, hash);

    auditUserAction(req, 'UPDATE', user.id, user.email, 'password', null, 'reset');
    res.json({ ok: true });
  } catch (e) {
    console.error('[admin-users/reset-password]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/v1/admin/users/:userId/lock ────────────────────────────────────

router.post('/:userId/lock', async (req, res) => {
  try {
    const user = await db.getUserById(req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (user.status === 'locked') return res.status(409).json({ error: 'User is already locked.' });

    const updated = await db.setUserStatus(req.params.userId, 'locked');
    auditUserAction(req, 'UPDATE', user.id, user.email, 'status', user.status, 'locked');
    res.json({ ok: true, status: updated.status });
  } catch (e) {
    console.error('[admin-users/lock]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/v1/admin/users/:userId/unlock ───────────────────────────────────

router.post('/:userId/unlock', async (req, res) => {
  try {
    const user = await db.getUserById(req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (user.status === 'active') return res.status(409).json({ error: 'User is already active.' });

    const updated = await db.setUserStatus(req.params.userId, 'active');
    auditUserAction(req, 'UPDATE', user.id, user.email, 'status', user.status, 'active');
    res.json({ ok: true, status: updated.status });
  } catch (e) {
    console.error('[admin-users/unlock]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/v1/admin/users/:userId/force-logout ────────────────────────────
// Sets force_logout_at = now(). requireAuth checks this on every request;
// any JWT issued before this timestamp is rejected with 401.

router.post('/:userId/force-logout', async (req, res) => {
  try {
    const user = await db.getUserById(req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    await db.forceLogoutUser(req.params.userId);
    auditUserAction(req, 'UPDATE', user.id, user.email, 'force_logout_at', null, new Date().toISOString());
    res.json({ ok: true });
  } catch (e) {
    console.error('[admin-users/force-logout]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/v1/admin/users/:userId ───────────────────────────────────────

router.delete('/:userId', async (req, res) => {
  try {
    const user = await db.getUserById(req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (user.id === req.user.userId) return res.status(400).json({ error: 'Cannot delete your own account.' });

    await db.deleteUser(req.params.userId);
    auditUserAction(req, 'DELETE', user.id, user.email, null, { email: user.email, role: user.role }, null);
    res.json({ ok: true });
  } catch (e) {
    console.error('[admin-users/delete]', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

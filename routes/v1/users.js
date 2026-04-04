'use strict';

const crypto  = require('crypto');
const express = require('express');
const bcrypt  = require('bcryptjs');
const db      = require('../../db');
const { requireAuth, requireRole } = require('../../lib/auth');

const router      = express.Router();
const ADMIN_ROLES = ['super_admin', 'org_admin'];

// Roles an org_admin is permitted to assign (cannot create peers or super_admins)
const ORG_ADMIN_ASSIGNABLE_ROLES = ['hr', 'manager', 'employee'];
const ALL_VALID_ROLES             = ['super_admin', 'org_admin', 'hr', 'manager', 'employee'];

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
  }]).catch(err => console.error('[users/audit]', err));
}

// ── GET /api/v1/users — list users for the caller's org ──────────────────────

router.get('/', requireAuth, requireRole(...ADMIN_ROLES), async (req, res) => {
  try {
    const users = await db.listUsers(req.user.orgId);
    res.json(users);
  } catch (e) {
    console.error('[users/list]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/v1/users — create a new user (explicit password) ────────────────

router.post('/', requireAuth, requireRole(...ADMIN_ROLES), async (req, res) => {
  try {
    const { email, password, role = 'employee', personId = null } = req.body || {};
    if (!email || typeof email !== 'string') return res.status(400).json({ error: 'email is required.' });
    if (!password || typeof password !== 'string') return res.status(400).json({ error: 'password is required.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (!ALL_VALID_ROLES.includes(role)) return res.status(400).json({ error: `role must be one of: ${ALL_VALID_ROLES.join(', ')}` });

    // org_admin cannot create super_admin or org_admin peers
    if (req.user.role === 'org_admin' && !ORG_ADMIN_ASSIGNABLE_ROLES.includes(role))
      return res.status(403).json({ error: `org_admin can only assign roles: ${ORG_ADMIN_ASSIGNABLE_ROLES.join(', ')}` });

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await db.createUser({
      orgId: req.user.orgId,
      email: email.trim(),
      passwordHash,
      role,
      personId: personId || null,
    });

    auditUserAction(req, 'CREATE', user.id, user.email, null, null, { email: user.email, role: user.role });
    const { password_hash: _, ...safeUser } = user;
    res.status(201).json(safeUser);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'A user with that email already exists.' });
    console.error('[users/create]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/v1/users/invite — create user with a generated temp password ────
// Returns the temporary password in the response (no email infrastructure yet).
// Must come before /:userId routes so Express doesn't match "invite" as a userId.

router.post('/invite', requireAuth, requireRole(...ADMIN_ROLES), async (req, res) => {
  try {
    const { email, role = 'employee', personId = null } = req.body || {};
    if (!email || typeof email !== 'string') return res.status(400).json({ error: 'email is required.' });
    if (!ALL_VALID_ROLES.includes(role)) return res.status(400).json({ error: `role must be one of: ${ALL_VALID_ROLES.join(', ')}` });

    if (req.user.role === 'org_admin' && !ORG_ADMIN_ASSIGNABLE_ROLES.includes(role))
      return res.status(403).json({ error: `org_admin can only assign roles: ${ORG_ADMIN_ASSIGNABLE_ROLES.join(', ')}` });

    // Generate a readable temporary password: 3 words from random bytes
    const tempPassword = crypto.randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
    const passwordHash = await bcrypt.hash(tempPassword, 12);

    const user = await db.createUser({
      orgId: req.user.orgId,
      email: email.trim().toLowerCase(),
      passwordHash,
      role,
      personId: personId || null,
    });

    auditUserAction(req, 'CREATE', user.id, user.email, null, null, { email: user.email, role: user.role, invited: true });

    const { password_hash: _, ...safeUser } = user;
    // temporaryPassword is returned once — it cannot be recovered after this response
    res.status(201).json({ ...safeUser, temporaryPassword: tempPassword });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'A user with that email already exists.' });
    console.error('[users/invite]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── PATCH /api/v1/users/:userId — update role or status ──────────────────────

router.patch('/:userId', requireAuth, requireRole(...ADMIN_ROLES), async (req, res) => {
  try {
    const target = await db.getUserById(req.params.userId);
    if (!target) return res.status(404).json({ error: 'User not found.' });

    // Scope: org_admin can only modify users in their own org
    if (req.user.role === 'org_admin' && target.org_id !== req.user.orgId)
      return res.status(403).json({ error: 'Access denied.' });

    const { role, status } = req.body || {};
    const corrId  = newId();
    const entries = [];

    if (role !== undefined) {
      if (!ALL_VALID_ROLES.includes(role))
        return res.status(400).json({ error: `role must be one of: ${ALL_VALID_ROLES.join(', ')}` });
      // org_admin cannot promote to org_admin or super_admin
      if (req.user.role === 'org_admin' && !ORG_ADMIN_ASSIGNABLE_ROLES.includes(role))
        return res.status(403).json({ error: `org_admin cannot assign role: ${role}` });

      if (role !== target.role) {
        await db.updateUserRole(target.id, role);
        entries.push({ field: 'role', oldValue: target.role, newValue: role });
      }
    }

    if (status !== undefined) {
      const VALID_STATUSES = ['active', 'suspended', 'locked'];
      if (!VALID_STATUSES.includes(status))
        return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
      if (status !== target.status) {
        await db.setUserStatus(target.id, status);
        entries.push({ field: 'status', oldValue: target.status, newValue: status });
      }
    }

    if (entries.length) {
      db.appendChangelogEntries(entries.map(e => ({
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
        entityType:    'user',
        entityId:      target.id,
        entityLabel:   target.email,
        field:         e.field,
        oldValue:      e.oldValue,
        newValue:      e.newValue,
        changeReason:  req.headers['x-change-reason'] || null,
        source:        'ui',
        bulkId:        null,
        isSensitive:   false,
      }))).catch(err => console.error('[users/audit]', err));
    }

    const updated = await db.getUserById(target.id);
    const { password_hash: _, force_logout_at: __, ...safeUser } = updated;
    res.json(safeUser);
  } catch (e) {
    console.error('[users/update]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/v1/users/:userId — remove a user from the org ────────────────

router.delete('/:userId', requireAuth, requireRole(...ADMIN_ROLES), async (req, res) => {
  try {
    const target = await db.getUserById(req.params.userId);
    if (!target) return res.status(404).json({ error: 'User not found.' });

    // Cannot delete yourself
    if (target.id === req.user.userId)
      return res.status(400).json({ error: 'Cannot delete your own account.' });

    // org_admin scope: own org only, cannot delete other admins
    if (req.user.role === 'org_admin') {
      if (target.org_id !== req.user.orgId) return res.status(403).json({ error: 'Access denied.' });
      if (!ORG_ADMIN_ASSIGNABLE_ROLES.includes(target.role))
        return res.status(403).json({ error: 'org_admin cannot delete org_admin or super_admin accounts.' });
    }

    await db.deleteUser(target.id);
    auditUserAction(req, 'DELETE', target.id, target.email, null, { email: target.email, role: target.role }, null);
    res.json({ ok: true });
  } catch (e) {
    console.error('[users/delete]', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

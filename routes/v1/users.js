'use strict';

const express = require('express');
const bcrypt  = require('bcryptjs');
const db      = require('../../db');
const { requireAuth, requireRole } = require('../../lib/auth');

const router = express.Router();
const ADMIN_ROLES = ['super_admin', 'org_admin'];

// GET /api/v1/users — list all users for the org
router.get('/', requireAuth, requireRole(...ADMIN_ROLES), async (req, res) => {
  try {
    const users = await db.listUsers(req.user.orgId);
    res.json(users);
  } catch (e) {
    console.error('[users/list]', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/v1/users — create a new user
router.post('/', requireAuth, requireRole(...ADMIN_ROLES), async (req, res) => {
  try {
    const { email, password, role = 'employee', personId = null } = req.body || {};
    if (!email || typeof email !== 'string') return res.status(400).json({ error: 'email is required.' });
    if (!password || typeof password !== 'string') return res.status(400).json({ error: 'password is required.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    const VALID_ROLES = ['super_admin', 'org_admin', 'hr', 'manager', 'employee'];
    if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await db.createUser({
      orgId: req.user.orgId,
      email: email.trim(),
      passwordHash,
      role,
      personId: personId || null,
    });

    // Return without password_hash
    const { password_hash: _, ...safeUser } = user;
    res.status(201).json(safeUser);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'A user with that email already exists.' });
    console.error('[users/create]', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

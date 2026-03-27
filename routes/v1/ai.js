'use strict';

const express  = require('express');
const db       = require('../../db');
const { generateUUID }            = require('../../lib/changelog-diff');
const { roleToTier } = require('../../lib/data-scope');

const router = express.Router();

// ── Tier inference ─────────────────────────────────────────────────────────────
// Returns 'admin' | 'manager' | 'employee'

function inferTier(personId, data) {
  if (!personId) return 'employee';

  const pid = String(personId);
  const {
    permissionGroups        = [],
    assignmentPolicies      = [],
    personPermissionOverrides = [],
    roleAssignments         = [],
    roles                   = [],
  } = data;

  // Person's roles
  const personRoles = roleAssignments
    .filter(a => String(a.personId) === pid)
    .map(a => roles.find(r => String(r.id) === String(a.roleId)))
    .filter(Boolean);

  // Collect group IDs from assignment policies
  // A policy applies if ANY of the person's roles matches ALL of the policy's rules
  const collectedGroupIds = new Set();

  for (const policy of assignmentPolicies) {
    if (!Array.isArray(policy.rules) || !Array.isArray(policy.groupIds)) continue;
    const matchesAnyRole = personRoles.some(role =>
      policy.rules.every(rule => evaluateRule(rule, role))
    );
    if (matchesAnyRole) policy.groupIds.forEach(g => collectedGroupIds.add(g));
  }

  // Apply per-person overrides
  for (const override of personPermissionOverrides) {
    if (String(override.personId) === pid) {
      (override.addGroupIds    || []).forEach(g => collectedGroupIds.add(g));
      (override.removeGroupIds || []).forEach(g => collectedGroupIds.delete(g));
    }
  }

  // Collect rights from matched groups
  const rights = new Set();
  for (const group of permissionGroups) {
    if (collectedGroupIds.has(group.id)) {
      (group.rights || []).forEach(r => rights.add(r));
    }
  }

  if (rights.has('manage_settings') || rights.has('manage_permissions')) return 'admin';
  if (rights.has('view_salaries'))                                         return 'manager';
  return 'employee';
}

function evaluateRule(rule, role) {
  const val = role[rule.field];
  switch (rule.operator) {
    case 'in':  return Array.isArray(rule.value) && rule.value.map(String).includes(String(val));
    case 'eq':  return String(val) === String(rule.value);
    case 'gte': return compareLevels(val, rule.value) >= 0;
    case 'lte': return compareLevels(val, rule.value) <= 0;
    default:    return false;
  }
}

function compareLevels(a, b) {
  const num = s => parseInt(String(s ?? '').replace(/\D/g, ''), 10) || 0;
  return num(a) - num(b);
}

// ── Role subtree (manager scoping) ─────────────────────────────────────────────

function getRoleSubtree(rootRoleIds, allRoles) {
  const subtree = new Set(rootRoleIds.map(String));
  let changed = true;
  while (changed) {
    changed = false;
    for (const role of allRoles) {
      if (!subtree.has(String(role.id)) && role.managerRoleId && subtree.has(String(role.managerRoleId))) {
        subtree.add(String(role.id));
        changed = true;
      }
    }
  }
  return subtree;
}

// ── Build context ──────────────────────────────────────────────────────────────

function buildContext(personId, tier, data) {
  const { departments = [], roles = [], persons = [], roleAssignments = [] } = data;

  const deptById = Object.fromEntries(departments.map(d => [String(d.id), d.name]));
  const roleById = Object.fromEntries(roles.map(r => [String(r.id), r]));
  const currency = data.settings?.currency || 'DKK';

  // Dept headcount (number of people with a role in that dept)
  const headcountByDept = {};
  for (const ra of roleAssignments) {
    const role = roleById[String(ra.roleId)];
    if (role) {
      const dname = deptById[String(role.departmentId)] || 'Unknown';
      headcountByDept[dname] = (headcountByDept[dname] || 0) + 1;
    }
  }

  // Manager subtree (persons whose roles are descendants of this person's roles)
  let subtreePersonIds = null;
  if (tier === 'manager' && personId) {
    const myRoleIds = roleAssignments
      .filter(a => String(a.personId) === String(personId))
      .map(a => String(a.roleId));
    const subtreeRoleIds = getRoleSubtree(myRoleIds, roles);
    subtreePersonIds = new Set(
      roleAssignments
        .filter(a => subtreeRoleIds.has(String(a.roleId)))
        .map(a => String(a.personId))
    );
  }

  // Person's primary role lookup
  const personRoleMap = {};
  for (const ra of roleAssignments) {
    if (!personRoleMap[String(ra.personId)]) {
      personRoleMap[String(ra.personId)] = roleById[String(ra.roleId)];
    }
  }

  // Role occupant lookup: roleId → person name (for manager resolution)
  const roleOccupant = {};
  for (const ra of roleAssignments) {
    if (!roleOccupant[String(ra.roleId)]) {
      const p = persons.find(pp => String(pp.id) === String(ra.personId));
      if (p) roleOccupant[String(ra.roleId)] = p.name;
    }
  }

  const people = persons.map(p => {
    const role = personRoleMap[String(p.id)];
    const deptName = role ? (deptById[String(role.departmentId)] || 'Unknown') : 'Unknown';
    const entry = {
      id:         String(p.id),
      name:       p.name,
      role:       role ? role.title : 'Unassigned',
      level:      role ? role.level : null,
      department: deptName,
    };
    if (role && role.managerRoleId) {
      const managerName = roleOccupant[String(role.managerRoleId)];
      if (managerName) entry.manager = managerName;
    }
    const showSalary =
      tier === 'admin' ||
      (tier === 'manager' && subtreePersonIds && subtreePersonIds.has(String(p.id)));
    if (showSalary && p.salary != null) entry.salary = p.salary;
    return entry;
  });

  return {
    organisation: { headcount: persons.length, currency },
    departments: departments.map(d => ({
      id:        String(d.id),
      name:      d.name,
      headcount: headcountByDept[d.name] || 0,
    })),
    roles: roles.map(r => ({
      id:            String(r.id),
      title:         r.title,
      level:         r.level,
      department:    deptById[String(r.departmentId)] || 'Unknown',
      managerTitle:  r.managerRoleId ? (roleById[String(r.managerRoleId)]?.title || null) : null,
    })),
    people,
  };
}

// ── System prompts ─────────────────────────────────────────────────────────────

function buildSystemPrompt(tier, personId, data) {
  const ctx = buildContext(personId, tier, data);
  const ctxJson = JSON.stringify(ctx, null, 2);
  const currency = ctx.organisation.currency;

  // Build "you are" identity line for the current user
  let identityLine = '';
  if (personId) {
    const { roleAssignments = [], roles = [], persons = [] } = data;
    const person = persons.find(p => String(p.id) === String(personId));
    const ra     = roleAssignments.find(a => String(a.personId) === String(personId));
    const role   = ra ? roles.find(r => String(r.id) === String(ra.roleId)) : null;
    if (person) {
      identityLine = `\n\nThe user you are speaking with is: ${person.name}`;
      if (person.employeeId) identityLine += ` (${person.employeeId})`;
      if (role) identityLine += `, ${role.title} (${role.level || 'unknown level'})`;
      identityLine += '. When they say "I", "me", "my team", "my reports", or "my manager", they are referring to this person. Always answer questions from their perspective using the org data above.';
    }
  }

  const base = `You are Teampura AI, an HR analytics assistant. Answer questions clearly and concisely. Do not expose raw JSON structure or internal IDs in your responses. Refer to people by name and role. Currency: ${currency}.\n\nOrganisation data:\n${ctxJson}${identityLine}`;

  if (tier === 'employee') {
    return base + '\n\nIMPORTANT: You do not have access to salary or personal identifier data. If asked about compensation, salary, pay, or personal identifiers, politely explain you cannot access this information.';
  }
  if (tier === 'manager') {
    return base + '\n\nIMPORTANT: Salary data is only included in the context above for people in your direct reporting line. For people outside your team, you cannot discuss their compensation — politely decline if asked.';
  }
  // admin
  return base + '\n\nYou have full access to all organisational data including all salaries. You can suggest data changes when asked. Use suggest_change for field-level edits (salary, title, level, etc.). Use org_action for structural changes: creating or deleting departments/roles/persons, or moving a role to a different department or manager. Always use the tool so the user can review and confirm before anything is applied.\n\nIMPORTANT: When calling org_action, always use the `id` field (not the name) for roleDepartmentId, entityId, roleManagerRoleId, newDepartmentId, newManagerRoleId, and personRoleId. Department IDs and role IDs are in the context above.';
}

// ── Tool definitions (admin tier only) ────────────────────────────────────────

const SUGGEST_CHANGE_TOOL = {
  name: 'suggest_change',
  description: 'Suggest a specific data change to be reviewed and confirmed by the user before it is applied.',
  input_schema: {
    type: 'object',
    properties: {
      entityType:   { type: 'string', description: 'Type of entity: person, role, or department' },
      entityId:     { type: 'string', description: 'The ID of the entity to change' },
      entityName:   { type: 'string', description: 'Human-readable name of the entity' },
      field:        { type: 'string', description: 'The field to change (e.g. salary, title)' },
      currentValue: { description: 'The current value of the field' },
      newValue:     { description: 'The proposed new value' },
      reason:       { type: 'string', description: 'Brief justification for the change' },
    },
    required: ['entityType', 'entityId', 'entityName', 'field', 'newValue', 'reason'],
  },
};

const ORG_ACTION_TOOL = {
  name: 'org_action',
  description: 'Propose a structural change to the organisation: create a new department or role, move a role to a different department or manager, or delete a department, role, or person. The user will review and confirm before anything is applied.',
  input_schema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['create_department', 'delete_department', 'create_role', 'delete_role', 'move_role', 'create_person', 'delete_person'],
        description: 'The type of structural change to propose',
      },
      reason: { type: 'string', description: 'Brief justification for the change' },
      // Shared (existing entities)
      entityId:   { type: 'string', description: 'ID of the existing entity (for delete/move operations)' },
      entityName: { type: 'string', description: 'Human-readable name of the entity (for delete/move, shown in the confirm card)' },
      // create_department
      departmentName:  { type: 'string', description: 'Name of the new department' },
      departmentColor: { type: 'string', description: 'Hex color for the department badge, e.g. #6366f1' },
      // create_role
      roleTitle:         { type: 'string', description: 'Title of the new role' },
      roleLevel:         { type: 'string', description: 'Level of the role, e.g. L4' },
      roleDepartmentId:  { type: 'string', description: 'Department ID for the new role (use id from the departments list in context)' },
      roleManagerRoleId: { type: 'string', description: 'Role ID of the manager for the new role (optional — omit for a top-level role)' },
      // move_role
      newDepartmentId:    { type: 'string', description: 'New department ID when moving a role to a different department' },
      newDepartmentName:  { type: 'string', description: 'New department name (for display in the confirm card)' },
      newManagerRoleId:   { type: 'string', description: 'New manager role ID when changing reporting line. Pass null to make the role top-level.' },
      newManagerRoleName: { type: 'string', description: 'New manager role name (for display in the confirm card)' },
      // create_person
      personName:   { type: 'string', description: 'Full name of the new person' },
      personSalary: { type: 'number', description: 'Starting salary (optional)' },
      personRoleId: { type: 'string', description: 'Role ID to assign to the new person (optional)' },
    },
    required: ['operation', 'reason'],
  },
};

// ── Lazy Anthropic client ──────────────────────────────────────────────────────

let _anthropic = null;
function getAnthropicClient() {
  if (!_anthropic) {
    const Anthropic = require('@anthropic-ai/sdk');
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _anthropic;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/v1/ai/whoami
// Returns tier + display info for the identity bar (uses JWT identity)
router.get('/whoami', async (req, res) => {
  try {
    const personId = req.user.personId;
    const data     = await db.getData(req.user.orgId);
    const tier     = roleToTier(req.user.role);

    const person = personId ? (data.persons || []).find(p => String(p.id) === String(personId)) : null;
    const ra     = personId ? (data.roleAssignments || []).find(a => String(a.personId) === String(personId)) : null;
    const role   = ra ? (data.roles || []).find(r => String(r.id) === String(ra.roleId)) : null;

    res.json({ tier, personName: person?.name || null, roleTitle: role?.title || null, email: req.user.email });
  } catch (e) {
    console.error('[ai/whoami]', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/v1/ai/query
// Body: { prompt, history }
router.post('/query', async (req, res) => {
  try {
    const { prompt, history } = req.body || {};
    const personId = req.user.personId;
    if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'prompt must be a non-empty string.' });
    if (typeof prompt === 'string' && prompt.length > 2000) return res.status(400).json({ error: 'prompt must be 2000 characters or fewer.' });
    const safeHistory = Array.isArray(history) ? history.filter(m => m && typeof m.role === 'string' && typeof m.content === 'string') : [];

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: 'AI assistant is not configured. Set ANTHROPIC_API_KEY in your environment.' });
    }

    const data         = await db.getData(req.user.orgId);
    const tier         = roleToTier(req.user.role);
    const systemPrompt = buildSystemPrompt(tier, personId, data);

    const messages = [
      ...safeHistory,
      { role: 'user', content: prompt },
    ];

    const createParams = {
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system:     systemPrompt,
      messages,
    };

    if (tier === 'admin') {
      createParams.tools       = [SUGGEST_CHANGE_TOOL, ORG_ACTION_TOOL];
      createParams.tool_choice = { type: 'auto' };
    }

    const aiResponse = await getAnthropicClient().messages.create(createParams);

    // Extract text and structured actions
    let textContent = '';
    const actions   = [];
    for (const block of aiResponse.content) {
      if (block.type === 'text') textContent += block.text;
      if (block.type === 'tool_use' && block.name === 'suggest_change') actions.push({ ...block.input, _type: 'suggest_change' });
      if (block.type === 'tool_use' && block.name === 'org_action')     actions.push({ ...block.input, _type: 'org_action' });
    }

    // Audit log (non-fatal)
    try {
      const correlationId = generateUUID();
      await db.appendChangelogEntries([{
        id:             generateUUID(),
        orgId:          'default',
        correlationId,
        timestamp:      new Date().toISOString(),
        actorId:        req.user.userId,
        actorEmail:     req.user.email,
        actorRole:      req.user.role,
        actorIp:        req.ip || req.headers['x-forwarded-for'] || null,
        actorUserAgent: (req.headers['user-agent'] || '').slice(0, 500) || null,
        operation:      'AI_QUERY',
        entityType:     null,
        entityId:       personId ? String(personId) : null,
        entityLabel:    null,
        field:          null,
        oldValue:       null,
        newValue:       { prompt, tier, actionsCount: actions.length },
        changeReason:   null,
        source:         'ai',
        bulkId:         null,
        isSensitive:    false,
      }]);
    } catch (logErr) {
      console.error('[ai] audit log failed:', logErr);
    }

    res.json({ response: textContent, tier, actions });
  } catch (e) {
    console.error('[ai/query]', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

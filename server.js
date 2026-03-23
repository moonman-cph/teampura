const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = 3000;
const DATA_FILE = path.join(__dirname, 'orgchart-data.json');
const CHANGELOG_FILE = path.join(__dirname, 'changelog.json');

// ── Changelog constants ───────────────────────────────────────────────────────

const BULK_THRESHOLD = 10; // more than this many entity CREATE/DELETE ops = bulk

const SENSITIVE_FIELDS = {
  person:     new Set(['salary', 'employeeId', 'dateOfBirth', 'nationalId']),
  settings:   new Set(['hideSalaries']),
  salaryBand: new Set(['min', 'max', 'midpoint']),
};

const IGNORED_FIELDS = new Set(['orgId', '_simLabel', 'isNew', 'snapshots', 'plannedChange']);

// Collections to diff, with their entity type label and a function to extract a human-readable label
const COLLECTIONS = [
  { key: 'departments',     entityType: 'department',     labelField: 'name' },
  { key: 'teams',           entityType: 'team',           labelField: 'name' },
  { key: 'roles',           entityType: 'role',           labelField: 'title' },
  { key: 'persons',         entityType: 'person',         labelField: 'name' },
  { key: 'roleAssignments', entityType: 'roleAssignment', labelField: null },
  { key: 'salaryBands',     entityType: 'salaryBand',     labelField: 'name' },
];

// ── Changelog helpers ─────────────────────────────────────────────────────────

function generateUUID() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    // For arrays of primitives, sort before comparing
    const aS = [...a].map(v => typeof v === 'object' ? JSON.stringify(v) : v).sort();
    const bS = [...b].map(v => typeof v === 'object' ? JSON.stringify(v) : v).sort();
    return aS.every((v, i) => v === bS[i]);
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(k => deepEqual(a[k], b[k]));
}

function isSensitiveField(entityType, field) {
  return !!(SENSITIVE_FIELDS[entityType] && SENSITIVE_FIELDS[entityType].has(field));
}

function makeEntry(operation, entityType, entityId, entityLabel, field, oldValue, newValue, correlationId, meta) {
  return {
    id:            generateUUID(),
    orgId:         'default',
    correlationId,
    timestamp:     new Date().toISOString(),
    actorId:       meta.actorId    || null,
    actorEmail:    meta.actorEmail || null,
    actorRole:     meta.actorRole  || null,
    actorIp:       meta.actorIp    || null,
    actorUserAgent:meta.actorUserAgent || null,
    operation,
    entityType,
    entityId:      entityId != null ? String(entityId) : null,
    entityLabel:   entityLabel || null,
    field:         field || null,
    oldValue:      oldValue !== undefined ? oldValue : null,
    newValue:      newValue !== undefined ? newValue : null,
    changeReason:  meta.changeReason || null,
    source:        meta.source || 'ui',
    bulkId:        meta.bulkId || null,
    isSensitive:   field ? isSensitiveField(entityType, field) : false,
  };
}

function diffCollection(prevArr, nextArr, entityType, labelField, correlationId, meta) {
  const entries = [];
  const prevMap = new Map((Array.isArray(prevArr) ? prevArr : []).map(e => [String(e.id), e]));
  const nextMap = new Map((Array.isArray(nextArr) ? nextArr : []).map(e => [String(e.id), e]));

  // CREATEs
  for (const [id, rec] of nextMap) {
    if (!prevMap.has(id)) {
      const label = labelField ? rec[labelField] : id;
      entries.push(makeEntry('CREATE', entityType, id, label, null, null, rec, correlationId, meta));
    }
  }

  // DELETEs
  for (const [id, rec] of prevMap) {
    if (!nextMap.has(id)) {
      const label = labelField ? rec[labelField] : id;
      entries.push(makeEntry('DELETE', entityType, id, label, null, rec, null, correlationId, meta));
    }
  }

  // UPDATEs — field-level diff
  for (const [id, nextRec] of nextMap) {
    if (!prevMap.has(id)) continue;
    const prevRec = prevMap.get(id);
    const label = labelField ? (nextRec[labelField] || prevRec[labelField]) : id;
    const allFields = new Set([...Object.keys(prevRec), ...Object.keys(nextRec)]);
    for (const field of allFields) {
      if (IGNORED_FIELDS.has(field)) continue;
      if (field === 'id') continue;
      const oldVal = prevRec[field];
      const newVal = nextRec[field];
      if (!deepEqual(oldVal, newVal)) {
        entries.push(makeEntry('UPDATE', entityType, id, label, field, oldVal, newVal, correlationId, meta));
      }
    }
  }

  return entries;
}

function diffSettings(prev, next, correlationId, meta) {
  const entries = [];
  const prevS = prev || {};
  const nextS = next || {};
  const allFields = new Set([...Object.keys(prevS), ...Object.keys(nextS)]);
  for (const field of allFields) {
    if (IGNORED_FIELDS.has(field)) continue;
    if (!deepEqual(prevS[field], nextS[field])) {
      entries.push(makeEntry('UPDATE', 'settings', 'settings', 'Settings', field, prevS[field], nextS[field], correlationId, meta));
    }
  }
  return entries;
}

function diffTitles(prev, next, correlationId, meta) {
  const entries = [];
  const prevT = prev || {};
  const nextT = next || {};
  const allDepts = new Set([...Object.keys(prevT), ...Object.keys(nextT)]);
  for (const deptId of allDepts) {
    const oldVal = prevT[deptId] !== undefined ? prevT[deptId] : null;
    const newVal = nextT[deptId] !== undefined ? nextT[deptId] : null;
    if (!deepEqual(oldVal, newVal)) {
      entries.push(makeEntry('UPDATE', 'config', 'titles', 'Titles', deptId, oldVal, newVal, correlationId, meta));
    }
  }
  return entries;
}

function diffState(prev, next, correlationId, meta) {
  const entries = [];

  for (const { key, entityType, labelField } of COLLECTIONS) {
    const collEntries = diffCollection(prev[key], next[key], entityType, labelField, correlationId, meta);
    entries.push(...collEntries);
  }

  entries.push(...diffSettings(prev.settings, next.settings, correlationId, meta));
  entries.push(...diffTitles(prev.titles, next.titles, correlationId, meta));

  // Detect bulk operation — count entity-level CREATE/DELETE (not field-level UPDATEs)
  const entityOps = entries.filter(e => e.operation === 'CREATE' || e.operation === 'DELETE').length;
  if (entityOps > BULK_THRESHOLD) {
    // Build a summary of what changed
    const summary = {};
    for (const e of entries) {
      if (e.operation === 'CREATE' || e.operation === 'DELETE') {
        const k = `${e.entityType}_${e.operation.toLowerCase()}d`;
        summary[k] = (summary[k] || 0) + 1;
      }
    }
    summary.totalEntries = entries.length;
    entries.push({
      id:            generateUUID(),
      orgId:         'default',
      correlationId,
      timestamp:     new Date().toISOString(),
      actorId:       meta.actorId    || null,
      actorEmail:    meta.actorEmail || null,
      actorRole:     meta.actorRole  || null,
      actorIp:       meta.actorIp    || null,
      actorUserAgent:meta.actorUserAgent || null,
      operation:     'BULK_SUMMARY',
      entityType:    null,
      entityId:      null,
      entityLabel:   null,
      field:         null,
      oldValue:      null,
      newValue:      summary,
      changeReason:  meta.changeReason || null,
      source:        meta.source || 'ui',
      bulkId:        meta.bulkId || null,
      isSensitive:   false,
    });
  }

  return entries;
}

function appendChangelog(entries) {
  if (!entries.length) return;
  let log = [];
  try { log = JSON.parse(fs.readFileSync(CHANGELOG_FILE, 'utf8')); } catch (e) { /* first run */ }
  log.push(...entries);
  fs.writeFileSync(CHANGELOG_FILE, JSON.stringify(log, null, 2), 'utf8');
}

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
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    res.json(JSON.parse(raw));
  } catch (e) {
    res.json({});
  }
});

app.post('/api/data', (req, res) => {
  try {
    // 1. Read current state for diffing
    let prev = {};
    try { prev = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { /* first save */ }

    // 2. Write new state
    const next = req.body;
    fs.writeFileSync(DATA_FILE, JSON.stringify(next, null, 2), 'utf8');

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
      appendChangelog(entries);
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
    let log = [];
    try { log = JSON.parse(fs.readFileSync(CHANGELOG_FILE, 'utf8')); } catch (e) { /* empty */ }

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
    let log = [];
    try { log = JSON.parse(fs.readFileSync(CHANGELOG_FILE, 'utf8')); } catch (e) { /* empty */ }

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
  console.log(`Data file: ${DATA_FILE}`);
  console.log(`Changelog: ${CHANGELOG_FILE}`);
});

'use strict';

const crypto = require('crypto');

// ── Constants ─────────────────────────────────────────────────────────────────

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
  // salaryBands and locationMultipliers are plain objects (not arrays), handled by dedicated diff functions below
];

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function diffSalaryBands(prev, next, correlationId, meta) {
  const entries = [];
  const prevB = prev || {};
  const nextB = next || {};
  const allLevels = new Set([...Object.keys(prevB), ...Object.keys(nextB)]);
  for (const level of allLevels) {
    const prevBand = prevB[level] || {};
    const nextBand = nextB[level] || {};
    const allFields = new Set([...Object.keys(prevBand), ...Object.keys(nextBand)]);
    for (const field of allFields) {
      if (IGNORED_FIELDS.has(field)) continue;
      if (!deepEqual(prevBand[field], nextBand[field])) {
        entries.push(makeEntry('UPDATE', 'salaryBand', level, level, field, prevBand[field], nextBand[field], correlationId, meta));
      }
    }
  }
  return entries;
}

function diffLocationMultipliers(prev, next, correlationId, meta) {
  const entries = [];
  const prevM = prev || {};
  const nextM = next || {};
  const allCodes = new Set([...Object.keys(prevM), ...Object.keys(nextM)]);
  for (const code of allCodes) {
    const prevRec = prevM[code];
    const nextRec = nextM[code];
    if (!prevRec && nextRec) {
      entries.push(makeEntry('CREATE', 'locationMultiplier', code, nextRec.name || code, null, null, nextRec, correlationId, meta));
    } else if (prevRec && !nextRec) {
      entries.push(makeEntry('DELETE', 'locationMultiplier', code, prevRec.name || code, null, prevRec, null, correlationId, meta));
    } else if (prevRec && nextRec) {
      const allFields = new Set([...Object.keys(prevRec), ...Object.keys(nextRec)]);
      for (const field of allFields) {
        if (!deepEqual(prevRec[field], nextRec[field])) {
          const label = nextRec.name || prevRec.name || code;
          entries.push(makeEntry('UPDATE', 'locationMultiplier', code, label, field, prevRec[field], nextRec[field], correlationId, meta));
        }
      }
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
  entries.push(...diffSalaryBands(prev.salaryBands, next.salaryBands, correlationId, meta));
  entries.push(...diffLocationMultipliers(prev.locationMultipliers, next.locationMultipliers, correlationId, meta));

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

module.exports = {
  BULK_THRESHOLD,
  SENSITIVE_FIELDS,
  IGNORED_FIELDS,
  COLLECTIONS,
  generateUUID,
  deepEqual,
  isSensitiveField,
  makeEntry,
  diffCollection,
  diffSettings,
  diffTitles,
  diffSalaryBands,
  diffLocationMultipliers,
  diffState,
};

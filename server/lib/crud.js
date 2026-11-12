// Libre CMMS - Copyright (C) 2026 CreativeMed LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// Generic, schema-driven create / read / update / delete with validation,
// permission checks, reference labels and a full audit trail.
const { entities } = require('../schema');
const { nextNumber } = require('../db');
const { can } = require('./auth');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const hooks = { beforeSave: {}, afterSave: {}, beforeDelete: {} };
function on(kind, entity, fn) { (hooks[kind][entity] = hooks[kind][entity] || []).push(fn); }

const nowIso = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);

function entity(name) {
  const e = entities[name];
  if (!e) throw new HttpError(404, `Unknown entity: ${name}`);
  return e;
}

function coerce(f, v) {
  if (v === undefined) return undefined;
  if (v === '' || v === null) return null;
  switch (f.type) {
    case 'bool': return v === true || v === 1 || v === '1' || v === 'true' || v === 'on' || v === 'yes' ? 1 : 0;
    case 'int': case 'ref': {
      const n = Number.parseInt(v, 10);
      if (Number.isNaN(n)) throw new HttpError(400, `${f.label}: must be a whole number`);
      return n;
    }
    case 'number': case 'money': {
      const n = Number.parseFloat(String(v).replace(/[$,]/g, ''));
      if (Number.isNaN(n)) throw new HttpError(400, `${f.label}: must be a number`);
      return n;
    }
    case 'date': {
      const s = String(v).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new HttpError(400, `${f.label}: use YYYY-MM-DD`);
      return s;
    }
    case 'datetime': {
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) throw new HttpError(400, `${f.label}: invalid date/time`);
      return d.toISOString();
    }
    case 'email': {
      const s = String(v).trim();
      if (s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new HttpError(400, `${f.label}: invalid email`);
      return s;
    }
    default: return String(v).slice(0, 20000);
  }
}

// ---------- reference labels ----------
function rowLabel(db, e, row, depth = 0) {
  const parts = [].concat(e.display || 'id').map(fname => {
    const f = e.columns.find(c => c.name === fname);
    const v = row[fname];
    if (v == null || v === '') return null;
    if (f && f.type === 'ref' && depth < 1) return labelsFor(db, f.ref, [v], depth + 1)[v];
    if (fname === 'version') return `v${v}`;
    if (fname === 'interval_months') return `every ${v} mo`;
    return v;
  }).filter(Boolean);
  return parts.join(' - ') || `#${row.id}`;
}

function labelsFor(db, ename, ids, depth = 0) {
  const e = entities[ename];
  const uniq = [...new Set(ids.filter(x => x != null))];
  const out = {};
  if (!uniq.length) return out;
  for (let i = 0; i < uniq.length; i += 500) {
    const chunk = uniq.slice(i, i + 500);
    const rows = db.prepare(`SELECT * FROM "${ename}" WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk);
    for (const r of rows) out[r.id] = rowLabel(db, e, r, depth);
  }
  return out;
}

function attachLabels(db, e, rows) {
  for (const f of e.columns.filter(c => c.type === 'ref')) {
    const map = labelsFor(db, f.ref, rows.map(r => r[f.name]));
    for (const r of rows) {
      if (r[f.name] != null) (r._labels = r._labels || {})[f.name] = map[r[f.name]] || `#${r[f.name]}`;
    }
  }
  for (const r of rows) r._label = rowLabel(db, e, r);
  return rows;
}

// ---------- row scoping (who can see which rows) ----------
function scope(user, e) {
  if (user.role === 'requester' && e.name === 'service_requests') return { sql: 'created_by = ?', params: [user.username] };
  return null;
}

// Saved views: named server-side filters offered in the UI.
const VIEWS = {
  work_orders: {
    open: { label: 'Open', sql: "status NOT IN ('Completed','Closed','Cancelled')" },
    mine: { label: 'My open work', sql: "status NOT IN ('Completed','Closed','Cancelled') AND assigned_to = :me" },
    my_teams: { label: "My teams' queue", sql: "status NOT IN ('Completed','Closed','Cancelled') AND team_id IN (SELECT team_id FROM team_members WHERE user_id = :me)" },
    overdue: { label: 'Overdue', sql: "status NOT IN ('Completed','Closed','Cancelled') AND due_date < :today" },
    unassigned: { label: 'Unassigned', sql: "status NOT IN ('Completed','Closed','Cancelled') AND assigned_to IS NULL" },
    pm: { label: 'Open PMs', sql: "status NOT IN ('Completed','Closed','Cancelled') AND type IN ('Preventive','Inspection','Calibration','Safety Inspection')" },
    awaiting_signoff: { label: 'Awaiting supervisor sign-off', sql: "status = 'Completed' AND supervisor_signature IS NULL" },
    utl: { label: 'Unable To Locate', sql: "unable_to_locate = 1 AND status NOT IN ('Completed','Closed','Cancelled')" },
  },
  utl_events: { open: { label: 'Open (still missing)', sql: "status = 'Open'" }, resolved: { label: 'Resolved', sql: "status = 'Resolved'" } },
  inventories: { in_progress: { label: 'In progress', sql: "status = 'In Progress'" }, completed: { label: 'Completed', sql: "status = 'Completed'" } },
  assets: {
    active: { label: 'In inventory', sql: "status NOT IN ('Retired','Disposed')" },
    down: { label: 'Out of service', sql: "status IN ('Out of Service','Awaiting Parts')" },
    networked: { label: 'Networked devices', sql: "(ip_address IS NOT NULL AND ip_address <> '') OR (mac_address IS NOT NULL AND mac_address <> '')" },
    test_equipment: { label: 'Test equipment', sql: 'is_test_equipment = 1' },
    cal_due: { label: 'Test equipment cal due (30d)', sql: "is_test_equipment = 1 AND cal_due_date <= date(:today, '+30 days')" },
    loaners: { label: 'Loaners / rentals', sql: 'is_loaner = 1' },
    warranty: { label: 'Under warranty', sql: 'warranty_expires >= :today' },
    utl: { label: 'Unable To Locate', sql: 'utl_since IS NOT NULL' },
    not_inventoried: { label: 'Never inventoried', sql: "last_seen_at IS NULL AND status NOT IN ('Retired','Disposed')" },
    end_of_support: { label: 'Past end of support', sql: 'end_of_support < :today' },
  },
  pm_schedules: {
    due30: { label: 'Due in 30 days', sql: "active = 1 AND next_due <= date(:today, '+30 days')" },
    overdue: { label: 'Overdue', sql: 'active = 1 AND next_due < :today' },
    aem: { label: 'AEM program', sql: "program LIKE 'AEM%'" },
  },
  parts: { low: { label: 'At / below reorder point', sql: 'quantity_on_hand <= min_qty' }, expiring: { label: 'Expiring (60d)', sql: "expiration_date <= date(:today, '+60 days')" } },
  contracts: { active: { label: 'Active', sql: 'end_date >= :today' }, expiring: { label: 'Expiring (90d)', sql: "end_date BETWEEN :today AND date(:today, '+90 days')" } },
  certifications: { expiring: { label: 'Expiring (60d)', sql: "expires_date <= date(:today, '+60 days')" } },
  service_requests: { new: { label: 'New / untriaged', sql: "status IN ('New','Triaged')" } },
  recalls: { open: { label: 'Open', sql: "status IN ('Open','In Progress')" } },
  procedures: { approved: { label: 'Approved', sql: "status = 'Approved'" }, draft: { label: 'Draft', sql: "status = 'Draft'" } },
  users: { techs: { label: 'Active technicians & supervisors', sql: "active = 1 AND role IN ('technician','supervisor','admin')" } },
  teams: { active: { label: 'Active', sql: 'active = 1' } },
};

// Extra filters for records linked to an asset (work orders, PM schedules, ...):
// filter by the asset's facility, department, model or device type (model category).
const ASSET_FILTERS = {
  asset_facility: 'SELECT id FROM assets WHERE facility_id = ?',
  asset_department: 'SELECT id FROM assets WHERE department_id = ?',
  asset_model: 'SELECT id FROM assets WHERE model_id = ?',
  asset_category: 'SELECT a.id FROM assets a JOIN models m ON m.id = a.model_id WHERE m.category = ?',
};

function list(ctx, ename, q = {}) {
  const e = entity(ename);
  if (!can(ctx.user, e, 'read')) throw new HttpError(403, 'Not permitted');
  const where = [];
  const params = [];
  const named = { me: ctx.user.id, today: today() };
  const sc = scope(ctx.user, e);
  if (sc) { where.push(sc.sql); params.push(...sc.params); }
  if (q.view && VIEWS[ename] && VIEWS[ename][q.view]) {
    // Replace :named params positionally.
    const v = VIEWS[ename][q.view].sql.replace(/:(\w+)/g, (_, k) => { params.push(named[k]); return '?'; });
    where.push(`(${v})`);
  }
  for (const [k, v] of Object.entries(q)) {
    if (v === '' || v == null) continue;
    // f_<field>=value (exact, or 'null'); fin_<field>=a,b,c (any of); from_/to_<field> (range, inclusive)
    const m = k.match(/^(f|fin|from|to)_(.+)$/);
    if (m) {
      const f = e.columns.find(c => c.name === m[2]);
      if (!f) continue;
      if (m[1] === 'f') {
        if (v === 'null') where.push(`"${f.name}" IS NULL`);
        else { where.push(`"${f.name}" = ?`); params.push(coerce(f, v)); }
      } else if (m[1] === 'fin') {
        const vals = String(v).split(',').map(s => s.trim()).filter(Boolean).slice(0, 50);
        if (vals.length) { where.push(`"${f.name}" IN (${vals.map(() => '?').join(',')})`); params.push(...vals.map(x => coerce(f, x))); }
      } else {
        where.push(`"${f.name}" ${m[1] === 'from' ? '>=' : '<='} ?`);
        params.push(f.type === 'datetime' && m[1] === 'to' ? `${String(v).slice(0, 10)}T23:59:59.999Z` : coerce(f, v));
      }
      continue;
    }
    if (ASSET_FILTERS[k] && e.columns.find(c => c.name === 'asset_id')) {
      where.push(`asset_id IN (${ASSET_FILTERS[k]})`);
      params.push(k === 'asset_category' ? String(v) : Number(v));
    }
  }
  if (q.q) {
    const searchable = e.columns.filter(f => ['text', 'textarea', 'select', 'email'].includes(f.type));
    const like = `%${String(q.q).replace(/[%_]/g, m => '\\' + m)}%`;
    const ors = searchable.map(f => `"${f.name}" LIKE ? ESCAPE '\\'`);
    // Also search the labels of referenced rows (e.g. find work orders by asset tag).
    for (const f of e.columns.filter(c => c.type === 'ref' && c.list)) {
      const te = entities[f.ref];
      const tcols = [].concat(te.display).filter(n => te.columns.find(c => c.name === n && c.type !== 'ref'));
      if (tcols.length) {
        ors.push(`"${f.name}" IN (SELECT id FROM "${f.ref}" WHERE ${tcols.map(c => `"${c}" LIKE ? ESCAPE '\\'`).join(' OR ')})`);
      }
    }
    if (ors.length) {
      where.push(`(${ors.join(' OR ')})`);
      for (const o of ors) { const n = (o.match(/\?/g) || []).length; for (let i = 0; i < n; i++) params.push(like); }
    }
  }
  let order = e.defaultSort || 'id DESC';
  if (q.sort && (q.sort === 'id' || e.columns.find(c => c.name === q.sort))) order = `"${q.sort}" ${q.dir === 'desc' ? 'DESC' : 'ASC'}`;
  const limit = Math.min(Number.parseInt(q.limit, 10) || 100, q.export ? 100000 : 1000);
  const offset = Math.max(Number.parseInt(q.offset, 10) || 0, 0);
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = ctx.db.prepare(`SELECT COUNT(*) AS n FROM "${ename}" ${w}`).get(...params).n;
  const rows = ctx.db.prepare(`SELECT * FROM "${ename}" ${w} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset);
  return { total, rows: attachLabels(ctx.db, e, rows.map(clean(e))) };
}

const clean = e => r => {
  const o = { ...r };
  if (e.name === 'users') { delete o.password_hash; delete o.failed_logins; delete o.locked_until; }
  if (e.name === 'test_runs') delete o.procedure_snapshot;
  if (e.name === 'service_requests') delete o.public_token;
  return o;
};

function getRaw(db, ename, id) {
  return db.prepare(`SELECT * FROM "${ename}" WHERE id = ?`).get(id);
}

function get(ctx, ename, id) {
  const e = entity(ename);
  if (!can(ctx.user, e, 'read')) throw new HttpError(403, 'Not permitted');
  const row = getRaw(ctx.db, ename, id);
  if (!row) throw new HttpError(404, `${e.label} not found`);
  const sc = scope(ctx.user, e);
  if (sc && !ctx.db.prepare(`SELECT 1 FROM "${ename}" WHERE id = ? AND ${sc.sql}`).get(id, ...sc.params)) throw new HttpError(404, 'Not found');
  return attachLabels(ctx.db, e, [clean(e)(row)])[0];
}

function audit(ctx, action, ename, id, summary, changes) {
  ctx.db.prepare('INSERT INTO audit_log (ts, user_id, user_name, action, entity, entity_id, summary, changes, ip) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(nowIso(), ctx.user ? ctx.user.id : null, ctx.user ? ctx.user.username : 'system', action, ename, id ?? null,
      summary || null, changes ? JSON.stringify(changes) : null, ctx.ip || null);
}

function prepareData(ctx, e, input, isNew) {
  const data = {};
  for (const f of e.columns) {
    if (!(f.name in input) || input[f.name] === undefined) continue;
    if ((f.readonly || f.computed) && !ctx.internal) continue;
    data[f.name] = coerce(f, input[f.name]);
  }
  if (isNew) {
    for (const f of e.columns) {
      if (data[f.name] == null && f.default !== undefined) data[f.name] = f.default;
      if (data[f.name] == null && f.defaultToday) data[f.name] = today();
      if (data[f.name] == null && f.defaultCurrentUser && ctx.user) data[f.name] = ctx.user.id;
    }
  }
  return data;
}

function validate(ctx, e, merged) {
  for (const f of e.columns) {
    if (f.required && (merged[f.name] == null || merged[f.name] === '')) throw new HttpError(400, `${f.label} is required`);
    if (f.type === 'select' && f.options && merged[f.name] != null && !f.options.includes(merged[f.name])) {
      throw new HttpError(400, `${f.label}: "${merged[f.name]}" is not an allowed value`);
    }
    if (f.type === 'ref' && merged[f.name] != null && !getRaw(ctx.db, f.ref, merged[f.name])) {
      throw new HttpError(400, `${f.label}: referenced record does not exist`);
    }
  }
}

function insertRow(db, ename, data) {
  const keys = Object.keys(data);
  const sql = `INSERT INTO "${ename}" (${keys.map(k => `"${k}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
  return Number(db.prepare(sql).run(...keys.map(k => data[k])).lastInsertRowid);
}

function updateRow(db, ename, id, data) {
  const keys = Object.keys(data);
  if (!keys.length) return;
  db.prepare(`UPDATE "${ename}" SET ${keys.map(k => `"${k}" = ?`).join(', ')} WHERE id = ?`).run(...keys.map(k => data[k]), id);
}

function uniqueCheck(ctx, e, merged, id) {
  for (const f of e.columns.filter(c => c.unique)) {
    const v = merged[f.name];
    if (v == null || v === '') continue;
    const dup = ctx.db.prepare(`SELECT id FROM "${e.name}" WHERE "${f.name}" = ? AND id <> ?`).get(v, id || 0);
    if (dup) throw new HttpError(409, `${f.label} "${v}" already exists`);
  }
}

function create(ctx, ename, input) {
  const e = entity(ename);
  if (!ctx.internal && (e.readonlyApi || !can(ctx.user, e, 'write'))) throw new HttpError(403, 'Not permitted');
  const data = prepareData(ctx, e, input, true);
  for (const h of hooks.beforeSave[ename] || []) h(ctx, data, null);
  if (e.autoNumber && !data[e.autoNumber.field]) data[e.autoNumber.field] = nextNumber(ctx.db, e.autoNumber);
  validate(ctx, e, data);
  uniqueCheck(ctx, e, data, null);
  const who = ctx.user ? ctx.user.username : 'system';
  Object.assign(data, { created_at: nowIso(), updated_at: nowIso(), created_by: who, updated_by: who });
  const id = insertRow(ctx.db, ename, data);
  const row = getRaw(ctx.db, ename, id);
  audit(ctx, 'create', ename, id, rowLabel(ctx.db, e, row), redact(e, data));
  for (const h of hooks.afterSave[ename] || []) h(ctx, row, null);
  return getRaw(ctx.db, ename, id);
}

function update(ctx, ename, id, input) {
  const e = entity(ename);
  if (!ctx.internal && (e.readonlyApi || !can(ctx.user, e, 'write'))) throw new HttpError(403, 'Not permitted');
  const old = getRaw(ctx.db, ename, id);
  if (!old) throw new HttpError(404, `${e.label} not found`);
  const data = prepareData(ctx, e, input, false);
  for (const h of hooks.beforeSave[ename] || []) h(ctx, data, old);
  const merged = { ...old, ...data };
  validate(ctx, e, merged);
  uniqueCheck(ctx, e, merged, id);
  const changes = {};
  for (const [k, v] of Object.entries(data)) if (old[k] !== v && !(old[k] == null && v == null)) changes[k] = [old[k], v];
  if (!Object.keys(changes).length) return old;
  const changed = Object.fromEntries(Object.keys(changes).map(k => [k, data[k]]));
  Object.assign(changed, { updated_at: nowIso(), updated_by: ctx.user ? ctx.user.username : 'system' });
  updateRow(ctx.db, ename, id, changed);
  const row = getRaw(ctx.db, ename, id);
  audit(ctx, 'update', ename, id, rowLabel(ctx.db, e, row), redact(e, changes));
  for (const h of hooks.afterSave[ename] || []) h(ctx, row, old);
  return getRaw(ctx.db, ename, id);
}

function remove(ctx, ename, id) {
  const e = entity(ename);
  if (!ctx.internal && !can(ctx.user, e, 'delete')) throw new HttpError(403, 'Not permitted');
  const old = getRaw(ctx.db, ename, id);
  if (!old) throw new HttpError(404, `${e.label} not found`);
  for (const h of hooks.beforeDelete[ename] || []) h(ctx, old);
  // Refuse to orphan records that reference this one.
  for (const other of Object.values(entities)) {
    for (const f of other.columns.filter(c => c.type === 'ref' && c.ref === ename)) {
      const n = ctx.db.prepare(`SELECT COUNT(*) AS n FROM "${other.name}" WHERE "${f.name}" = ?`).get(id).n;
      if (n) throw new HttpError(409, `Cannot delete: ${n} ${other.plural} record(s) reference this ${e.label}. Retire or reassign them first.`);
    }
  }
  ctx.db.prepare(`DELETE FROM "${ename}" WHERE id = ?`).run(id);
  audit(ctx, 'delete', ename, id, rowLabel(ctx.db, e, old), clean(e)(old));
  for (const h of hooks.afterSave[ename] || []) h(ctx, null, old);
}

function redact(e, obj) {
  if (e.name !== 'users') return obj;
  const o = { ...obj }; delete o.password_hash; return o;
}

module.exports = { HttpError, on, list, get, getRaw, create, update, remove, audit, attachLabels, labelsFor, rowLabel, VIEWS, today, nowIso, insertRow, updateRow, coerce };

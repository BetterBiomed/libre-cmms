// Libre CMMS - Copyright (C) 2026 CreativeMed LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// Business rules: work order workflow, PM scheduling, procedures & test
// records, inventory, recalls, service requests and notifications.
const crypto = require('node:crypto');
const crud = require('./crud');
const { tx, getSetting } = require('../db');
const { verifyPassword } = require('./auth');
const { HttpError, on, getRaw, today, nowIso } = crud;

const CLOSED = ['Completed', 'Closed', 'Cancelled'];
const MANAGER = u => u && ['admin', 'supervisor'].includes(u.role);
const WRITER = u => u && ['admin', 'supervisor', 'technician'].includes(u.role);
const sys = ctx => ({ ...ctx, internal: true });

function addMonths(dateStr, months) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}
const addDays = (dateStr, n) => new Date(Date.parse(dateStr + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

function notify(db, userIds, message, link, dedupeKey) {
  const ins = db.prepare('INSERT OR IGNORE INTO notifications (user_id, message, link, created_at, dedupe_key) VALUES (?,?,?,?,?)');
  for (const uid of new Set(userIds.filter(Boolean))) ins.run(uid, message, link || null, nowIso(), dedupeKey || null);
}
const managers = db => db.prepare("SELECT id FROM users WHERE role IN ('admin','supervisor') AND active = 1").all().map(r => r.id);
const teamMembers = (db, teamId) => db.prepare('SELECT m.user_id FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = ? AND u.active = 1').all(teamId).map(r => r.user_id);

function requireSignature(ctx, password) {
  const u = getRaw(ctx.db, 'users', ctx.user.id);
  if (!password || !verifyPassword(password, u.password_hash)) throw new HttpError(401, 'Electronic signature failed: password incorrect.');
  return `${u.full_name} (${u.username})`;
}

// ======================= Assets =======================
on('beforeSave', 'assets', (ctx, data, old) => {
  const modelId = data.model_id ?? old?.model_id;
  if (modelId && (!old || data.model_id !== undefined)) {
    const m = getRaw(ctx.db, 'models', modelId);
    if (m) {
      const cur = { ...old, ...data };
      if (cur.expected_life_years == null && m.expected_life_years != null) data.expected_life_years = m.expected_life_years;
      if (cur.criticality == null && m.criticality) data.criticality = m.criticality;
      if (cur.end_of_support == null && m.end_of_support) data.end_of_support = m.end_of_support;
      if (!cur.description) data.description = [m.manufacturer, m.model, m.category ? `(${m.category})` : ''].filter(Boolean).join(' ');
    }
  }
  const cur = { ...old, ...data };
  if (cur.install_date && cur.expected_life_years && !cur.replacement_date && data.replacement_date === undefined) {
    data.replacement_date = addMonths(cur.install_date, Math.round(cur.expected_life_years * 12));
  }
});

function locText(db, a) {
  const f = a.facility_id ? getRaw(db, 'facilities', a.facility_id) : null;
  const d = a.department_id ? getRaw(db, 'departments', a.department_id) : null;
  return [f?.name, d?.name, a.room].filter(Boolean).join(' / ') || '(none)';
}
on('afterSave', 'assets', (ctx, row, old) => {
  if (!row || !old) return;
  if (row.facility_id !== old.facility_id || row.department_id !== old.department_id || row.room !== old.room) {
    crud.insertRow(ctx.db, 'asset_moves', {
      asset_id: row.id, moved_at: nowIso(), from_text: locText(ctx.db, old), to_text: locText(ctx.db, row),
      moved_by: ctx.user?.username || 'system', created_at: nowIso(),
    });
  }
});

// Warranty / contract coverage for an asset as of today.
function coverage(db, assetId) {
  const a = assetId && getRaw(db, 'assets', assetId);
  if (!a) return null;
  const t = today();
  const out = { warranty: !!(a.warranty_expires && a.warranty_expires >= t), warranty_expires: a.warranty_expires, contract: null };
  if (a.contract_id) {
    const c = getRaw(db, 'contracts', a.contract_id);
    if (c && (!c.end_date || c.end_date >= t) && (!c.start_date || c.start_date <= t)) {
      const v = getRaw(db, 'vendors', c.vendor_id);
      out.contract = { id: c.id, name: c.name, type: c.contract_type, vendor: v?.name, vendor_phone: v?.phone, end_date: c.end_date,
        covers_labor: !!c.covers_labor, covers_parts: !!c.covers_parts, covers_pm: !!c.covers_pm, response_hours: c.response_hours };
    }
  }
  out.covered = out.warranty || !!out.contract;
  return out;
}

// ======================= Unable To Locate =======================
// An asset is "Unable To Locate" while it has an open utl_events row (assets.utl_since is set).
function markUtl(ctx, assetId, { source, inventory_id = null, work_order_id = null, notes = null }) {
  const db = ctx.db;
  const a = getRaw(db, 'assets', assetId);
  if (!a) throw new HttpError(404, 'Asset not found');
  crud.insertRow(db, 'utl_events', {
    asset_id: a.id, status: 'Open', source, facility_id: a.facility_id, department_id: a.department_id,
    inventory_id, work_order_id, notes, reported_at: nowIso(), reported_by: ctx.user?.full_name || 'system',
    created_at: nowIso(), created_by: ctx.user?.username || 'system',
  });
  if (!a.utl_since) crud.update(sys(ctx), 'assets', a.id, { utl_since: today() });
  crud.audit(ctx, 'unable-to-locate', 'assets', a.id, `Unable to locate (${source})${notes ? ': ' + notes : ''}`);
}

function resolveUtl(ctx, assetId, resolution, exceptWoId = null) {
  const db = ctx.db;
  const a = getRaw(db, 'assets', assetId);
  if (!a) return 0;
  const by = ctx.user?.full_name || 'system';
  const n = db.prepare("UPDATE utl_events SET status = 'Resolved', resolved_at = ?, resolved_by = ?, resolution = ? WHERE asset_id = ? AND status = 'Open'")
    .run(nowIso(), by, resolution, assetId).changes;
  if (a.utl_since) crud.update(sys(ctx), 'assets', a.id, { utl_since: null });
  // Work orders that were put on hold because the asset could not be found can now proceed.
  for (const wo of db.prepare(`SELECT * FROM work_orders WHERE asset_id = ? AND unable_to_locate = 1 AND id <> ?
      AND status NOT IN ('Completed','Closed','Cancelled')`).all(assetId, exceptWoId || 0)) {
    crud.update(sys(ctx), 'work_orders', wo.id, {
      unable_to_locate: 0, status: wo.assigned_to ? 'Assigned' : 'Open',
      work_performed: `${wo.work_performed ? wo.work_performed + '\n' : ''}Asset located ${today()}: ${resolution}`,
    });
    notify(db, wo.assigned_to ? [wo.assigned_to] : managers(db), `${a.asset_tag} has been located (${resolution}). ${wo.wo_number} is ready to complete.`, `#/work_orders/${wo.id}`, `located-${wo.id}-${today()}`);
  }
  if (n || a.utl_since) crud.audit(ctx, 'located', 'assets', a.id, `Located: ${resolution}`);
  return n;
}

// ======================= Work orders =======================
on('beforeSave', 'work_orders', (ctx, data, old) => {
  if (old && old.status === 'Closed' && !ctx.internal) {
    throw new HttpError(409, 'Closed work orders are locked. A supervisor can reopen it.');
  }
  if (!old) {
    data.requested_at = data.requested_at || nowIso();
    if (data.asset_id && !data.department_id) data.department_id = getRaw(ctx.db, 'assets', data.asset_id)?.department_id ?? null;
  }
  const cur = { ...old, ...data };
  if (data.assigned_to !== undefined && data.assigned_to !== old?.assigned_to && data.assigned_to) {
    data.assigned_at = nowIso();
    if (cur.status === 'Open') data.status = 'Assigned';
  }
  if (old && data.assigned_to === null && old.assigned_to && cur.status === 'Assigned' && data.status === undefined) data.status = 'Open';
  if (data.status && data.status !== old?.status) {
    if (data.status === 'In Progress' && !cur.started_at) data.started_at = nowIso();
    if (CLOSED.slice(0, 2).includes(data.status) && !cur.completed_at) data.completed_at = nowIso();
    if (data.status === 'Closed' && !MANAGER(ctx.user) && !ctx.internal) throw new HttpError(403, 'Only a supervisor can close work orders.');
  }
});

on('afterSave', 'work_orders', (ctx, row, old) => {
  if (!row) return;
  const db = ctx.db;
  const becameDone = CLOSED.slice(0, 2).includes(row.status) && !(old && CLOSED.slice(0, 2).includes(old.status));
  // Asset status follows the work order.
  if (row.asset_id && row.status !== old?.status) {
    const a = getRaw(db, 'assets', row.asset_id);
    if (a && !['Retired', 'Disposed'].includes(a.status)) {
      let s = null;
      if (row.status === 'Awaiting Parts') s = 'Awaiting Parts';
      else if (becameDone && row.return_to_service && ['Out of Service', 'Awaiting Parts'].includes(a.status)) s = 'Active';
      else if (becameDone && row.type === 'Decommission') s = 'Retired';
      if (s && s !== a.status) crud.update(sys(ctx), 'assets', a.id, { status: s });
    }
  }
  if (!becameDone) {
    const newTech = row.assigned_to && row.assigned_to !== old?.assigned_to && row.assigned_to !== ctx.user?.id;
    const newTeam = row.team_id && row.team_id !== old?.team_id && !row.assigned_to;
    if (ctx.bulk) {
      // Bulk changes send one summary notification per person instead of one per work order.
      if (newTech) (ctx.bulk.tech[row.assigned_to] = ctx.bulk.tech[row.assigned_to] || []).push(row.wo_number);
      if (newTeam) (ctx.bulk.team[row.team_id] = ctx.bulk.team[row.team_id] || []).push(row.wo_number);
      return;
    }
    if (newTech) notify(db, [row.assigned_to], `${row.wo_number} assigned to you (${row.priority}, ${row.type})`, `#/work_orders/${row.id}`, `assign-${row.id}-${row.assigned_to}`);
    if (newTeam) {
      const t = getRaw(db, 'teams', row.team_id);
      notify(db, teamMembers(db, row.team_id).filter(u => u !== ctx.user?.id), `${row.wo_number} added to the ${t?.name || 'team'} queue (${row.priority}, ${row.type})`, `#/work_orders/${row.id}`, `team-${row.id}-${row.team_id}`);
    }
    return;
  }
  const doneDate = (row.completed_at || nowIso()).slice(0, 10);
  // Completing work on an asset proves it was found.
  if (row.asset_id && getRaw(db, 'assets', row.asset_id)?.utl_since) {
    if (row.unable_to_locate) db.prepare('UPDATE work_orders SET unable_to_locate = 0 WHERE id = ?').run(row.id);
    resolveUtl(ctx, row.asset_id, `Found during ${row.wo_number}`, row.id);
  }
  if (row.pm_schedule_id) {
    const s = getRaw(db, 'pm_schedules', row.pm_schedule_id);
    if (s) {
      let next = addMonths(row.due_date || s.next_due, s.interval_months);
      if (next <= doneDate) next = addMonths(doneDate, s.interval_months);
      crud.update(sys(ctx), 'pm_schedules', s.id, { last_completed: doneDate, next_due: next, deferred_until: null });
    }
  }
  if (row.recall_id && row.asset_id) {
    db.prepare("UPDATE recall_assets SET status = 'Action Complete' WHERE recall_id = ? AND asset_id = ? AND status = 'Affected'").run(row.recall_id, row.asset_id);
  }
  if (row.request_id) {
    const r = getRaw(db, 'service_requests', row.request_id);
    if (r && r.status !== 'Closed') crud.update(sys(ctx), 'service_requests', r.id, { status: 'Closed', response: r.response || `Work completed: ${row.work_performed || 'see work order ' + row.wo_number}` });
  }
});

function recomputeWoCosts(db, woId) {
  if (!woId) return;
  const l = db.prepare('SELECT COALESCE(SUM(hours),0) h, COALESCE(SUM(hours * COALESCE(rate,0) * (CASE WHEN overtime = 1 THEN 1.5 ELSE 1 END)),0) c FROM wo_labor WHERE work_order_id = ?').get(woId);
  const p = db.prepare('SELECT COALESCE(SUM(quantity * COALESCE(unit_cost,0)),0) c FROM wo_parts WHERE work_order_id = ?').get(woId);
  db.prepare('UPDATE work_orders SET labor_hours = ?, labor_cost = ?, parts_cost = ? WHERE id = ?').run(l.h, Math.round(l.c * 100) / 100, Math.round(p.c * 100) / 100, woId);
}

function guardOpenWo(ctx, woId) {
  const wo = getRaw(ctx.db, 'work_orders', woId);
  if (wo && wo.status === 'Closed' && !ctx.internal) throw new HttpError(409, 'Work order is closed.');
}

on('beforeSave', 'wo_labor', (ctx, data, old) => {
  guardOpenWo(ctx, data.work_order_id ?? old?.work_order_id);
  const uid = data.user_id ?? old?.user_id;
  if ((data.rate == null && !old) && uid) data.rate = getRaw(ctx.db, 'users', uid)?.labor_rate ?? null;
});
on('afterSave', 'wo_labor', (ctx, row, old) => recomputeWoCosts(ctx.db, (row || old).work_order_id));

// Parts used on a work order are issued from stock automatically.
function stockTxn(ctx, partId, qty, type, extra = {}) {
  const db = ctx.db;
  db.prepare('UPDATE parts SET quantity_on_hand = COALESCE(quantity_on_hand,0) + ? WHERE id = ?').run(qty, partId);
  crud.insertRow(db, 'part_transactions', {
    part_id: partId, txn_type: type, quantity: qty, user_name: ctx.user?.username || 'system', created_at: nowIso(), ...extra,
  });
  const p = getRaw(db, 'parts', partId);
  if (p && p.min_qty != null && p.quantity_on_hand <= p.min_qty) {
    notify(db, managers(db), `Low stock: ${p.part_number} ${p.name} (${p.quantity_on_hand} on hand, min ${p.min_qty})`, `#/parts/${p.id}`, `low-${p.id}-${today()}`);
  }
}
on('beforeSave', 'wo_parts', (ctx, data, old) => {
  guardOpenWo(ctx, data.work_order_id ?? old?.work_order_id);
  if (!old && data.unit_cost == null && data.part_id) data.unit_cost = getRaw(ctx.db, 'parts', data.part_id)?.unit_cost ?? null;
});
on('afterSave', 'wo_parts', (ctx, row, old) => {
  const prevQty = old ? old.quantity : 0;
  if (old && row && old.part_id !== row.part_id) {
    stockTxn(ctx, old.part_id, old.quantity, 'Return', { work_order_id: old.work_order_id, note: 'Part changed on WO' });
    stockTxn(ctx, row.part_id, -row.quantity, 'Issue', { work_order_id: row.work_order_id, unit_cost: row.unit_cost });
  } else {
    const diff = (row ? row.quantity : 0) - prevQty;
    if (diff) stockTxn(ctx, (row || old).part_id, -diff, diff > 0 ? 'Issue' : 'Return', { work_order_id: (row || old).work_order_id, unit_cost: (row || old).unit_cost });
  }
  recomputeWoCosts(ctx.db, (row || old).work_order_id);
});

function adjustStock(ctx, partId, body) {
  if (!WRITER(ctx.user)) throw new HttpError(403, 'Not permitted');
  const p = getRaw(ctx.db, 'parts', partId);
  if (!p) throw new HttpError(404, 'Part not found');
  const qty = Number(body.quantity);
  if (!Number.isFinite(qty) || qty === 0) throw new HttpError(400, 'Quantity must be a non-zero number');
  const type = ['Receive', 'Adjust', 'Return', 'Count'].includes(body.type) ? body.type : 'Adjust';
  return tx(ctx.db, () => {
    let delta = qty;
    if (type === 'Count') delta = qty - (p.quantity_on_hand || 0);
    stockTxn(ctx, partId, delta, type, { note: body.note || null, unit_cost: body.unit_cost ?? null });
    if (type === 'Receive' && body.unit_cost != null) ctx.db.prepare('UPDATE parts SET unit_cost = ? WHERE id = ?').run(Number(body.unit_cost), partId);
    crud.audit(ctx, 'stock', 'parts', partId, `${type} ${delta} ${p.part_number}`, { delta, note: body.note });
    return getRaw(ctx.db, 'parts', partId);
  });
}

// ---- Purchase order approval ----
// An administrator sets an approval limit (Settings: po_approval_limit). A PO whose total is at or
// above the limit needs a supervisor's electronic signature before it can be ordered. The signature
// covers the amount approved; if lines later raise the total above it, the PO needs approval again.
const PO_ORDERED = ['Ordered', 'Partially Received', 'Received'];
function poApprovalLimit(db) { const v = Number(getSetting(db, 'po_approval_limit', '')); return Number.isFinite(v) && v > 0 ? v : null; }
function poApproval(db, po) {
  const limit = poApprovalLimit(db);
  const total = Number(po.total) || 0;
  const required = limit != null && total >= limit;
  const covered = po.approved_total != null && total <= Number(po.approved_total) + 0.005;
  return { limit, total, required, approved: required ? covered : true, voided: required && po.approved_total != null && !covered, approved_total: po.approved_total, signature: po.approval_signature, approved_at: po.approved_at };
}
function poNeedsApprovalError(db, po) {
  const a = poApproval(db, po);
  if (a.approved) return null;
  return new HttpError(409, `PO ${po.po_number || ''} totals ${money(a.total)}, at or above the ${money(a.limit)} approval limit. ${a.voided ? `It was approved for ${money(a.approved_total)} but the total has since increased, so it ` : 'It '}needs a supervisor's approval signature before it can be ordered.`);
}
const money = v => `$${Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

on('beforeSave', 'purchase_orders', (ctx, data, old) => {
  // Approval fields are only set by the approve action.
  if (!ctx.poApproving) for (const k of ['approval_signature', 'approved_at', 'approved_total']) delete data[k];
  const status = data.status ?? old?.status;
  if (PO_ORDERED.includes(status) && status !== old?.status) {
    const err = poNeedsApprovalError(ctx.db, { ...(old || {}), ...data, total: old?.total ?? 0 });
    if (err) throw err;
  }
});

on('afterSave', 'po_lines', (ctx, row, old) => {
  const po = (row || old).po_id;
  const t = ctx.db.prepare('SELECT COALESCE(SUM(quantity * COALESCE(unit_cost,0)),0) t FROM po_lines WHERE po_id = ?').get(po).t;
  ctx.db.prepare('UPDATE purchase_orders SET total = ? WHERE id = ?').run(Math.round(t * 100) / 100, po);
  // Lines on an already-ordered PO cannot push it past what was approved.
  const p = getRaw(ctx.db, 'purchase_orders', po);
  if (p && PO_ORDERED.includes(p.status)) { const err = poNeedsApprovalError(ctx.db, p); if (err) throw err; }
});

function approvePo(ctx, poId, body = {}) {
  if (!MANAGER(ctx.user)) throw new HttpError(403, 'Supervisor role required to approve purchase orders.');
  const po = getRaw(ctx.db, 'purchase_orders', poId);
  if (!po) throw new HttpError(404, 'PO not found');
  if (po.status === 'Cancelled') throw new HttpError(409, 'This PO is cancelled.');
  const lines = ctx.db.prepare('SELECT COUNT(*) n FROM po_lines WHERE po_id = ?').get(poId).n;
  if (!lines) throw new HttpError(400, 'Add the PO lines before approving.');
  const a = poApproval(ctx.db, po);
  if (!a.required) throw new HttpError(400, a.limit == null ? 'No approval limit is set, so this PO does not need approval.' : `This PO is below the ${money(a.limit)} approval limit and does not need approval.`);
  if (a.approved) throw new HttpError(409, `Already approved for ${money(a.approved_total)}.`);
  const sig = requireSignature(ctx, body.password);
  return tx(ctx.db, () => {
    crud.update({ ...sys(ctx), poApproving: true }, 'purchase_orders', poId, { approval_signature: `${sig} - Approved purchase of ${money(a.total)}`, approved_at: nowIso(), approved_total: a.total });
    crud.audit(ctx, 'e-signature', 'purchase_orders', poId, `PO approval signature: ${sig} for ${money(a.total)} (limit ${money(a.limit)})`);
    return getRaw(ctx.db, 'purchase_orders', poId);
  });
}
on('beforeSave', 'po_lines', (ctx, data, old) => {
  if (!old && data.unit_cost == null && data.part_id) data.unit_cost = getRaw(ctx.db, 'parts', data.part_id)?.unit_cost ?? null;
});

function receivePo(ctx, poId) {
  if (!WRITER(ctx.user)) throw new HttpError(403, 'Not permitted');
  const po = getRaw(ctx.db, 'purchase_orders', poId);
  if (!po) throw new HttpError(404, 'PO not found');
  const needs = poNeedsApprovalError(ctx.db, po);
  if (needs) throw needs;
  return tx(ctx.db, () => {
    const lines = ctx.db.prepare('SELECT * FROM po_lines WHERE po_id = ?').all(poId);
    for (const l of lines) {
      const remaining = l.quantity - (l.received_qty || 0);
      if (remaining <= 0) continue;
      stockTxn(ctx, l.part_id, remaining, 'Receive', { po_id: poId, unit_cost: l.unit_cost });
      ctx.db.prepare('UPDATE po_lines SET received_qty = quantity WHERE id = ?').run(l.id);
    }
    crud.update(sys(ctx), 'purchase_orders', poId, { status: 'Received' });
    return getRaw(ctx.db, 'purchase_orders', poId);
  });
}

// Work order actions with electronic signatures.
function woAction(ctx, id, action, body = {}) {
  const db = ctx.db;
  const wo = getRaw(db, 'work_orders', id);
  if (!wo) throw new HttpError(404, 'Work order not found');
  if (!WRITER(ctx.user)) throw new HttpError(403, 'Not permitted');
  return tx(db, () => {
    switch (action) {
      case 'start':
        return crud.update(ctx, 'work_orders', id, { status: 'In Progress', assigned_to: wo.assigned_to || ctx.user.id });
      case 'complete': {
        if (!wo.work_performed && !body.work_performed) throw new HttpError(400, 'Describe the work performed before completing.');
        const open = db.prepare("SELECT COUNT(*) n FROM test_runs WHERE work_order_id = ? AND status = 'In Progress'").get(id).n;
        if (open) throw new HttpError(409, 'Finish or discard the in-progress test record first.');
        const sig = requireSignature(ctx, body.password);
        crud.update(sys(ctx), 'work_orders', id, {
          status: 'Completed', work_performed: body.work_performed ?? wo.work_performed,
          return_to_service: body.return_to_service ? 1 : wo.return_to_service,
          tech_signature: `${sig} - Completed work and verified results`, tech_signed_at: nowIso(),
        });
        crud.audit(ctx, 'e-signature', 'work_orders', id, `Technician signature: ${sig}`);
        return getRaw(db, 'work_orders', id);
      }
      case 'supervisor_sign': {
        if (!MANAGER(ctx.user)) throw new HttpError(403, 'Supervisor role required.');
        if (!['Completed', 'Closed'].includes(wo.status)) throw new HttpError(409, 'Work order must be completed first.');
        const sig = requireSignature(ctx, body.password);
        crud.update(sys(ctx), 'work_orders', id, { supervisor_signature: `${sig} - Reviewed and approved`, supervisor_signed_at: nowIso(), status: 'Closed' });
        crud.audit(ctx, 'e-signature', 'work_orders', id, `Supervisor signature: ${sig}`);
        return getRaw(db, 'work_orders', id);
      }
      case 'reopen':
        if (!MANAGER(ctx.user)) throw new HttpError(403, 'Supervisor role required.');
        if (!body.reason) throw new HttpError(400, 'A reason is required to reopen.');
        crud.update(sys(ctx), 'work_orders', id, { status: 'In Progress', supervisor_signature: null, supervisor_signed_at: null, tech_signature: null, tech_signed_at: null, completed_at: null });
        crud.audit(ctx, 'reopen', 'work_orders', id, `Reopened: ${body.reason}`);
        return getRaw(db, 'work_orders', id);
      case 'cancel':
        if (!body.reason) throw new HttpError(400, 'A reason is required to cancel.');
        crud.update(sys(ctx), 'work_orders', id, { status: 'Cancelled', work_performed: `${wo.work_performed ? wo.work_performed + '\n' : ''}Cancelled: ${body.reason}` });
        return getRaw(db, 'work_orders', id);
      case 'utl': {
        if (!wo.asset_id) throw new HttpError(400, 'This work order has no asset.');
        if (CLOSED.includes(wo.status)) throw new HttpError(409, 'Work order is already finished.');
        if (wo.unable_to_locate) throw new HttpError(409, 'Already marked Unable To Locate.');
        const notes = String(body.notes || '').trim();
        if (!notes) throw new HttpError(400, 'Describe where you searched (required).');
        crud.update(sys(ctx), 'work_orders', id, {
          unable_to_locate: 1, utl_reported_at: nowIso(), status: 'On Hold',
          work_performed: `${wo.work_performed ? wo.work_performed + '\n' : ''}Unable to locate asset (${today()}, ${ctx.user.full_name}): ${notes}`,
        });
        markUtl(ctx, wo.asset_id, { source: wo.pm_schedule_id ? 'PM Work Order' : 'Work Order', work_order_id: id, notes });
        notify(db, managers(db).filter(u => u !== ctx.user.id), `${wo.wo_number}: asset could not be located`, `#/work_orders/${id}`, `utl-${id}`);
        return getRaw(db, 'work_orders', id);
      }
      case 'located': {
        if (!wo.unable_to_locate) throw new HttpError(409, 'Work order is not marked Unable To Locate.');
        crud.update(sys(ctx), 'work_orders', id, {
          unable_to_locate: 0, status: wo.assigned_to ? 'Assigned' : 'Open',
          work_performed: `${wo.work_performed ? wo.work_performed + '\n' : ''}Asset located (${today()}, ${ctx.user.full_name})${body.notes ? ': ' + body.notes : ''}`,
        });
        resolveUtl(ctx, wo.asset_id, `Located on ${wo.wo_number}${body.notes ? ' - ' + body.notes : ''}`, id);
        return getRaw(db, 'work_orders', id);
      }
      case 'followup': {
        const n = crud.create(ctx, 'work_orders', {
          type: 'Corrective', asset_id: wo.asset_id, priority: body.priority || 'High', problem: body.problem || `Follow-up from ${wo.wo_number}`,
          assigned_to: wo.assigned_to, parent_wo_id: wo.id, requested_by: ctx.user.full_name,
        });
        crud.update(sys(ctx), 'work_orders', n.id, { parent_wo_id: wo.id });
        return getRaw(db, 'work_orders', n.id);
      }
      default: throw new HttpError(400, `Unknown action ${action}`);
    }
  });
}

// ======================= Bulk work order changes & workload =======================
const BULK_STATUSES = ['Open', 'Assigned', 'In Progress', 'Awaiting Parts', 'On Hold'];
const BULK_MAX = 5000;

function bulkWorkOrders(ctx, body = {}) {
  const db = ctx.db;
  if (!WRITER(ctx.user)) throw new HttpError(403, 'Not permitted');
  const changes = {};
  const c = body.changes || {};
  if ('assigned_to' in c) {
    if (c.assigned_to != null) {
      const u = getRaw(db, 'users', Number(c.assigned_to));
      if (!u || !u.active || !['technician', 'supervisor', 'admin'].includes(u.role)) throw new HttpError(400, 'Choose an active technician.');
      changes.assigned_to = u.id;
    } else changes.assigned_to = null;
  }
  if ('team_id' in c) {
    if (c.team_id != null) {
      const t = getRaw(db, 'teams', Number(c.team_id));
      if (!t || !t.active) throw new HttpError(400, 'Choose an active team.');
      changes.team_id = t.id;
      if (body.clear_technician && !('assigned_to' in c)) changes.assigned_to = null;
    } else changes.team_id = null;
  }
  if (c.priority) changes.priority = c.priority;
  if ('due_date' in c) changes.due_date = c.due_date || null;
  if (c.status) {
    if (!BULK_STATUSES.includes(c.status)) throw new HttpError(400, `Bulk status must be one of: ${BULK_STATUSES.join(', ')}. Completing and closing need individual signatures.`);
    changes.status = c.status;
  }
  const cancel = !!body.cancel_reason;
  if (!cancel && !Object.keys(changes).length) throw new HttpError(400, 'Nothing to change.');

  let ids;
  if (Array.isArray(body.ids)) ids = [...new Set(body.ids.map(Number).filter(Boolean))];
  else if (body.filter && typeof body.filter === 'object') {
    const { offset, limit, sort, dir, ...f } = body.filter; // eslint-disable-line no-unused-vars
    const r = crud.list(ctx, 'work_orders', { ...f, limit: BULK_MAX + 1, export: 1 });
    ids = r.rows.map(x => x.id);
  } else throw new HttpError(400, 'Provide ids or a filter.');
  if (!ids.length) throw new HttpError(400, 'No work orders selected.');
  if (ids.length > BULK_MAX) throw new HttpError(400, `Too many work orders (max ${BULK_MAX}). Narrow the filter.`);

  const bctx = { ...ctx, bulk: { tech: {}, team: {} } };
  const result = { updated: 0, skipped: [] };
  tx(db, () => {
    for (const id of ids) {
      const wo = getRaw(db, 'work_orders', id);
      if (!wo) { result.skipped.push({ id, reason: 'not found' }); continue; }
      if (CLOSED.includes(wo.status)) { result.skipped.push({ id, wo_number: wo.wo_number, reason: `already ${wo.status.toLowerCase()}` }); continue; }
      try {
        tx(db, () => {
          if (cancel) woAction(bctx, id, 'cancel', { reason: body.cancel_reason });
          else crud.update(bctx, 'work_orders', id, changes);
        });
        result.updated++;
      } catch (e) {
        result.skipped.push({ id, wo_number: wo.wo_number, reason: e.message });
      }
    }
    // One summary notification per affected person.
    const by = ctx.user.full_name;
    for (const [uid, list] of Object.entries(bctx.bulk.tech)) {
      if (Number(uid) === ctx.user.id) continue;
      notify(db, [Number(uid)], `${by} assigned you ${list.length} work order(s): ${list.slice(0, 5).join(', ')}${list.length > 5 ? '…' : ''}`, `#/list/work_orders?view=mine`, `bulk-${uid}-${Date.now()}`);
    }
    for (const [tid, list] of Object.entries(bctx.bulk.team)) {
      const t = getRaw(db, 'teams', Number(tid));
      notify(db, teamMembers(db, Number(tid)).filter(u => u !== ctx.user.id), `${by} added ${list.length} work order(s) to the ${t?.name} queue`, `#/list/work_orders?view=my_teams`, `bulkteam-${tid}-${Date.now()}`);
    }
    crud.audit(ctx, 'bulk-update', 'work_orders', null,
      `Bulk ${cancel ? 'cancel' : 'update'} of ${ids.length} work order(s): ${result.updated} updated, ${result.skipped.length} skipped`,
      { changes: cancel ? { status: 'Cancelled', reason: body.cancel_reason } : changes, ids });
  });
  return result;
}

function workload(db) {
  const t = today();
  const techs = db.prepare(`SELECT u.id, u.full_name, u.role, u.available, u.skills,
      (SELECT COUNT(*) FROM work_orders w WHERE w.assigned_to = u.id AND w.status NOT IN ('Completed','Closed','Cancelled')) open,
      (SELECT COUNT(*) FROM work_orders w WHERE w.assigned_to = u.id AND w.status NOT IN ('Completed','Closed','Cancelled') AND w.due_date < ?) overdue,
      (SELECT COUNT(*) FROM work_orders w WHERE w.assigned_to = u.id AND w.status NOT IN ('Completed','Closed','Cancelled') AND w.priority IN ('Urgent','Emergency')) urgent,
      (SELECT group_concat(t.name, ', ') FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.user_id = u.id) teams
    FROM users u WHERE u.active = 1 AND u.role IN ('technician','supervisor','admin') ORDER BY u.full_name`).all(t);
  const teams = db.prepare(`SELECT t.id, t.name, t.specialty,
      (SELECT COUNT(*) FROM team_members m WHERE m.team_id = t.id) members,
      (SELECT COUNT(*) FROM work_orders w WHERE w.team_id = t.id AND w.status NOT IN ('Completed','Closed','Cancelled')) open,
      (SELECT COUNT(*) FROM work_orders w WHERE w.team_id = t.id AND w.assigned_to IS NULL AND w.status NOT IN ('Completed','Closed','Cancelled')) queue
    FROM teams t WHERE t.active = 1 ORDER BY t.name`).all();
  return { techs, teams };
}

// ======================= PM scheduling =======================
function generatePMs(ctx) {
  const db = ctx.db;
  const t = today();
  const due = db.prepare(`SELECT * FROM pm_schedules WHERE active = 1
    AND (deferred_until IS NULL OR deferred_until <= ?)
    AND date(next_due, '-' || COALESCE(lead_days, 14) || ' days') <= ?`).all(t, t);
  const created = [];
  for (const s of due) {
    const exists = db.prepare(`SELECT id FROM work_orders WHERE pm_schedule_id = ? AND (status NOT IN ('Completed','Closed','Cancelled') OR due_date = ?)`).get(s.id, s.next_due);
    if (exists) continue;
    const a = getRaw(db, 'assets', s.asset_id);
    if (!a || ['Retired', 'Disposed'].includes(a.status)) continue;
    const p = s.procedure_id ? getRaw(db, 'procedures', s.procedure_id) : null;
    const wo = tx(db, () => crud.create(sys(ctx), 'work_orders', {
      type: s.wo_type || 'Preventive', asset_id: s.asset_id, priority: 'Normal', due_date: s.next_due, assigned_to: s.assigned_to, team_id: s.team_id,
      pm_schedule_id: s.id, requested_by: 'PM Scheduler',
      problem: `Scheduled ${s.program || ''} maintenance every ${s.interval_months} month(s)${p ? `\nProcedure: ${p.code} ${p.name} v${p.version}` : ''}`,
    }));
    created.push(wo.wo_number);
  }
  return created;
}

function approveDeferral(ctx, scheduleId, body) {
  if (!MANAGER(ctx.user)) throw new HttpError(403, 'Supervisor role required.');
  if (!body.until || !body.reason) throw new HttpError(400, 'Deferral date and reason are required.');
  return crud.update(sys(ctx), 'pm_schedules', scheduleId, { deferred_until: body.until, deferral_reason: body.reason, deferral_approved_by: `${ctx.user.full_name} ${today()}` });
}

// Create PM schedules for every active asset of a model that lacks one.
function bulkSchedule(ctx, body) {
  if (!MANAGER(ctx.user)) throw new HttpError(403, 'Supervisor role required.');
  const model = getRaw(ctx.db, 'models', body.model_id);
  if (!model) throw new HttpError(404, 'Model not found');
  const interval = Number(body.interval_months || model.pm_interval_months);
  if (!interval) throw new HttpError(400, 'PM interval required (set it on the model or provide it).');
  const assets = ctx.db.prepare(`SELECT id FROM assets WHERE model_id = ? AND status NOT IN ('Retired','Disposed')
    AND id NOT IN (SELECT asset_id FROM pm_schedules WHERE active = 1 AND COALESCE(procedure_id,0) = COALESCE(?,0))`).all(model.id, body.procedure_id || null);
  return tx(ctx.db, () => assets.map(a => crud.create(ctx, 'pm_schedules', {
    asset_id: a.id, procedure_id: body.procedure_id || null, interval_months: interval, next_due: body.next_due || today(),
    program: body.program || 'Manufacturer Recommended', assigned_to: body.assigned_to || null, active: 1,
  }).id));
}

// ======================= Procedures & test records =======================
on('beforeSave', 'procedures', (ctx, data, old) => {
  if (old && old.status !== 'Draft' && !ctx.internal) throw new HttpError(409, 'Approved procedures are locked. Create a new revision to make changes.');
});
function guardDraft(ctx, procId) {
  const p = getRaw(ctx.db, 'procedures', procId);
  if (p && p.status !== 'Draft' && !ctx.internal) throw new HttpError(409, 'Steps can only be changed on a Draft revision.');
}
on('beforeSave', 'procedure_steps', (ctx, data, old) => guardDraft(ctx, data.procedure_id ?? old?.procedure_id));
on('beforeDelete', 'procedure_steps', (ctx, old) => guardDraft(ctx, old.procedure_id));
on('beforeDelete', 'procedures', (ctx, old) => {
  if (old.status !== 'Draft') throw new HttpError(409, 'Only draft procedures can be deleted. Retire it instead.');
  ctx.db.prepare('DELETE FROM procedure_steps WHERE procedure_id = ?').run(old.id);
});

function procAction(ctx, id, action) {
  const db = ctx.db;
  const p = getRaw(db, 'procedures', id);
  if (!p) throw new HttpError(404, 'Procedure not found');
  return tx(db, () => {
    if (action === 'approve') {
      if (!MANAGER(ctx.user)) throw new HttpError(403, 'Supervisor role required to approve.');
      if (p.status !== 'Draft') throw new HttpError(409, 'Only drafts can be approved.');
      const n = db.prepare('SELECT COUNT(*) n FROM procedure_steps WHERE procedure_id = ?').get(id).n;
      if (!n) throw new HttpError(400, 'Add at least one step before approving.');
      for (const prev of db.prepare("SELECT id FROM procedures WHERE code = ? AND status = 'Approved' AND id <> ?").all(p.code, id)) {
        crud.update(sys(ctx), 'procedures', prev.id, { status: 'Retired' });
        db.prepare('UPDATE pm_schedules SET procedure_id = ? WHERE procedure_id = ?').run(id, prev.id);
      }
      crud.update(sys(ctx), 'procedures', id, { status: 'Approved', approved_by: ctx.user.full_name, approved_at: nowIso() });
      return getRaw(db, 'procedures', id);
    }
    if (action === 'revise') {
      if (!WRITER(ctx.user)) throw new HttpError(403, 'Not permitted');
      const draft = db.prepare("SELECT id FROM procedures WHERE code = ? AND status = 'Draft'").get(p.code);
      if (draft) throw new HttpError(409, `A draft revision already exists (#${draft.id}).`);
      const maxV = db.prepare('SELECT MAX(version) v FROM procedures WHERE code = ?').get(p.code).v || 1;
      const copy = {};
      for (const k of ['code', 'name', 'procedure_type', 'model_id', 'category', 'standard', 'description']) copy[k] = p[k];
      const np = crud.create(sys(ctx), 'procedures', { ...copy, version: maxV + 1, status: 'Draft', supersedes_id: p.id });
      for (const s of db.prepare('SELECT * FROM procedure_steps WHERE procedure_id = ? ORDER BY seq').all(id)) {
        const { id: _i, created_at, updated_at, created_by, updated_by, ...rest } = s;
        crud.create(sys(ctx), 'procedure_steps', { ...rest, procedure_id: np.id });
      }
      return getRaw(db, 'procedures', np.id);
    }
    if (action === 'retire') {
      if (!MANAGER(ctx.user)) throw new HttpError(403, 'Supervisor role required.');
      return crud.update(sys(ctx), 'procedures', id, { status: 'Retired' });
    }
    throw new HttpError(400, 'Unknown action');
  });
}

function limitsFor(step) {
  let lo = step.lower_limit, hi = step.upper_limit;
  if (step.nominal != null) {
    if (lo == null && hi == null && step.tolerance_pct != null) {
      const d = Math.abs(step.nominal) * step.tolerance_pct / 100; lo = step.nominal - d; hi = step.nominal + d;
    } else if (lo == null && hi == null && step.tolerance_abs != null) {
      lo = step.nominal - step.tolerance_abs; hi = step.nominal + step.tolerance_abs;
    }
  }
  const r = x => (x == null ? null : Math.round(x * 1e6) / 1e6);
  return { lo: r(lo), hi: r(hi) };
}

function startRun(ctx, body) {
  const db = ctx.db;
  if (!WRITER(ctx.user)) throw new HttpError(403, 'Not permitted');
  const wo = getRaw(db, 'work_orders', body.work_order_id);
  if (!wo) throw new HttpError(404, 'Work order not found');
  if (['Closed', 'Cancelled'].includes(wo.status)) throw new HttpError(409, 'Work order is closed.');
  const p = getRaw(db, 'procedures', body.procedure_id);
  if (!p) throw new HttpError(404, 'Procedure not found');
  if (p.status !== 'Approved') throw new HttpError(409, 'Only approved procedures can be used for testing.');
  // Test equipment calibration check.
  const teIds = [].concat(body.test_equipment_ids || []).map(Number).filter(Boolean);
  const te = teIds.map(i => getRaw(db, 'assets', i)).filter(Boolean);
  const overdue = te.filter(t => !t.cal_due_date || t.cal_due_date < today());
  if (overdue.length && !body.override_cal) {
    throw new HttpError(409, `Test equipment calibration overdue or missing: ${overdue.map(t => t.asset_tag).join(', ')}`);
  }
  const teText = te.map(t => {
    const m = t.model_id ? getRaw(db, 'models', t.model_id) : null;
    return `${t.asset_tag} ${m ? m.manufacturer + ' ' + m.model : t.description || ''} SN ${t.serial_number || '?'} cal due ${t.cal_due_date || 'n/a'}${overdue.includes(t) ? ' (OVERDUE - override)' : ''}`;
  }).join('\n');
  return tx(db, () => {
    const steps = db.prepare('SELECT * FROM procedure_steps WHERE procedure_id = ? ORDER BY seq').all(p.id);
    const run = crud.create(sys(ctx), 'test_runs', {
      work_order_id: wo.id, asset_id: wo.asset_id, procedure_id: p.id, procedure_version: p.version, technician_id: ctx.user.id,
      test_equipment: teText, status: 'In Progress', result: 'Incomplete', started_at: nowIso(),
    });
    db.prepare('UPDATE test_runs SET procedure_snapshot = ? WHERE id = ?').run(JSON.stringify({ procedure: p, steps }), run.id);
    const ins = db.prepare(`INSERT INTO test_results (run_id, step_id, seq, step_type, prompt, unit, nominal, lower_limit, upper_limit, required, only_if_step)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    for (const s of steps) {
      const { lo, hi } = limitsFor(s);
      ins.run(run.id, s.id, s.seq, s.step_type, s.prompt, s.unit, s.nominal, lo, hi, s.required ? 1 : 0, s.only_if_step);
    }
    if (wo.status === 'Open' || wo.status === 'Assigned') crud.update(sys(ctx), 'work_orders', wo.id, { status: 'In Progress' });
    return getRun(ctx, run.id);
  });
}

function getRun(ctx, id) {
  const run = crud.get(ctx, 'test_runs', id);
  const results = ctx.db.prepare('SELECT * FROM test_results WHERE run_id = ? ORDER BY seq').all(id);
  const snap = ctx.db.prepare('SELECT procedure_snapshot FROM test_runs WHERE id = ?').get(id).procedure_snapshot;
  const steps = snap ? JSON.parse(snap).steps : [];
  for (const r of results) r.media_url = steps.find(s => s.id === r.step_id)?.media_url || null;
  return { run, results };
}

function evaluate(r, value) {
  if (value == null || value === '') return { result: null, error_pct: null };
  switch (r.step_type) {
    case 'Measurement': {
      const v = Number(value);
      if (!Number.isFinite(v)) throw new HttpError(400, `Step ${r.seq}: enter a number`);
      const ok = (r.lower_limit == null || v >= r.lower_limit) && (r.upper_limit == null || v <= r.upper_limit);
      const err = r.nominal ? Math.round(((v - r.nominal) / Math.abs(r.nominal)) * 10000) / 100 : null;
      return { result: ok ? 'Pass' : 'Fail', error_pct: err };
    }
    case 'Pass/Fail': {
      const v = String(value);
      if (!['Pass', 'Fail', 'N/A'].includes(v)) throw new HttpError(400, `Step ${r.seq}: choose Pass, Fail or N/A`);
      return { result: v, error_pct: null };
    }
    case 'Instruction': return { result: 'Done', error_pct: null };
    default: return { result: 'Recorded', error_pct: null };
  }
}

function recordResults(ctx, runId, entries) {
  const db = ctx.db;
  const run = getRaw(db, 'test_runs', runId);
  if (!run) throw new HttpError(404, 'Test record not found');
  if (run.status !== 'In Progress') throw new HttpError(409, 'Test record is already completed.');
  if (!WRITER(ctx.user)) throw new HttpError(403, 'Not permitted');
  return tx(db, () => {
    for (const e of [].concat(entries || [])) {
      const r = e.id ? db.prepare('SELECT * FROM test_results WHERE id = ? AND run_id = ?').get(e.id, runId)
        : db.prepare('SELECT * FROM test_results WHERE seq = ? AND run_id = ?').get(e.seq, runId);
      if (!r) continue;
      const ev = evaluate(r, e.value);
      db.prepare('UPDATE test_results SET value = ?, as_found = ?, note = ?, result = ?, error_pct = ?, recorded_at = ?, recorded_by = ? WHERE id = ?')
        .run(e.value === '' ? null : e.value ?? null, e.as_found ?? r.as_found, e.note ?? r.note, ev.result, ev.error_pct, nowIso(), ctx.user.username, r.id);
    }
    return getRun(ctx, runId);
  });
}

function completeRun(ctx, runId, body) {
  const db = ctx.db;
  const { run, results } = getRun(ctx, runId);
  if (run.status !== 'In Progress') throw new HttpError(409, 'Already completed.');
  const failed = new Set(results.filter(r => r.result === 'Fail').map(r => r.seq));
  const visible = results.filter(r => r.only_if_step == null || failed.has(r.only_if_step));
  const missing = visible.filter(r => r.required && !r.result);
  if (missing.length) throw new HttpError(400, `Required steps not completed: ${missing.map(m => m.seq).join(', ')}`);
  const sig = requireSignature(ctx, body.password);
  const overall = visible.some(r => r.result === 'Fail') ? 'Fail' : 'Pass';
  return tx(db, () => {
    crud.update(sys(ctx), 'test_runs', runId, { status: 'Completed', result: overall, completed_at: nowIso(), signature: `${sig} ${nowIso()}` });
    crud.audit(ctx, 'e-signature', 'test_runs', runId, `Test record signed by ${sig}: ${overall}`);
    const wo = getRaw(db, 'work_orders', run.work_order_id);
    const summary = `Test ${run.run_number} (${run._labels?.procedure_id || 'procedure'}): ${overall}` +
      (overall === 'Fail' ? ` - failed steps ${[...failed].join(', ')}` : '');
    crud.update(sys(ctx), 'work_orders', wo.id, { work_performed: wo.work_performed ? `${wo.work_performed}\n${summary}` : summary });
    let followup = null;
    if (overall === 'Fail') {
      followup = crud.create(sys(ctx), 'work_orders', {
        type: 'Corrective', asset_id: run.asset_id, priority: 'High', parent_wo_id: wo.id, assigned_to: wo.assigned_to,
        requested_by: 'Automatic (failed test)', problem: `Failed test ${run.run_number} on ${wo.wo_number}. Failed steps:\n` +
          results.filter(r => r.result === 'Fail').map(r => `#${r.seq} ${r.prompt}: ${r.value ?? ''} ${r.unit || ''} (limits ${r.lower_limit ?? '-'}..${r.upper_limit ?? '-'})`).join('\n'),
      });
      if (run.asset_id) crud.update(sys(ctx), 'assets', run.asset_id, { status: 'Out of Service' });
      notify(db, [wo.assigned_to, ...managers(db)], `Test FAILED on ${wo.wo_number}; follow-up ${followup.wo_number} created`, `#/work_orders/${followup.id}`, `fail-${runId}`);
    }
    return { ...getRun(ctx, runId), followup };
  });
}

function discardRun(ctx, runId) {
  if (!MANAGER(ctx.user) && getRaw(ctx.db, 'test_runs', runId)?.technician_id !== ctx.user.id) throw new HttpError(403, 'Not permitted');
  const run = getRaw(ctx.db, 'test_runs', runId);
  if (!run || run.status !== 'In Progress') throw new HttpError(409, 'Only in-progress records can be discarded.');
  tx(ctx.db, () => {
    ctx.db.prepare('DELETE FROM test_results WHERE run_id = ?').run(runId);
    ctx.db.prepare('DELETE FROM test_runs WHERE id = ?').run(runId);
    crud.audit(ctx, 'delete', 'test_runs', runId, `Discarded in-progress test ${run.run_number}`);
  });
}

// ======================= Recalls =======================
function serialMatcher(text) {
  if (!text || !text.trim()) return () => true;
  const tokens = text.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
  return serial => {
    if (!serial) return false;
    const s = serial.trim().toUpperCase();
    return tokens.some(t => {
      const m = t.split('..');
      if (m.length === 2) {
        const [a, b] = m.map(x => x.trim().toUpperCase());
        if (/^\d+$/.test(a) && /^\d+$/.test(b) && /^\d+$/.test(s)) return BigInt(s) >= BigInt(a) && BigInt(s) <= BigInt(b);
        return s >= a && s <= b && s.length === a.length;
      }
      if (t.includes('*')) return new RegExp('^' + t.toUpperCase().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(s);
      return t.toUpperCase() === s;
    });
  };
}

function matchRecall(ctx, id) {
  const db = ctx.db;
  const r = getRaw(db, 'recalls', id);
  if (!r) throw new HttpError(404, 'Recall not found');
  const modelIds = new Set();
  if (r.model_id) modelIds.add(r.model_id);
  const names = (r.model_text || '').split(',').map(s => s.trim()).filter(Boolean);
  for (const n of names) {
    const rows = db.prepare(`SELECT id FROM models WHERE model LIKE ? ${r.manufacturer ? 'AND manufacturer LIKE ?' : ''}`)
      .all(...[`%${n}%`, ...(r.manufacturer ? [`%${r.manufacturer}%`] : [])]);
    rows.forEach(x => modelIds.add(x.id));
  }
  if (!modelIds.size && r.manufacturer && !names.length) {
    db.prepare('SELECT id FROM models WHERE manufacturer LIKE ?').all(`%${r.manufacturer}%`).forEach(x => modelIds.add(x.id));
  }
  const match = serialMatcher(r.serial_numbers);
  const ids = [...modelIds];
  const assets = ids.length ? db.prepare(`SELECT id, serial_number FROM assets WHERE model_id IN (${ids.map(() => '?').join(',')}) AND status NOT IN ('Disposed')`).all(...ids) : [];
  let added = 0;
  tx(db, () => {
    for (const a of assets.filter(a => match(a.serial_number))) {
      if (db.prepare('SELECT 1 FROM recall_assets WHERE recall_id = ? AND asset_id = ?').get(id, a.id)) continue;
      crud.create(sys(ctx), 'recall_assets', { recall_id: id, asset_id: a.id, status: 'Affected' });
      added++;
    }
    if (r.status === 'Open' && added) crud.update(sys(ctx), 'recalls', id, { status: 'In Progress' });
  });
  return { models: ids.length, scanned: assets.length, added };
}

function recallWorkOrders(ctx, id) {
  const db = ctx.db;
  const r = getRaw(db, 'recalls', id);
  if (!r) throw new HttpError(404, 'Recall not found');
  const rows = db.prepare("SELECT * FROM recall_assets WHERE recall_id = ? AND work_order_id IS NULL AND status = 'Affected'").all(id);
  return tx(db, () => rows.map(ra => {
    const wo = crud.create(sys(ctx), 'work_orders', {
      type: 'Recall / FCA', asset_id: ra.asset_id, recall_id: id, priority: r.classification === 'Class I' ? 'Urgent' : 'High',
      due_date: r.due_date, requested_by: 'Recall Management',
      problem: `${r.source || 'Recall'} ${r.recall_number || ''}: ${r.title}\n\nRequired action:\n${r.action_required || 'See recall notice.'}`,
    });
    db.prepare('UPDATE recall_assets SET work_order_id = ? WHERE id = ?').run(wo.id, ra.id);
    const a = getRaw(db, 'assets', ra.asset_id);
    if (a?.department_id) {
      const d = getRaw(db, 'departments', a.department_id);
      crud.audit(ctx, 'notify', 'recalls', id, `Department ${d?.name} notified for asset ${a.asset_tag}`);
    }
    return wo.wo_number;
  }));
}

// ======================= Service requests =======================
const URGENCY_PRIORITY = { Low: 'Low', Normal: 'Normal', High: 'High', 'Patient Care Impacted': 'Urgent' };

on('beforeSave', 'service_requests', (ctx, data, old) => {
  if (!old) data.created_at = nowIso();
});
on('afterSave', 'service_requests', (ctx, row, old) => {
  if (row && !old) {
    ctx.db.prepare('UPDATE service_requests SET public_token = ? WHERE id = ?').run(crypto.randomBytes(9).toString('base64url'), row.id);
    notify(ctx.db, managers(ctx.db), `New service request ${row.request_number} (${row.urgency}): ${String(row.problem).slice(0, 80)}`, `#/service_requests/${row.id}`, `sr-${row.id}`);
  }
});

function findAssetByText(db, text) {
  if (!text) return null;
  const t = String(text).trim();
  return db.prepare('SELECT * FROM assets WHERE asset_tag = ? COLLATE NOCASE OR control_number = ? COLLATE NOCASE OR serial_number = ? COLLATE NOCASE LIMIT 1').get(t, t, t) || null;
}

function publicSubmit(ctx, body) {
  const db = ctx.db;
  if (getSetting(db, 'portal_enabled', '1') !== '1') throw new HttpError(403, 'The service request portal is disabled.');
  const problem = String(body.problem || '').trim();
  const name = String(body.requester_name || '').trim();
  if (!problem || !name) throw new HttpError(400, 'Your name and a problem description are required.');
  const email = String(body.requester_email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'A valid email address is required so we can update you on your request.');
  const asset = findAssetByText(db, body.asset_text);
  const dept = body.department_id ? getRaw(db, 'departments', Number(body.department_id)) : null;
  const row = crud.create(sys({ ...ctx, user: ctx.user || null }), 'service_requests', {
    problem: problem.slice(0, 4000), requester_name: name.slice(0, 200), requester_email: email,
    requester_phone: String(body.requester_phone || '').slice(0, 50), department_id: dept?.id ?? asset?.department_id ?? null,
    room: String(body.room || '').slice(0, 100), asset_text: String(body.asset_text || '').slice(0, 100), asset_id: asset?.id ?? null,
    urgency: URGENCY_PRIORITY[body.urgency] ? body.urgency : 'Normal', status: 'New',
  });
  const tok = db.prepare('SELECT public_token FROM service_requests WHERE id = ?').get(row.id).public_token;
  return { request_number: row.request_number, token: tok, asset_found: !!asset };
}

function publicStatus(db, number, token) {
  const r = db.prepare('SELECT * FROM service_requests WHERE request_number = ? AND public_token = ?').get(number, token);
  if (!r) throw new HttpError(404, 'Request not found');
  const wo = r.work_order_id ? getRaw(db, 'work_orders', r.work_order_id) : null;
  return {
    request_number: r.request_number, status: r.status, submitted: r.created_at, problem: r.problem, response: r.response,
    work_order: wo ? { number: wo.wo_number, status: wo.status, assigned: !!wo.assigned_to, completed_at: wo.completed_at } : null,
    can_rate: r.status === 'Closed' && !r.satisfaction,
  };
}

function publicFeedback(ctx, number, token, body) {
  const r = ctx.db.prepare('SELECT * FROM service_requests WHERE request_number = ? AND public_token = ?').get(number, token);
  if (!r) throw new HttpError(404, 'Request not found');
  const s = Number.parseInt(body.satisfaction, 10);
  if (!(s >= 1 && s <= 5)) throw new HttpError(400, 'Rating must be 1-5');
  crud.update(sys(ctx), 'service_requests', r.id, { satisfaction: s, feedback: String(body.feedback || '').slice(0, 2000) });
  return { ok: true };
}

function convertRequest(ctx, id, body = {}) {
  if (!WRITER(ctx.user)) throw new HttpError(403, 'Not permitted');
  const r = getRaw(ctx.db, 'service_requests', id);
  if (!r) throw new HttpError(404, 'Request not found');
  if (r.work_order_id) throw new HttpError(409, 'Already converted.');
  return tx(ctx.db, () => {
    const wo = crud.create(ctx, 'work_orders', {
      type: 'Corrective', asset_id: body.asset_id || r.asset_id, priority: URGENCY_PRIORITY[r.urgency] || 'Normal',
      requested_by: r.requester_name, department_id: r.department_id, assigned_to: body.assigned_to || null,
      problem: `${r.problem}${r.room ? `\nRoom: ${r.room}` : ''}${r.asset_text && !r.asset_id ? `\nEquipment: ${r.asset_text}` : ''}${r.requester_phone ? `\nContact: ${r.requester_phone}` : ''}`,
    });
    crud.update(sys(ctx), 'work_orders', wo.id, { request_id: r.id });
    crud.update(sys(ctx), 'service_requests', r.id, { status: 'Converted to WO', work_order_id: wo.id, asset_id: body.asset_id || r.asset_id });
    return getRaw(ctx.db, 'work_orders', wo.id);
  });
}

// ======================= Users =======================
on('beforeSave', 'users', (ctx, data, old) => {
  if (old && old.role === 'admin' && (data.role && data.role !== 'admin' || data.active === 0)) {
    const n = ctx.db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND active = 1 AND id <> ?").get(old.id).n;
    if (!n) throw new HttpError(409, 'At least one active administrator is required.');
  }
  if (data.username) data.username = data.username.trim().toLowerCase();
});
on('afterSave', 'users', (ctx, row, old) => {
  if (row && old && (row.role !== old.role || (old.active && !row.active))) ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
});

// ======================= Scheduled jobs / notifications =======================
function runAlerts(ctx) {
  const db = ctx.db;
  const t = today();
  const mgr = managers(db);
  const sla = { Emergency: Number(getSetting(db, 'sla_emergency_hours', 1)), Urgent: Number(getSetting(db, 'sla_urgent_hours', 4)), High: Number(getSetting(db, 'sla_high_hours', 24)) };
  for (const [prio, hours] of Object.entries(sla)) {
    const cutoff = new Date(Date.now() - hours * 3600e3).toISOString();
    for (const wo of db.prepare(`SELECT id, wo_number, assigned_to FROM work_orders WHERE priority = ? AND status IN ('Open','Assigned') AND requested_at < ?`).all(prio, cutoff)) {
      notify(db, [...mgr, wo.assigned_to], `ESCALATION: ${prio} ${wo.wo_number} not started within ${hours}h`, `#/work_orders/${wo.id}`, `esc-${wo.id}`);
    }
  }
  for (const wo of db.prepare(`SELECT id, wo_number, assigned_to FROM work_orders WHERE status NOT IN ('Completed','Closed','Cancelled') AND due_date < ?`).all(t)) {
    notify(db, wo.assigned_to ? [wo.assigned_to] : mgr, `Overdue: ${wo.wo_number}`, `#/work_orders/${wo.id}`, `overdue-${wo.id}`);
  }
  for (const c of db.prepare(`SELECT c.*, u.full_name FROM certifications c JOIN users u ON u.id = c.user_id WHERE expires_date BETWEEN ? AND ?`).all(t, addDays(t, 60))) {
    notify(db, [c.user_id, ...mgr], `Certification expiring ${c.expires_date}: ${c.full_name} - ${c.name}`, `#/certifications/${c.id}`, `cert-${c.id}-${c.expires_date}`);
  }
  for (const c of db.prepare('SELECT * FROM contracts WHERE end_date >= ?').all(t)) {
    if (c.end_date <= addDays(t, c.renewal_notice_days || 60)) notify(db, mgr, `Contract renewal: ${c.name} expires ${c.end_date}`, `#/contracts/${c.id}`, `contract-${c.id}-${c.end_date}`);
  }
  for (const a of db.prepare('SELECT * FROM assets WHERE is_test_equipment = 1 AND cal_due_date <= ?').all(addDays(t, 30))) {
    notify(db, mgr, `Test equipment ${a.asset_tag} calibration due ${a.cal_due_date}`, `#/assets/${a.id}`, `cal-${a.id}-${a.cal_due_date}`);
  }
}

module.exports = {
  markUtl, resolveUtl, managers, sys,
  addMonths, addDays, coverage, woAction, approvePo, poApproval, bulkWorkOrders, workload, generatePMs, approveDeferral, bulkSchedule, procAction, startRun, getRun,
  recordResults, completeRun, discardRun, matchRecall, recallWorkOrders, publicSubmit, publicStatus, publicFeedback,
  convertRequest, adjustStock, receivePo, runAlerts, notify, findAssetByText, limitsFor, serialMatcher,
};

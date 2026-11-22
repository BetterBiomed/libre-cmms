// Libre CMMS - Copyright (C) 2026 CreativeMed LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// PM Planner: forecast PM workload month by month and move PM schedules between
// months to balance it. A schedule's future due dates are next_due + k * interval,
// so moving one occurrence shifts the whole cycle.
const crud = require('./crud');
const logic = require('./logic');
const { tx } = require('../db');
const { HttpError, getRaw, today, nowIso } = crud;

const WRITER = u => u && ['admin', 'supervisor', 'technician'].includes(u.role);
const MANAGER = u => u && ['admin', 'supervisor'].includes(u.role);
const DEFAULT_HOURS = 1;
const monthOf = d => d.slice(0, 7);
const monthStart = ym => `${ym}-01`;
const lastDay = ym => logic.addDays(logic.addMonths(monthStart(ym), 1), -1);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

// Filters shared by every planner query (asset owning account, device type, people, program).
function scheduleFilter(q = {}) {
  const w = ['s.active = 1', "a.status NOT IN ('Retired','Disposed')"]; const p = [];
  const add = (sql, v) => { w.push(sql); p.push(v); };
  if (q.facility_id) add('a.facility_id = ?', Number(q.facility_id));
  if (q.department_id) add('a.department_id = ?', Number(q.department_id));
  if (q.category) add('m.category = ?', String(q.category));
  if (q.model_id) add('a.model_id = ?', Number(q.model_id));
  if (q.team_id) add('s.team_id = ?', Number(q.team_id));
  if (q.assigned_to) add('s.assigned_to = ?', Number(q.assigned_to));
  if (q.program) add('s.program = ?', String(q.program));
  if (q.q) {
    const like = `%${String(q.q).replace(/[%_]/g, '')}%`;
    w.push('(a.asset_tag LIKE ? OR a.serial_number LIKE ? OR m.model LIKE ? OR m.manufacturer LIKE ? OR a.description LIKE ?)');
    p.push(like, like, like, like, like);
  }
  return { where: w.join(' AND '), params: p };
}

// Average PM labor hours per model from completed PM history.
function hoursByModel(db) {
  const rows = db.prepare(`SELECT a.model_id, AVG(w.labor_hours) h FROM work_orders w JOIN assets a ON a.id = w.asset_id
    WHERE w.pm_schedule_id IS NOT NULL AND w.status IN ('Completed','Closed') AND w.labor_hours > 0 GROUP BY a.model_id`).all();
  return new Map(rows.map(r => [r.model_id, r.h]));
}

function loadSchedules(db, q) {
  const f = scheduleFilter(q);
  return db.prepare(`SELECT s.id, s.asset_id, s.interval_months, s.next_due, s.deferred_until, s.grace_days, s.program, s.assigned_to, s.team_id, s.procedure_id,
      a.asset_tag, a.model_id, a.department_id, a.facility_id, a.criticality, a.serial_number, a.room,
      m.manufacturer, m.model, m.category, d.name department, f.name facility, u.full_name technician, t.name team
    FROM pm_schedules s JOIN assets a ON a.id = s.asset_id LEFT JOIN models m ON m.id = a.model_id
    LEFT JOIN departments d ON d.id = a.department_id LEFT JOIN facilities f ON f.id = a.facility_id
    LEFT JOIN users u ON u.id = s.assigned_to LEFT JOIN teams t ON t.id = s.team_id
    WHERE ${f.where}`).all(...f.params);
}

// Due dates of one schedule from its next due date until `end` (exclusive).
function occurrences(s, end) {
  const out = [];
  if (!s.next_due || !(s.interval_months > 0)) return out;
  let d = s.deferred_until && s.deferred_until > s.next_due ? s.deferred_until : s.next_due;
  for (let i = 0; d < end && i < 400; i++) { out.push(d); d = logic.addMonths(d, s.interval_months); }
  return out;
}

function horizon(q) {
  const months = Math.min(Math.max(Number.parseInt(q.months, 10) || 12, 1), 36);
  const start = /^\d{4}-\d{2}$/.test(q.start || '') ? q.start : monthOf(today());
  const list = [];
  for (let i = 0; i < months; i++) list.push(monthOf(logic.addMonths(monthStart(start), i)));
  return { list, startDate: monthStart(list[0]), endDate: logic.addMonths(monthStart(list[list.length - 1]), 1) };
}

function forecast(ctx, q = {}) {
  const db = ctx.db;
  const { list, startDate, endDate } = horizon(q);
  const hrs = hoursByModel(db);
  const months = new Map(list.map(m => [m, { month: m, count: 0, hours: 0, life_support: 0, by_category: {} }]));
  const overdue = { count: 0, hours: 0 };
  const t = today();
  const schedules = loadSchedules(db, q);
  for (const s of schedules) {
    const h = hrs.get(s.model_id) || DEFAULT_HOURS;
    for (const d of occurrences(s, endDate)) {
      if (d < t && d < startDate) { overdue.count++; overdue.hours += h; continue; }
      const b = months.get(monthOf(d));
      if (!b) continue;
      b.count++; b.hours += h;
      if (s.criticality === 'Life Support') b.life_support++;
      const c = s.category || 'Other';
      b.by_category[c] = (b.by_category[c] || 0) + 1;
    }
  }
  // The current month also includes PMs already completed this month (their schedules
  // have moved on to the next cycle), so it compares fairly with future months.
  const cur = months.get(monthOf(t));
  if (cur) {
    const f = scheduleFilter(q);
    const done = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(w.labor_hours), 0) h FROM work_orders w JOIN pm_schedules s ON s.id = w.pm_schedule_id
      JOIN assets a ON a.id = s.asset_id LEFT JOIN models m ON m.id = a.model_id
      WHERE ${f.where} AND w.status IN ('Completed','Closed') AND w.due_date >= ? AND w.due_date < ?`).get(...f.params, monthStart(monthOf(t)), logic.addMonths(monthStart(monthOf(t)), 1));
    cur.count += done.n; cur.hours += done.h; cur.completed = done.n;
  }
  const arr = [...months.values()].map(b => ({ ...b, hours: Math.round(b.hours * 10) / 10 }));
  const avgCount = arr.reduce((a, b) => a + b.count, 0) / (arr.length || 1);
  const avgHours = arr.reduce((a, b) => a + b.hours, 0) / (arr.length || 1);
  const sd = Math.sqrt(arr.reduce((a, b) => a + (b.count - avgCount) ** 2, 0) / (arr.length || 1));
  return {
    months: arr, average: { count: Math.round(avgCount * 10) / 10, hours: Math.round(avgHours * 10) / 10 },
    // Coefficient of variation: 0 = perfectly even. Lower is better.
    balance_cv: avgCount ? Math.round((sd / avgCount) * 1000) / 10 : 0,
    peak: arr.reduce((a, b) => (b.count > (a?.count ?? -1) ? b : a), null)?.month || null,
    overdue: { count: overdue.count, hours: Math.round(overdue.hours * 10) / 10 }, schedules: schedules.length,
  };
}

// Schedules with an occurrence in `month` (or all, by next due) for the planner table.
function list(ctx, q = {}) {
  const db = ctx.db;
  const hrs = hoursByModel(db);
  const rows = [];
  const schedules = loadSchedules(db, q);
  if (q.month && /^\d{4}-\d{2}$/.test(q.month)) {
    const end = logic.addMonths(monthStart(q.month), 1);
    for (const s of schedules) {
      for (const d of occurrences(s, end)) if (monthOf(d) === q.month) rows.push({ ...s, occurrence: d, est_hours: Math.round((hrs.get(s.model_id) || DEFAULT_HOURS) * 10) / 10 });
    }
  } else if (q.overdue) {
    for (const s of schedules) if (s.next_due < today()) rows.push({ ...s, occurrence: s.next_due, est_hours: Math.round((hrs.get(s.model_id) || DEFAULT_HOURS) * 10) / 10 });
  } else {
    for (const s of schedules) rows.push({ ...s, occurrence: s.next_due, est_hours: Math.round((hrs.get(s.model_id) || DEFAULT_HOURS) * 10) / 10 });
  }
  rows.sort((a, b) => a.occurrence.localeCompare(b.occurrence) || String(a.department).localeCompare(String(b.department)) || String(a.asset_tag).localeCompare(String(b.asset_tag)));
  const offset = Math.max(Number.parseInt(q.offset, 10) || 0, 0);
  const limit = Math.min(Number.parseInt(q.limit, 10) || 100, 5000);
  return { total: rows.length, rows: rows.slice(offset, offset + limit) };
}

// Active assets with no active PM schedule (to schedule into a month).
function unscheduled(ctx, q = {}) {
  const w = ["a.status NOT IN ('Retired','Disposed')", 'NOT EXISTS (SELECT 1 FROM pm_schedules s WHERE s.asset_id = a.id AND s.active = 1)', 'COALESCE(a.is_test_equipment, 0) = 0']; const p = [];
  const add = (sql, v) => { w.push(sql); p.push(v); };
  if (q.facility_id) add('a.facility_id = ?', Number(q.facility_id));
  if (q.department_id) add('a.department_id = ?', Number(q.department_id));
  if (q.category) add('m.category = ?', String(q.category));
  if (q.model_id) add('a.model_id = ?', Number(q.model_id));
  if (q.q) { const like = `%${String(q.q).replace(/[%_]/g, '')}%`; w.push('(a.asset_tag LIKE ? OR a.serial_number LIKE ? OR m.model LIKE ? OR m.manufacturer LIKE ?)'); p.push(like, like, like, like); }
  const sql = `FROM assets a LEFT JOIN models m ON m.id = a.model_id LEFT JOIN departments d ON d.id = a.department_id LEFT JOIN facilities f ON f.id = a.facility_id WHERE ${w.join(' AND ')}`;
  const total = ctx.db.prepare(`SELECT COUNT(*) n ${sql}`).get(...p).n;
  const offset = Math.max(Number.parseInt(q.offset, 10) || 0, 0);
  const limit = Math.min(Number.parseInt(q.limit, 10) || 100, 5000);
  const rows = ctx.db.prepare(`SELECT a.id asset_id, a.asset_tag, a.serial_number, a.criticality, m.manufacturer, m.model, m.category, m.pm_interval_months, d.name department, f.name facility
    ${sql} ORDER BY d.name, a.asset_tag LIMIT ? OFFSET ?`).all(...p, limit, offset);
  return { total, rows };
}

// Business days (Mon-Fri) of a month, not before `notBefore`.
function workdays(ym, notBefore) {
  const out = [];
  for (let d = monthStart(ym); d <= lastDay(ym); d = logic.addDays(d, 1)) {
    const wd = new Date(d + 'T12:00:00Z').getUTCDay();
    if (wd !== 0 && wd !== 6 && d >= notBefore) out.push(d);
  }
  return out;
}

// Target dates in `ym` for n items: keep day of month, spread over workdays, or a fixed date.
function targetDates(items, ym, mode, date) {
  const t = today();
  if (mode === 'date') {
    if (!date || monthOf(date) !== ym) throw new HttpError(400, 'Pick a date inside the target month.');
    if (date < t) throw new HttpError(400, 'The date is in the past.');
    return items.map(() => date);
  }
  if (mode === 'spread') {
    const days = workdays(ym, t);
    if (!days.length) throw new HttpError(400, 'No working days left in that month.');
    return items.map((_, i) => days[Math.floor((i * days.length) / items.length)]);
  }
  // keep: same day of month (clamped), not before today
  return items.map(it => {
    const day = Number(String(it.from).slice(8, 10)) || 15;
    const d = `${ym}-${String(Math.min(day, Number(lastDay(ym).slice(8)))).padStart(2, '0')}`;
    return d < t ? t : d;
  });
}

// Move PM schedules so the chosen occurrence lands in target_month. Each item is
// { schedule_id, from } where `from` is the occurrence being moved (defaults to next_due).
// dry_run returns the forecast after the move without saving.
function reschedule(ctx, body = {}) {
  if (!WRITER(ctx.user)) throw new HttpError(403, 'Not permitted');
  const db = ctx.db;
  const ym = String(body.target_month || '');
  if (!/^\d{4}-\d{2}$/.test(ym)) throw new HttpError(400, 'Choose a target month.');
  if (ym < monthOf(today())) throw new HttpError(400, 'The target month is in the past.');
  let items = Array.isArray(body.items) ? body.items : [];
  if (!items.length && body.filter) items = list(ctx, { ...body.filter, limit: 5000, offset: 0 }).rows.map(r => ({ schedule_id: r.id, from: r.occurrence }));
  if (!items.length) throw new HttpError(400, 'Select at least one PM schedule.');
  if (items.length > 5000) throw new HttpError(400, 'Too many schedules (max 5000).');
  // Resolve schedules and the occurrence being moved.
  const resolved = items.map(it => {
    const s = getRaw(db, 'pm_schedules', Number(it.schedule_id));
    return s ? { s, from: /^\d{4}-\d{2}-\d{2}$/.test(it.from || '') ? it.from : s.next_due } : null;
  }).filter(Boolean);
  const dates = targetDates(resolved, ym, body.day_mode || 'keep', body.date);
  const reason = String(body.reason || '').trim();
  const result = { moved: 0, unchanged: 0, skipped: [], later: 0 };
  const plan = [];
  resolved.forEach((r, i) => {
    const { s, from } = r;
    const delta = daysBetween(from, dates[i]);
    const a = getRaw(db, 'assets', s.asset_id);
    if (delta === 0) { result.unchanged++; return; }
    // `from` is the j-th due date after next_due; the new next due date is the target
    // date minus j intervals, so the target becomes one of the schedule's due dates.
    const mIdx = d => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7));
    let j = Math.max(0, Math.round((mIdx(from) - mIdx(s.next_due)) / s.interval_months));
    let newNext = logic.addMonths(dates[i], -j * s.interval_months);
    // For a repeating schedule, if that is in the past, use a later cycle instead:
    // only the cycle's phase needs to shift for a PM to land in the target month.
    while (newNext < today() && j > 0) { j--; newNext = logic.addMonths(dates[i], -j * s.interval_months); }
    if (newNext < today()) { result.skipped.push({ schedule_id: s.id, asset_tag: a?.asset_tag, reason: `would move the next PM (${s.next_due}) into the past` }); return; }
    // Moving a PM later than its due date plus grace is a deferral.
    const graceEnd = logic.addDays(from, s.grace_days ?? 30);
    const isLate = dates[i] > graceEnd && from >= today();
    if (isLate) result.later++;
    plan.push({ s, a, from, to: dates[i], newNext, delta, isLate });
  });
  if (result.later && !MANAGER(ctx.user)) throw new HttpError(403, `${result.later} PM(s) would move past their due date plus grace period. Only a supervisor can defer PMs.`);
  if (result.later && !reason) throw new HttpError(400, `${result.later} PM(s) would move past their due date plus grace period. Enter a reason (recorded in the audit trail).`);

  const apply = () => {
    for (const m of plan) {
      crud.update(logic.sys(ctx), 'pm_schedules', m.s.id, {
        next_due: m.newNext,
        ...(m.isLate ? { deferral_reason: reason, deferral_approved_by: `${ctx.user.full_name} ${today()}` } : {}),
      });
      // An already-generated, still-open PM work order for the old due date follows the schedule.
      const wo = db.prepare(`SELECT id, due_date FROM work_orders WHERE pm_schedule_id = ? AND status NOT IN ('Completed','Closed','Cancelled') ORDER BY due_date LIMIT 1`).get(m.s.id);
      if (wo && wo.due_date === m.s.next_due) crud.update(logic.sys(ctx), 'work_orders', wo.id, { due_date: m.newNext });
      result.moved++;
    }
    crud.audit(ctx, 'pm-reschedule', 'pm_schedules', null,
      `PM Planner: moved ${result.moved} PM schedule(s) into ${ym}${reason ? ` - reason: ${reason}` : ''}`,
      { target_month: ym, day_mode: body.day_mode || 'keep', moves: plan.slice(0, 500).map(m => ({ schedule: m.s.id, asset: m.a?.asset_tag, from: m.from, to: m.to })) });
  };

  if (body.dry_run) {
    // Apply inside a transaction, measure, then roll back.
    let after = null;
    try {
      tx(db, () => { apply(); after = forecast(ctx, body.forecast || {}); throw new Error('__dry_run__'); });
    } catch (e) { if (e.message !== '__dry_run__') throw e; }
    return { ...result, dry_run: true, after };
  }
  tx(db, apply);
  return result;
}

// Create PM schedules for assets that have none, first due in target_month.
function scheduleAssets(ctx, body = {}) {
  if (!WRITER(ctx.user)) throw new HttpError(403, 'Not permitted');
  const db = ctx.db;
  const ym = String(body.target_month || '');
  if (!/^\d{4}-\d{2}$/.test(ym) || ym < monthOf(today())) throw new HttpError(400, 'Choose a current or future target month.');
  let ids = Array.isArray(body.asset_ids) ? body.asset_ids.map(Number).filter(Boolean) : [];
  if (!ids.length && body.filter) ids = unscheduled(ctx, { ...body.filter, limit: 5000 }).rows.map(r => r.asset_id);
  if (!ids.length) throw new HttpError(400, 'Select at least one asset.');
  const assets = ids.map(id => getRaw(db, 'assets', id)).filter(Boolean);
  const dates = targetDates(assets.map(a => ({ from: `${ym}-15` })), ym, body.day_mode === 'date' ? 'date' : 'spread', body.date);
  const result = { created: 0, skipped: [] };
  const run = () => assets.forEach((a, i) => {
    if (db.prepare('SELECT 1 FROM pm_schedules WHERE asset_id = ? AND active = 1').get(a.id)) { result.skipped.push({ asset_tag: a.asset_tag, reason: 'already has a PM schedule' }); return; }
    const m = a.model_id ? getRaw(db, 'models', a.model_id) : null;
    const interval = Number(body.interval_months) || m?.pm_interval_months;
    if (!interval) { result.skipped.push({ asset_tag: a.asset_tag, reason: 'no PM interval on the model (set one, or enter an interval)' }); return; }
    const proc = a.model_id ? db.prepare("SELECT id FROM procedures WHERE model_id = ? AND status = 'Approved' ORDER BY version DESC LIMIT 1").get(a.model_id) : null;
    crud.create(logic.sys(ctx), 'pm_schedules', {
      asset_id: a.id, interval_months: interval, next_due: dates[i], procedure_id: proc?.id || null, active: 1,
      program: body.program || 'Manufacturer Recommended', team_id: body.team_id ? Number(body.team_id) : null, assigned_to: body.assigned_to ? Number(body.assigned_to) : null,
    });
    result.created++;
  });
  if (body.dry_run) {
    let after = null;
    try { tx(db, () => { run(); after = forecast(ctx, body.forecast || {}); throw new Error('__dry_run__'); }); } catch (e) { if (e.message !== '__dry_run__') throw e; }
    return { ...result, dry_run: true, after };
  }
  tx(db, () => { run(); crud.audit(ctx, 'pm-schedule', 'pm_schedules', null, `PM Planner: created ${result.created} PM schedule(s) starting ${ym}`); });
  return result;
}

module.exports = { forecast, list, unscheduled, reschedule, scheduleAssets, occurrences, workdays };

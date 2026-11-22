// Libre CMMS - Copyright (C) 2026 CreativeMed LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// Emailed reports: Unable To Locate reports to department managers, and monthly PM
// progress reports to technicians and teams. Each email carries a PDF (and optional
// CSV) attachment. Subjects and bodies come from editable templates in Settings.
const crud = require('./crud');
const logic = require('./logic');
const mailer = require('./mailer');
const pdf = require('./pdf');
const { toCsv } = require('./reports');
const { getSetting, setSetting } = require('../db');
const { HttpError, getRaw, today, nowIso } = crud;

const WRITER = u => u && ['admin', 'supervisor', 'technician'].includes(u.role);
const MANAGER = u => u && ['admin', 'supervisor'].includes(u.role);

const DEFAULT_TEMPLATES = {
  email_utl_subject: 'Unable To Locate: {count} medical device(s) assigned to {department}',
  email_utl_body: [
    'Hello {manager_name},',
    '',
    'Clinical Engineering is unable to find the assets in the attached report and are unable to provide necessary routine maintenance to ensure patient safety. Can you please assist with locating these medical devices? The Unable to Locate reports are being tracked by hospital administration. Thank you very much for your help.',
    '',
    'The attached report lists {count} device(s) assigned to {department} ({facility}). If you find any of them, please reply to this email or call Clinical Engineering.',
    '',
    '{sender_name}',
    '{sender_title}',
    '{org_name}',
  ].join('\n'),
  email_pm_subject: 'PM progress for {month}: {completed} of {due} complete ({pct}%)',
  email_pm_body: [
    'Hello {name},',
    '',
    'Here is your preventive maintenance progress for {month}.',
    '',
    'Due this month: {due}',
    'Completed: {completed}',
    'Remaining: {remaining}',
    'Overdue (any month): {overdue}',
    '',
    'The attached report lists the PMs that are still open. Thank you!',
    '',
    '{sender_name}',
    '{org_name}',
  ].join('\n'),
};
const template = (db, key) => getSetting(db, key, '') || DEFAULT_TEMPLATES[key];
const render = (tpl, vars) => String(tpl).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
const escHtml = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const textToHtml = t => String(t).split(/\n{2,}/).map(p => `<p>${escHtml(p).replace(/\n/g, '<br>')}</p>`).join('\n');
const monthName = ym => new Date(`${ym}-15T12:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const fileSafe = s => String(s || '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'report';

function sender(db, user) {
  const u = user ? getRaw(db, 'users', user.id) : null;
  return { sender_name: u?.full_name || 'Clinical Engineering', sender_title: u?.title || 'Clinical Engineering', sender_email: u?.email || '', org_name: getSetting(db, 'org_name', 'Libre CMMS') };
}

// Department manager: a CMMS user (their account email) or a typed name / email.
function deptManager(db, deptId) {
  const d = deptId ? getRaw(db, 'departments', deptId) : null;
  if (!d) return { name: null, email: null, source: null };
  if (d.manager_user_id) {
    const u = getRaw(db, 'users', d.manager_user_id);
    if (u?.email) return { name: u.full_name, email: u.email, source: 'CMMS user' };
  }
  if (d.manager_email) return { name: d.manager_name || null, email: d.manager_email, source: 'department record' };
  return { name: d.manager_name || null, email: null, source: null };
}

// ======================= Unable To Locate =======================
function utlRows(db, q = {}) {
  const w = ["u.status = 'Open'"]; const p = [];
  if (Array.isArray(q.utl_ids) && q.utl_ids.length) { w.push(`u.id IN (${q.utl_ids.map(() => '?').join(',')})`); p.push(...q.utl_ids.map(Number)); }
  if (q.facility_id) { w.push('u.facility_id = ?'); p.push(Number(q.facility_id)); }
  if (q.department_id) { w.push('u.department_id = ?'); p.push(Number(q.department_id)); }
  if (q.q) { const like = `%${String(q.q).replace(/[%_]/g, '')}%`; w.push('(a.asset_tag LIKE ? OR a.serial_number LIKE ? OR m.model LIKE ?)'); p.push(like, like, like); }
  return db.prepare(`SELECT u.id, u.asset_id, u.source, u.reported_at, u.reported_by, u.notes, u.manager_notified_at, u.department_id, u.facility_id,
      a.asset_tag, a.serial_number, a.control_number, a.room, a.current_room, a.last_seen_at, m.manufacturer, m.model, m.category,
      d.name department, f.name facility, cd.name last_dept, w.wo_number, i.inventory_number,
      CAST(julianday('now') - julianday(u.reported_at) AS INTEGER) days_missing
    FROM utl_events u JOIN assets a ON a.id = u.asset_id LEFT JOIN models m ON m.id = a.model_id
    LEFT JOIN departments d ON d.id = u.department_id LEFT JOIN facilities f ON f.id = u.facility_id
    LEFT JOIN departments cd ON cd.id = a.current_department_id LEFT JOIN work_orders w ON w.id = u.work_order_id
    LEFT JOIN inventories i ON i.id = u.inventory_id
    WHERE ${w.join(' AND ')} ORDER BY f.name, d.name, a.asset_tag`).all(...p);
}

const UTL_COLUMNS = [
  { key: 'asset_tag', label: 'Asset Tag', width: 1.1 }, { key: 'device', label: 'Device', width: 2.3 }, { key: 'serial_number', label: 'Serial #', width: 1.2 },
  { key: 'last_seen', label: 'Last Seen (location)', width: 2 }, { key: 'last_seen_date', label: 'Last Seen', width: 0.9 },
  { key: 'reported', label: 'Reported UTL', width: 0.9 }, { key: 'days_missing', label: 'Days', width: 0.5, align: 'right' }, { key: 'source', label: 'Found Missing During', width: 1.3 },
];
const utlRowView = r => ({
  asset_tag: r.asset_tag, device: [r.manufacturer, r.model, r.category ? `(${r.category})` : ''].filter(Boolean).join(' '), serial_number: r.serial_number || '',
  last_seen: [r.last_dept || r.department, r.current_room || r.room].filter(Boolean).join(' / '), last_seen_date: (r.last_seen_at || '').slice(0, 10),
  reported: String(r.reported_at || '').slice(0, 10), days_missing: r.days_missing,
  source: r.source === 'Inventory' ? `Inventory ${r.inventory_number || ''}`.trim() : r.source === 'PM Work Order' ? `PM ${r.wo_number || ''}`.trim() : r.source,
});

function groupByDepartment(db, rows) {
  const groups = new Map();
  for (const r of rows) {
    const k = r.department_id || 0;
    if (!groups.has(k)) groups.set(k, { department_id: r.department_id, department: r.department || '(no department)', facility: r.facility || '', rows: [], manager: deptManager(db, r.department_id) });
    groups.get(k).rows.push(r);
  }
  return [...groups.values()];
}

function utlPdf(db, g, user) {
  const s = sender(db, user);
  return pdf.report({
    org: s.org_name, title: `Unable To Locate - ${g.department}`,
    subtitle: 'Medical devices assigned to this department that Clinical Engineering could not locate for required maintenance.',
    meta: [['Facility', g.facility || '-'], ['Department', g.department], ['Department manager', g.manager.name || '-'], ['Report date', today()], ['Prepared by', `${s.sender_name}${s.sender_email ? ` (${s.sender_email})` : ''}`]],
    paragraphs: ['Clinical Engineering is unable to find the assets listed below and is unable to provide necessary routine maintenance to ensure patient safety. Please help locate these medical devices and notify Clinical Engineering when they are found.'],
    summary: [['Devices not located', g.rows.length], ['Longest missing (days)', Math.max(0, ...g.rows.map(r => r.days_missing || 0))]],
    table: { columns: UTL_COLUMNS, rows: g.rows.map(utlRowView).map(v => UTL_COLUMNS.map(c => v[c.key])) },
    after: ['When a device is found, Clinical Engineering scans it (or completes its pending work) and it is removed from this report automatically.'],
    footer: `${s.org_name} - Unable To Locate report - ${g.department} - generated ${today()} by Libre CMMS`,
  });
}

function utlEmail(db, g, user, overrides = {}) {
  const s = sender(db, user);
  const vars = { ...s, manager_name: g.manager.name || `${g.department} Manager`, department: g.department, facility: g.facility || '', count: g.rows.length, date: today() };
  const subject = overrides.subject || render(template(db, 'email_utl_subject'), vars);
  const body = overrides.body || render(template(db, 'email_utl_body'), vars);
  const list = g.rows.slice(0, 40).map(utlRowView);
  const table = `<table cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px">
    <tr style="background:#e8f1f3">${['Asset Tag', 'Device', 'Serial #', 'Last Seen', 'Days Missing'].map(h => `<th align="left" style="border-bottom:1px solid #ccd">${h}</th>`).join('')}</tr>
    ${list.map(v => `<tr><td>${escHtml(v.asset_tag)}</td><td>${escHtml(v.device)}</td><td>${escHtml(v.serial_number)}</td><td>${escHtml(v.last_seen)}</td><td align="right">${v.days_missing}</td></tr>`).join('')}
    </table>${g.rows.length > 40 ? `<p>...and ${g.rows.length - 40} more in the attached report.</p>` : ''}`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1d2733">${textToHtml(body)}<p><strong>Devices not located (${g.rows.length}):</strong></p>${table}</div>`;
  return { subject, body, html };
}

function utlPreview(ctx, body = {}) {
  if (!WRITER(ctx.user)) throw new HttpError(403, 'Not permitted');
  const groups = groupByDepartment(ctx.db, utlRows(ctx.db, body));
  return {
    email_configured: mailer.configured(ctx.db),
    groups: groups.map(g => {
      const e = utlEmail(ctx.db, g, ctx.user);
      return { department_id: g.department_id, department: g.department, facility: g.facility, count: g.rows.length, utl_ids: g.rows.map(r => r.id),
        manager: g.manager, to: g.manager.email || '', subject: e.subject, body: e.body,
        previously_notified: g.rows.filter(r => r.manager_notified_at).length, assets: g.rows.map(r => r.asset_tag) };
    }),
  };
}

async function utlSend(ctx, body = {}) {
  if (!WRITER(ctx.user)) throw new HttpError(403, 'Not permitted');
  const db = ctx.db;
  const groupsIn = Array.isArray(body.groups) ? body.groups : [];
  if (!groupsIn.length) throw new HttpError(400, 'Nothing to send.');
  const results = [];
  for (const gi of groupsIn) {
    const rows = utlRows(db, { utl_ids: (gi.utl_ids || []).map(Number) });
    const [g] = groupByDepartment(db, rows);
    if (!g) { results.push({ department: gi.department || '?', ok: false, error: 'No open Unable To Locate records in this group.' }); continue; }
    const e = utlEmail(db, g, ctx.user, { subject: gi.subject, body: gi.body });
    const attachments = [{ filename: `Unable-To-Locate-${fileSafe(g.department)}-${today()}.pdf`, content: utlPdf(db, g, ctx.user), contentType: 'application/pdf' }];
    if (body.attach_csv) {
      attachments.push({ filename: `Unable-To-Locate-${fileSafe(g.department)}-${today()}.csv`, contentType: 'text/csv',
        content: Buffer.from(toCsv(UTL_COLUMNS, g.rows.map(utlRowView)), 'utf8') });
    }
    const cc = mailer.parseList(gi.cc);
    if (body.cc_me) { const me = getRaw(db, 'users', ctx.user.id)?.email; if (me) cc.push(me); }
    try {
      await mailer.send(db, { to: gi.to, cc, subject: e.subject, text: e.body, html: e.html, attachments },
        { kind: 'Unable To Locate', related: `${g.department} (${g.rows.length} devices)`, sent_by: ctx.user.username });
      const stamp = nowIso();
      db.prepare(`UPDATE utl_events SET manager_notified_at = ?, manager_notified_to = ? WHERE id IN (${g.rows.map(() => '?').join(',')})`).run(stamp, mailer.parseList(gi.to).join(', '), ...g.rows.map(r => r.id));
      crud.audit(ctx, 'email', 'departments', g.department_id, `Unable To Locate report (${g.rows.length} devices) emailed to ${mailer.parseList(gi.to).join(', ')}`);
      // Optionally remember a typed address as the department manager's email.
      if (gi.save_as_manager && g.department_id && !g.manager.email) {
        const first = mailer.parseList(gi.to)[0];
        if (first) crud.update(logic.sys(ctx), 'departments', g.department_id, { manager_email: first });
      }
      results.push({ department: g.department, ok: true, to: mailer.parseList(gi.to), count: g.rows.length });
    } catch (err) {
      results.push({ department: g.department, ok: false, error: err.message });
    }
  }
  return { results, sent: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length };
}

function utlPdfDownload(ctx, q) {
  if (!WRITER(ctx.user) && ctx.user.role !== 'viewer') throw new HttpError(403, 'Not permitted');
  const ids = String(q.utl_ids || '').split(',').map(Number).filter(Boolean);
  const groups = groupByDepartment(ctx.db, utlRows(ctx.db, { ...q, utl_ids: ids.length ? ids : undefined }));
  if (!groups.length) throw new HttpError(404, 'No open Unable To Locate records match.');
  if (groups.length === 1) return { buf: utlPdf(ctx.db, groups[0], ctx.user), name: `Unable-To-Locate-${fileSafe(groups[0].department)}-${today()}.pdf` };
  // Several departments: one PDF with all of them.
  const all = { department: 'All selected departments', facility: [...new Set(groups.map(g => g.facility))].join(', '), manager: { name: '-' }, rows: groups.flatMap(g => g.rows) };
  return { buf: utlPdf(ctx.db, all, ctx.user), name: `Unable-To-Locate-${today()}.pdf` };
}

// ======================= PM progress =======================
const OPEN = "('Completed','Closed','Cancelled')";
function pmProgress(db, { month, user_id, team_id }) {
  const ym = /^\d{4}-\d{2}$/.test(month || '') ? month : today().slice(0, 7);
  const start = `${ym}-01`; const end = logic.addMonths(start, 1);
  const who = user_id ? ['w.assigned_to = ?', Number(user_id)] : ['w.team_id = ?', Number(team_id)];
  const swho = user_id ? ['s.assigned_to = ?', Number(user_id)] : ['s.team_id = ?', Number(team_id)];
  const sel = `SELECT w.id, w.wo_number, w.status, w.due_date, w.completed_at, a.asset_tag, m.manufacturer, m.model, m.category, d.name department, u.full_name technician
    FROM work_orders w JOIN assets a ON a.id = w.asset_id LEFT JOIN models m ON m.id = a.model_id LEFT JOIN departments d ON d.id = a.department_id LEFT JOIN users u ON u.id = w.assigned_to`;
  const inMonth = db.prepare(`${sel} WHERE w.pm_schedule_id IS NOT NULL AND w.status <> 'Cancelled' AND w.due_date >= ? AND w.due_date < ? AND ${who[0]} ORDER BY w.due_date`).all(start, end, who[1]);
  // Scheduled for this month but not yet generated as a work order.
  const pending = db.prepare(`SELECT s.id, NULL wo_number, 'Scheduled' status, s.next_due due_date, NULL completed_at, a.asset_tag, m.manufacturer, m.model, m.category, d.name department, u.full_name technician
    FROM pm_schedules s JOIN assets a ON a.id = s.asset_id LEFT JOIN models m ON m.id = a.model_id LEFT JOIN departments d ON d.id = a.department_id LEFT JOIN users u ON u.id = s.assigned_to
    WHERE s.active = 1 AND s.next_due >= ? AND s.next_due < ? AND ${swho[0]} AND a.status NOT IN ('Retired','Disposed')
      AND NOT EXISTS (SELECT 1 FROM work_orders w WHERE w.pm_schedule_id = s.id AND w.due_date = s.next_due)`).all(start, end, swho[1]);
  const overdue = db.prepare(`${sel} WHERE w.pm_schedule_id IS NOT NULL AND w.status NOT IN ${OPEN} AND w.due_date < ? AND ${who[0]} ORDER BY w.due_date`).all(today(), who[1]);
  const done = inMonth.filter(r => ['Completed', 'Closed'].includes(r.status)).length;
  const due = inMonth.length + pending.length;
  const openList = [...overdue.filter(r => r.due_date < start), ...inMonth.filter(r => !['Completed', 'Closed'].includes(r.status)), ...pending];
  return { month: ym, due, completed: done, remaining: due - done, overdue: overdue.length, pct: due ? Math.round((100 * done) / due) : 100, open: openList };
}

const PM_COLUMNS = [{ key: 'due_date', label: 'Due', width: 0.9 }, { key: 'wo_number', label: 'Work Order', width: 1.3 }, { key: 'asset_tag', label: 'Asset', width: 1.1 },
  { key: 'device', label: 'Device', width: 2.4 }, { key: 'department', label: 'Department', width: 1.6 }, { key: 'status', label: 'Status', width: 1 }];
const pmRowView = r => ({ due_date: r.due_date, wo_number: r.wo_number || '(not yet generated)', asset_tag: r.asset_tag, device: [r.manufacturer, r.model].filter(Boolean).join(' '),
  department: r.department || '', status: r.due_date < today() && !['Completed', 'Closed'].includes(r.status) ? `${r.status} - OVERDUE` : r.status });

function pmPdf(db, name, p, user) {
  const s = sender(db, user);
  return pdf.report({
    org: s.org_name, title: `PM Progress - ${name}`, subtitle: `Preventive maintenance due in ${monthName(p.month)}.`,
    meta: [['For', name], ['Month', monthName(p.month)], ['Report date', today()]],
    summary: [['Due this month', p.due], ['Completed', p.completed], ['Remaining', p.remaining], ['Completion', `${p.pct}%`], ['Overdue (any month)', p.overdue]],
    table: { title: 'Open PMs (overdue first)', columns: PM_COLUMNS, rows: p.open.map(pmRowView).map(v => PM_COLUMNS.map(c => v[c.key])), empty: 'All PMs for this month are complete. Great work!' },
    footer: `${s.org_name} - PM progress - ${name} - ${monthName(p.month)} - generated ${today()} by Libre CMMS`,
  });
}

async function pmSend(ctx, body = {}) {
  if (!MANAGER(ctx.user) && !ctx.internal) throw new HttpError(403, 'Supervisor role required to email PM progress reports.');
  const db = ctx.db;
  const ym = /^\d{4}-\d{2}$/.test(body.month || '') ? body.month : today().slice(0, 7);
  const s = sender(db, ctx.user);
  const ccMe = body.cc_me && ctx.user ? getRaw(db, 'users', ctx.user.id)?.email : null;
  const jobs = [];
  for (const id of (body.technician_ids || []).map(Number)) {
    const u = getRaw(db, 'users', id);
    if (u) jobs.push({ name: u.full_name, to: u.email ? [u.email] : [], q: { user_id: id }, related: `Technician ${u.full_name}` });
  }
  for (const id of (body.team_ids || []).map(Number)) {
    const t = getRaw(db, 'teams', id);
    if (!t) continue;
    const emails = db.prepare('SELECT u.email FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = ? AND u.active = 1 AND u.email IS NOT NULL').all(id).map(r => r.email);
    jobs.push({ name: t.name, to: emails, q: { team_id: id }, related: `Team ${t.name}` });
  }
  if (!jobs.length) throw new HttpError(400, 'Choose at least one technician or team.');
  const results = [];
  for (const j of jobs) {
    if (!j.to.length) { results.push({ name: j.name, ok: false, error: 'No email address on file' }); continue; }
    const p = pmProgress(db, { month: ym, ...j.q });
    const vars = { ...s, name: j.name, month: monthName(ym), due: p.due, completed: p.completed, remaining: p.remaining, overdue: p.overdue, pct: p.pct };
    const subject = render(template(db, 'email_pm_subject'), vars);
    const text = render(template(db, 'email_pm_body'), vars);
    try {
      await mailer.send(db, { to: j.to, cc: ccMe ? [ccMe] : [], subject, text, html: `<div style="font-family:Arial,sans-serif;font-size:14px">${textToHtml(text)}</div>`,
        attachments: [{ filename: `PM-Progress-${fileSafe(j.name)}-${ym}.pdf`, content: pmPdf(db, j.name, p, ctx.user), contentType: 'application/pdf' }] },
      { kind: 'PM progress', related: `${j.related} - ${ym}`, sent_by: ctx.user?.username || 'scheduler' });
      results.push({ name: j.name, ok: true, to: j.to, due: p.due, completed: p.completed });
    } catch (err) { results.push({ name: j.name, ok: false, error: err.message }); }
  }
  if (ctx.user) crud.audit(ctx, 'email', null, null, `PM progress (${ym}) emailed: ${results.filter(r => r.ok).length} sent, ${results.filter(r => !r.ok).length} failed`);
  return { results, sent: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length };
}

function pmPdfDownload(ctx, q) {
  if (ctx.user.role === 'requester') throw new HttpError(403, 'Not permitted');
  const db = ctx.db;
  let name;
  if (q.user_id) name = getRaw(db, 'users', Number(q.user_id))?.full_name;
  else if (q.team_id) name = getRaw(db, 'teams', Number(q.team_id))?.name;
  if (!name) throw new HttpError(400, 'Choose a technician or team.');
  const p = pmProgress(db, q);
  return { buf: pmPdf(db, name, p, ctx.user), name: `PM-Progress-${fileSafe(name)}-${p.month}.pdf`, data: p };
}

// Scheduled job: on the chosen day each month, email every technician with PMs due.
async function autoMonthly(db) {
  if (getSetting(db, 'pm_progress_auto', '0') !== '1' || !mailer.configured(db)) return null;
  const day = Number(getSetting(db, 'pm_progress_day', '1')) || 1;
  const t = today(); const ym = t.slice(0, 7);
  if (Number(t.slice(8, 10)) < day || getSetting(db, 'pm_progress_last', '') === ym) return null;
  setSetting(db, 'pm_progress_last', ym);
  const techs = db.prepare("SELECT id FROM users WHERE active = 1 AND role IN ('technician','supervisor') AND email IS NOT NULL").all()
    .map(r => r.id).filter(id => pmProgress(db, { month: ym, user_id: id }).due > 0);
  if (!techs.length) return null;
  return pmSend({ db, user: null, internal: true, ip: 'scheduler' }, { month: ym, technician_ids: techs });
}

// Open UTL list for the Unable To Locate page (with department manager details).
function utlList(ctx, q = {}) {
  if (!ctx.user) throw new HttpError(401, 'Please sign in');
  const rows = utlRows(ctx.db, q);
  const mgrs = new Map();
  return { rows: rows.map(r => {
    if (!mgrs.has(r.department_id)) mgrs.set(r.department_id, deptManager(ctx.db, r.department_id));
    const m = mgrs.get(r.department_id);
    return { ...utlRowView(r), id: r.id, asset_id: r.asset_id, department_id: r.department_id, facility_id: r.facility_id, department: r.department || '(no department)', facility: r.facility || '',
      manager_name: m.name || '', manager_email: m.email || '', manager_notified_at: r.manager_notified_at, notes: r.notes || '' };
  }), email_configured: mailer.configured(ctx.db) };
}

module.exports = { DEFAULT_TEMPLATES, render, deptManager, utlList, utlPreview, utlSend, utlPdfDownload, pmProgress, pmSend, pmPdfDownload, autoMonthly, utlRows };

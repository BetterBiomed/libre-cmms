#!/usr/bin/env node
// Libre CMMS - Copyright (C) 2026 CreativeMed LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { entities, ROLES } = require('./schema');
const dbm = require('./db');
const auth = require('./lib/auth');
const crud = require('./lib/crud');
const logic = require('./lib/logic');
const reports = require('./lib/reports');
const inventory = require('./lib/inventory');
const deviceLookup = require('./lib/device-lookup');
const pmPlanner = require('./lib/pm-planner');
const emailReports = require('./lib/email-reports');
const mailer = require('./lib/mailer');
const passwordReset = require('./lib/password-reset');
const { HttpError } = crud;

const VERSION = require('../package.json').version;
const ROOT = path.resolve(__dirname, '..');

// ---------------- configuration ----------------
function loadConfig() {
  const defaults = {
    host: '0.0.0.0', port: 8080, dataDir: 'data', https: { enabled: false, certFile: '', keyFile: '', redirectHttpPort: 0 },
    sessionHours: 12, maxUploadMB: 50, backup: { enabled: true, hour: 2, keep: 14, dir: '' }, trustProxy: false,
  };
  const file = process.env.LIBRE_CONFIG || path.join(ROOT, 'config', 'libre.config.json');
  let cfg = {};
  if (fs.existsSync(file)) cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const c = { ...defaults, ...cfg, https: { ...defaults.https, ...cfg.https }, backup: { ...defaults.backup, ...cfg.backup } };
  if (process.env.LIBRE_PORT) c.port = Number(process.env.LIBRE_PORT);
  if (process.env.LIBRE_HOST) c.host = process.env.LIBRE_HOST;
  if (process.env.LIBRE_DATA_DIR) c.dataDir = process.env.LIBRE_DATA_DIR;
  c.dataDir = path.resolve(ROOT, c.dataDir);
  c.uploadDir = path.join(c.dataDir, 'uploads');
  c.backup.dir = path.resolve(c.dataDir, c.backup.dir || 'backups');
  return c;
}

const config = loadConfig();
const db = dbm.open(config.dataDir);
require('./lib/device-lookup').configure(config.lookup || {});
fs.mkdirSync(config.uploadDir, { recursive: true });

// ---------------- helpers ----------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.mp4': 'video/mp4', '.webp': 'image/webp' };

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  if (config.https.enabled) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(data);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Upload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function jsonBody(req) {
  const buf = await readBody(req, 5 * 1024 * 1024);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON'); }
}

function clientIp(req) {
  if (config.trustProxy && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return req.socket.remoteAddress;
}

function cookie(name, value, maxAgeSec) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax${config.https.enabled || config.trustProxy ? '; Secure' : ''}; Max-Age=${maxAgeSec}`;
}

const isManager = u => ['admin', 'supervisor'].includes(u.role);
function need(cond, msg = 'Not permitted') { if (!cond) throw new HttpError(403, msg); }

// Simple in-memory rate limiter for login and the public portal.
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const b = buckets.get(key) || { n: 0, reset: now + windowMs };
  if (now > b.reset) { b.n = 0; b.reset = now + windowMs; }
  b.n++; buckets.set(key, b);
  if (b.n > max) throw new HttpError(429, 'Too many requests. Please wait and try again.');
}

// ---------------- metadata for the web client ----------------
function meta(user) {
  const ents = {};
  for (const [name, e] of Object.entries(entities)) {
    if (!auth.can(user, e, 'read')) continue;
    ents[name] = {
      name, label: e.label, plural: e.plural, group: e.group, note: e.note, fields: e.fields, children: e.children,
      canWrite: auth.can(user, e, 'write') && !e.readonlyApi, canDelete: auth.can(user, e, 'delete'),
      views: Object.entries(crud.VIEWS[name] || {}).map(([k, v]) => ({ key: k, label: v.label })),
    };
  }
  const lookups = {};
  for (const r of db.prepare('SELECT list, value FROM lookups ORDER BY list, sort, value').all()) (lookups[r.list] = lookups[r.list] || []).push(r.value);
  return {
    version: VERSION, org_name: dbm.getSetting(db, 'org_name', 'Libre CMMS'), roles: ROLES, entities: ents, lookups,
    labels: {
      code: dbm.getSetting(db, 'label_code', 'qr'), qr_content: dbm.getSetting(db, 'label_qr_content', 'url'),
      size: dbm.getSetting(db, 'label_size', 'standard'), public_url: dbm.getSetting(db, 'public_url', ''),
    },
    reports: Object.entries(reports.REPORTS).map(([k, r]) => ({ key: k, title: r.title, filters: r.filters })),
  };
}

// ---------------- CSV import ----------------
function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = ''; if (row.some(v => v !== '')) rows.push(row); row = [];
    } else field += c;
  }
  row.push(field); if (row.some(v => v !== '')) rows.push(row);
  return rows;
}

function importCsv(ctx, ename, text) {
  const e = entities[ename];
  need(e && isManager(ctx.user) && !e.readonlyApi, 'Supervisor role required for imports');
  const rows = parseCsv(text);
  if (rows.length < 2) throw new HttpError(400, 'CSV needs a header row and at least one data row.');
  const header = rows[0].map(h => h.trim());
  const norm = s => String(s).trim().toLowerCase();
  const map = header.map(h => e.columns.find(f => f.name === h || norm(f.label) === norm(h) || (f.aliases || []).some(a => norm(a) === norm(h))));
  const result = { created: 0, updated: 0, errors: [], duplicates: 0 };
  const uniqueField = e.columns.find(f => f.unique);
  for (let i = 1; i < rows.length; i++) {
    const obj = {};
    rows[i].forEach((v, j) => {
      const f = map[j]; if (!f || v === '') return;
      if (f.type === 'ref') {
        // Accept an id or the referenced record's display text.
        if (/^\d+$/.test(v)) { obj[f.name] = v; return; }
        const te = entities[f.ref]; const disp = [].concat(te.display)[0];
        let hit = db.prepare(`SELECT id FROM "${f.ref}" WHERE "${disp}" = ? COLLATE NOCASE`).get(v.trim());
        if (!hit && f.ref === 'models' && v.includes('|')) {
          const [mf, md] = v.split('|').map(s => s.trim());
          hit = db.prepare('SELECT id FROM models WHERE manufacturer = ? COLLATE NOCASE AND model = ? COLLATE NOCASE').get(mf, md);
          if (!hit) hit = { id: crud.create(ctx, 'models', { manufacturer: mf, model: md }).id };
        }
        if (!hit) throw Object.assign(new Error(), { rowError: `${f.label} "${v}" not found` });
        obj[f.name] = hit.id;
      } else obj[f.name] = v;
    });
    try {
      const existing = uniqueField && obj[uniqueField.name] ? db.prepare(`SELECT id FROM "${ename}" WHERE "${uniqueField.name}" = ?`).get(obj[uniqueField.name]) : null;
      if (existing) {
        crud.update(ctx, ename, existing.id, obj); result.updated++;
      } else {
        if (ename === 'assets' && obj.serial_number && obj.model_id) {
          const dup = db.prepare('SELECT asset_tag FROM assets WHERE serial_number = ? AND model_id = ?').get(obj.serial_number, obj.model_id);
          if (dup) { result.duplicates++; result.errors.push(`Row ${i + 1}: possible duplicate of ${dup.asset_tag} (same model & serial) - skipped`); continue; }
        }
        crud.create(ctx, ename, obj); result.created++;
      }
    } catch (err) {
      result.errors.push(`Row ${i + 1}: ${err.rowError || err.message}`);
    }
  }
  crud.audit(ctx, 'import', ename, null, `CSV import: ${result.created} created, ${result.updated} updated, ${result.errors.length} errors`);
  return result;
}

// ---------------- router ----------------
const routes = [];
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, opts });
}

// Public (no login)
route('GET', '/api/health', () => ({ ok: true, version: VERSION }), { public: true });
route('GET', '/api/setup/status', () => ({
  needsSetup: db.prepare('SELECT COUNT(*) n FROM users').get().n === 0,
  org_name: dbm.getSetting(db, 'org_name', 'Libre CMMS'), version: VERSION,
  password_reset: passwordReset.available(db),
}), { public: true });
route('POST', '/api/setup', async (ctx) => {
  if (db.prepare('SELECT COUNT(*) n FROM users').get().n) throw new HttpError(409, 'Setup already completed');
  const b = await jsonBody(ctx.req);
  const problem = auth.passwordProblem(b.password);
  if (problem) throw new HttpError(400, problem);
  if (!b.username || !b.full_name) throw new HttpError(400, 'Username and full name are required');
  if (!mailer.validEmail(b.email)) throw new HttpError(400, 'A valid email address is required for the administrator.');
  const hash = auth.hashPassword(b.password);
  dbm.tx(db, () => {
    if (b.org_name) dbm.setSetting(db, 'org_name', String(b.org_name).slice(0, 120));
    const sctx = { db, user: null, ip: ctx.ip, internal: true };
    const u = crud.create(sctx, 'users', { username: b.username, full_name: b.full_name, email: b.email || null, role: 'admin', active: 1 });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, u.id);
    if (b.sample_data) require('./sample-data').load(db, u);
  });
  return { ok: true };
}, { public: true });

route('POST', '/api/auth/login', async (ctx) => {
  rateLimit('login:' + ctx.ip, 20, 15 * 60e3);
  const b = await jsonBody(ctx.req);
  const u = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(String(b.username || '').trim());
  const fail = () => { throw new HttpError(401, 'Invalid username or password'); };
  if (!u || !u.active) fail();
  if (u.locked_until && u.locked_until > new Date().toISOString()) throw new HttpError(423, 'Account temporarily locked after failed attempts. Try again in 15 minutes.');
  if (!auth.verifyPassword(String(b.password || ''), u.password_hash)) {
    const n = (u.failed_logins || 0) + 1;
    db.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?').run(n >= 5 ? 0 : n, n >= 5 ? new Date(Date.now() + 15 * 60e3).toISOString() : null, u.id);
    crud.audit({ db, user: { id: u.id, username: u.username }, ip: ctx.ip }, 'login-failed', 'users', u.id, 'Failed login');
    fail();
  }
  db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login = ? WHERE id = ?').run(new Date().toISOString(), u.id);
  const token = auth.createSession(db, u.id, config.sessionHours, ctx.ip, ctx.req.headers['user-agent']);
  crud.audit({ db, user: { id: u.id, username: u.username }, ip: ctx.ip }, 'login', 'users', u.id, 'Signed in');
  ctx.setCookie = cookie('libre_session', token, config.sessionHours * 3600);
  return { ok: true, must_change_password: !!u.must_change_password };
}, { public: true });

// Forgot password (no login). Same answer whether or not the account exists.
route('POST', '/api/auth/forgot', async (ctx) => {
  rateLimit('forgot:' + ctx.ip, 5, 15 * 60e3);
  return passwordReset.request(ctx, await jsonBody(ctx.req));
}, { public: true });
route('POST', '/api/auth/reset/check', async (ctx) => {
  rateLimit('reset:' + ctx.ip, 30, 15 * 60e3);
  return passwordReset.check(ctx, await jsonBody(ctx.req));
}, { public: true });
route('POST', '/api/auth/reset', async (ctx) => {
  rateLimit('reset:' + ctx.ip, 30, 15 * 60e3);
  return passwordReset.reset(ctx, await jsonBody(ctx.req));
}, { public: true });

route('GET', '/api/public/info', () => ({
  org_name: dbm.getSetting(db, 'org_name', 'Libre CMMS'), portal_enabled: dbm.getSetting(db, 'portal_enabled', '1') === '1',
  portal_message: dbm.getSetting(db, 'portal_message', ''),
  departments: db.prepare("SELECT d.id, d.name, f.name facility FROM departments d LEFT JOIN facilities f ON f.id = d.facility_id ORDER BY f.name, d.name").all(),
}), { public: true });
route('GET', '/api/public/asset/:tag', (ctx, p) => {
  rateLimit('portal:' + ctx.ip, 120, 60e3);
  const a = logic.findAssetByText(db, decodeURIComponent(p.tag));
  if (!a) throw new HttpError(404, 'Equipment not found');
  const m = a.model_id ? crud.getRaw(db, 'models', a.model_id) : null;
  return { asset_tag: a.asset_tag, description: a.description || (m ? `${m.manufacturer} ${m.model}` : ''), department_id: a.department_id, room: a.room };
}, { public: true });
route('POST', '/api/public/requests', async (ctx) => {
  rateLimit('portal:' + ctx.ip, 10, 10 * 60e3);
  return logic.publicSubmit(ctx, await jsonBody(ctx.req));
}, { public: true });
route('GET', '/api/public/requests/:num', (ctx, p) => {
  rateLimit('portal:' + ctx.ip, 120, 60e3);
  return logic.publicStatus(db, decodeURIComponent(p.num), ctx.query.token);
}, { public: true });
route('POST', '/api/public/requests/:num/feedback', async (ctx, p) => {
  rateLimit('portal:' + ctx.ip, 10, 10 * 60e3);
  return logic.publicFeedback(ctx, decodeURIComponent(p.num), ctx.query.token, await jsonBody(ctx.req));
}, { public: true });

// Authenticated
route('POST', '/api/auth/logout', (ctx) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(ctx.token);
  ctx.setCookie = cookie('libre_session', '', 0);
  return { ok: true };
}, { allowPasswordChange: true });
route('GET', '/api/auth/me', ctx => ({ user: ctx.user }), { allowPasswordChange: true });
route('POST', '/api/auth/password', async (ctx) => {
  const b = await jsonBody(ctx.req);
  const u = crud.getRaw(db, 'users', ctx.user.id);
  if (!auth.verifyPassword(String(b.current || ''), u.password_hash)) throw new HttpError(400, 'Current password is incorrect');
  const problem = auth.passwordProblem(b.password);
  if (problem) throw new HttpError(400, problem);
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(auth.hashPassword(b.password), u.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(u.id, ctx.token);
  crud.audit(ctx, 'password-change', 'users', u.id, 'Password changed');
  return { ok: true };
}, { allowPasswordChange: true });
route('POST', '/api/users/:id/password', async (ctx, p) => {
  need(ctx.user.role === 'admin');
  const b = await jsonBody(ctx.req);
  const problem = auth.passwordProblem(b.password);
  if (problem) throw new HttpError(400, problem);
  const id = Number(p.id);
  if (!crud.getRaw(db, 'users', id)) throw new HttpError(404, 'User not found');
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = ?, failed_logins = 0, locked_until = NULL WHERE id = ?').run(auth.hashPassword(b.password), id === ctx.user.id ? 0 : 1, id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(id, ctx.token);
  crud.audit(ctx, 'password-reset', 'users', id, 'Password set by administrator');
  return { ok: true };
});

route('GET', '/api/meta', ctx => meta(ctx.user));
route('GET', '/api/dashboard', ctx => reports.dashboard(db, ctx.user));
route('GET', '/api/search', (ctx) => {
  const q = String(ctx.query.q || '').trim();
  if (!q) return { results: [] };
  const out = [];
  for (const en of ['assets', 'work_orders', 'models', 'documents', 'parts', 'service_requests', 'recalls', 'vendors']) {
    if (!auth.can(ctx.user, entities[en], 'read')) continue;
    const r = crud.list(ctx, en, { q, limit: 8 });
    for (const row of r.rows) out.push({ entity: en, label: entities[en].label, id: row.id, text: row._label });
  }
  return { results: out };
});
route('GET', '/api/lookup/asset', (ctx) => {
  const a = logic.findAssetByText(db, ctx.query.code);
  if (!a) throw new HttpError(404, 'No asset matches that code');
  return { id: a.id };
});

// Generic entity CRUD
route('GET', '/api/e/:entity', (ctx, p) => {
  const r = crud.list(ctx, p.entity, ctx.query);
  if (ctx.query.format === 'csv') {
    const e = entities[p.entity];
    const columns = [{ key: 'id', label: 'ID' }, ...e.columns.map(f => ({ key: f.name, label: f.label, type: f.type }))];
    const rows = r.rows.map(row => { const o = { ...row }; for (const f of e.columns) if (f.type === 'ref' && row._labels?.[f.name]) o[f.name] = row._labels[f.name]; return o; });
    return { __raw: reports.toCsv(columns, rows), type: 'text/csv; charset=utf-8', filename: `${p.entity}-${crud.today()}.csv` };
  }
  return r;
});
route('GET', '/api/e/:entity/:id', (ctx, p) => {
  const row = crud.get(ctx, p.entity, Number(p.id));
  const extra = {};
  if (p.entity === 'assets') extra.coverage = logic.coverage(db, row.id);
  if (p.entity === 'work_orders' && row.asset_id) extra.coverage = logic.coverage(db, row.asset_id);
  return { row, ...extra };
});
route('POST', '/api/e/:entity', async (ctx, p) => {
  const b = await jsonBody(ctx.req);
  return { row: dbm.tx(db, () => crud.create(ctx, p.entity, b)) };
});
route('PUT', '/api/e/:entity/:id', async (ctx, p) => {
  const b = await jsonBody(ctx.req);
  return { row: dbm.tx(db, () => crud.update(ctx, p.entity, Number(p.id), b)) };
});
route('DELETE', '/api/e/:entity/:id', (ctx, p) => { dbm.tx(db, () => crud.remove(ctx, p.entity, Number(p.id))); return { ok: true }; });
route('POST', '/api/import/:entity', async (ctx, p) => {
  const buf = await readBody(ctx.req, 20 * 1024 * 1024);
  return dbm.tx(db, () => importCsv(ctx, p.entity, buf.toString('utf8')));
});

// Workflows
// Email: Unable To Locate reports to department managers, PM progress reports
const pdfResult = (r) => ({ __raw: r.buf, type: 'application/pdf', filename: r.name });
route('GET', '/api/utl/open', (ctx) => emailReports.utlList(ctx, ctx.query));
route('GET', '/api/utl/report.pdf', (ctx) => pdfResult(emailReports.utlPdfDownload(ctx, ctx.query)));
route('POST', '/api/utl/email/preview', async (ctx) => emailReports.utlPreview(ctx, await jsonBody(ctx.req)));
route('POST', '/api/utl/email', async (ctx) => emailReports.utlSend(ctx, await jsonBody(ctx.req)));
route('GET', '/api/pm/progress', (ctx) => { const r = emailReports.pmPdfDownload(ctx, ctx.query); return r.data; });
route('GET', '/api/pm/progress.pdf', (ctx) => pdfResult(emailReports.pmPdfDownload(ctx, ctx.query)));
route('POST', '/api/pm/progress/email', async (ctx) => emailReports.pmSend(ctx, await jsonBody(ctx.req)));
route('POST', '/api/email/test', async (ctx) => {
  need(ctx.user.role === 'admin');
  const b = await jsonBody(ctx.req);
  const to = b.to || crud.getRaw(db, 'users', ctx.user.id)?.email;
  try {
    await mailer.send(db, { to, subject: `Libre CMMS test email from ${dbm.getSetting(db, 'org_name', 'Libre CMMS')}`, text: 'Email from Libre CMMS is working.',
      html: '<p>Email from <strong>Libre CMMS</strong> is working.</p>' }, { kind: 'Test', sent_by: ctx.user.username });
  } catch (e) { throw new HttpError(502, e.message); }
  return { ok: true, to };
});
// PM Planner (load balancing)
const notRequester = ctx => need(ctx.user.role !== 'requester');
route('GET', '/api/pm/forecast', (ctx) => { notRequester(ctx); return pmPlanner.forecast(ctx, ctx.query); });
route('GET', '/api/pm/plan', (ctx) => { notRequester(ctx); return pmPlanner.list(ctx, ctx.query); });
route('GET', '/api/pm/unscheduled', (ctx) => { notRequester(ctx); return pmPlanner.unscheduled(ctx, ctx.query); });
route('POST', '/api/pm/reschedule', async (ctx) => pmPlanner.reschedule(ctx, await jsonBody(ctx.req)));
route('POST', '/api/pm/schedule-assets', async (ctx) => pmPlanner.scheduleAssets(ctx, await jsonBody(ctx.req)));
// Device Lookup (FDA GUDID / classification / recalls + Libre reference table)
const blockRequester = ctx => need(!['requester'].includes(ctx.user.role));
route('GET', '/api/device-lookup', async (ctx) => { blockRequester(ctx); return deviceLookup.lookup(ctx, ctx.query); });
route('GET', '/api/device-lookup/recalls', async (ctx) => { blockRequester(ctx); return deviceLookup.recalls(ctx, ctx.query); });
route('POST', '/api/device-lookup/apply', async (ctx) => deviceLookup.apply(ctx, await jsonBody(ctx.req)));
route('POST', '/api/device-lookup/recall', async (ctx) => deviceLookup.importRecall(ctx, await jsonBody(ctx.req)));
// Inventory Mode
route('POST', '/api/inventories', async (ctx) => inventory.start(ctx, await jsonBody(ctx.req)));
route('GET', '/api/inventories/:id/session', (ctx, p) => inventory.session(ctx, Number(p.id)));
route('POST', '/api/inventories/:id/scan', async (ctx, p) => inventory.scan(ctx, Number(p.id), await jsonBody(ctx.req)));
route('POST', '/api/inventories/:id/scans/:scan/link', async (ctx, p) => inventory.linkScan(ctx, Number(p.id), Number(p.scan), await jsonBody(ctx.req)));
route('DELETE', '/api/inventories/:id/scans/:scan', (ctx, p) => inventory.removeScan(ctx, Number(p.id), Number(p.scan)));
route('POST', '/api/inventories/:id/complete', async (ctx, p) => ({ row: inventory.complete(ctx, Number(p.id), await jsonBody(ctx.req)) }));
route('POST', '/api/inventories/:id/cancel', (ctx, p) => ({ row: inventory.cancel(ctx, Number(p.id)) }));
route('GET', '/api/assets/:id/flags', (ctx, p) => {
  const a = crud.get(ctx, 'assets', Number(p.id));
  return { flags: inventory.assetFlags(db, crud.getRaw(db, 'assets', a.id), null) };
});
route('POST', '/api/assets/:id/utl', async (ctx, p) => {
  need(['admin', 'supervisor', 'technician'].includes(ctx.user.role));
  const b = await jsonBody(ctx.req);
  if (!String(b.notes || '').trim()) throw new HttpError(400, 'Describe where you searched (required).');
  dbm.tx(db, () => logic.markUtl(ctx, Number(p.id), { source: 'Manual', notes: b.notes }));
  return { row: crud.getRaw(db, 'assets', Number(p.id)) };
});
route('POST', '/api/assets/:id/located', async (ctx, p) => {
  need(['admin', 'supervisor', 'technician'].includes(ctx.user.role));
  const b = await jsonBody(ctx.req);
  dbm.tx(db, () => logic.resolveUtl(ctx, Number(p.id), `Located manually${b.notes ? ': ' + b.notes : ''}`));
  return { row: crud.getRaw(db, 'assets', Number(p.id)) };
});
route('POST', '/api/wo/bulk', async (ctx) => logic.bulkWorkOrders(ctx, await jsonBody(ctx.req)));
route('GET', '/api/workload', (ctx) => { need(ctx.user.role !== 'requester'); return logic.workload(db); });
route('GET', '/api/distinct/:entity/:field', (ctx, p) => {
  const e = entities[p.entity];
  if (!e || !auth.can(ctx.user, e, 'read')) throw new HttpError(404, 'Not found');
  const f = e.columns.find(c => c.name === p.field && ['text', 'select'].includes(c.type));
  if (!f) throw new HttpError(404, 'Not found');
  return { values: db.prepare(`SELECT DISTINCT "${f.name}" v FROM "${e.name}" WHERE "${f.name}" IS NOT NULL AND "${f.name}" <> '' ORDER BY 1 LIMIT 500`).all().map(r => r.v) };
});
route('POST', '/api/wo/:id/:action', async (ctx, p) => ({ row: logic.woAction(ctx, Number(p.id), p.action, await jsonBody(ctx.req)) }));
route('POST', '/api/pm/generate', (ctx) => { need(isManager(ctx.user)); return { created: logic.generatePMs(ctx) }; });
route('POST', '/api/pm/bulk', async (ctx) => ({ created: logic.bulkSchedule(ctx, await jsonBody(ctx.req)) }));
route('POST', '/api/pm/:id/defer', async (ctx, p) => ({ row: logic.approveDeferral(ctx, Number(p.id), await jsonBody(ctx.req)) }));
route('POST', '/api/procedures/:id/:action', (ctx, p) => ({ row: logic.procAction(ctx, Number(p.id), p.action) }));
route('POST', '/api/runs', async (ctx) => logic.startRun(ctx, await jsonBody(ctx.req)));
route('GET', '/api/runs/:id', (ctx, p) => logic.getRun(ctx, Number(p.id)));
route('PUT', '/api/runs/:id/results', async (ctx, p) => logic.recordResults(ctx, Number(p.id), (await jsonBody(ctx.req)).results));
route('POST', '/api/runs/:id/complete', async (ctx, p) => logic.completeRun(ctx, Number(p.id), await jsonBody(ctx.req)));
route('DELETE', '/api/runs/:id', (ctx, p) => { logic.discardRun(ctx, Number(p.id)); return { ok: true }; });
route('POST', '/api/recalls/:id/match', (ctx, p) => { need(['admin', 'supervisor', 'technician'].includes(ctx.user.role)); return logic.matchRecall(ctx, Number(p.id)); });
route('POST', '/api/recalls/:id/workorders', (ctx, p) => { need(['admin', 'supervisor', 'technician'].includes(ctx.user.role)); return { created: logic.recallWorkOrders(ctx, Number(p.id)) }; });
route('POST', '/api/requests/:id/convert', async (ctx, p) => ({ row: logic.convertRequest(ctx, Number(p.id), await jsonBody(ctx.req)) }));
route('POST', '/api/parts/:id/stock', async (ctx, p) => ({ row: logic.adjustStock(ctx, Number(p.id), await jsonBody(ctx.req)) }));
route('POST', '/api/po/:id/approve', async (ctx, p) => ({ row: logic.approvePo(ctx, Number(p.id), await jsonBody(ctx.req)) }));
route('GET', '/api/po/:id/approval', (ctx, p) => { const po = crud.getRaw(db, 'purchase_orders', Number(p.id)); if (!po) throw new HttpError(404, 'PO not found'); return logic.poApproval(db, po); });
route('POST', '/api/po/:id/receive', (ctx, p) => ({ row: logic.receivePo(ctx, Number(p.id)) }));

// Reports
route('GET', '/api/reports/:name', (ctx, p) => {
  need(ctx.user.role !== 'requester');
  const r = reports.runReport(db, p.name, ctx.query);
  if (!r) throw new HttpError(404, 'Unknown report');
  if (ctx.query.format === 'csv') return { __raw: reports.toCsv(r.columns, r.rows), type: 'text/csv; charset=utf-8', filename: `${p.name}-${crud.today()}.csv` };
  return r;
});

// Audit trail
route('GET', '/api/audit', (ctx) => {
  const q = ctx.query;
  const recordScoped = q.entity && q.entity_id;
  if (recordScoped) crud.get(ctx, q.entity, Number(q.entity_id)); // permission check on the record
  else need(isManager(ctx.user), 'Supervisor role required');
  const w = []; const p = [];
  if (q.entity) { w.push('entity = ?'); p.push(q.entity); }
  if (q.entity_id) { w.push('entity_id = ?'); p.push(Number(q.entity_id)); }
  if (q.user) { w.push('user_name = ?'); p.push(q.user); }
  if (q.action) { w.push('action = ?'); p.push(q.action); }
  if (q.from) { w.push('ts >= ?'); p.push(q.from); }
  if (q.to) { w.push('ts <= ?'); p.push(q.to + 'T23:59:59'); }
  const limit = Math.min(Number(q.limit) || 200, q.format === 'csv' ? 1e6 : 1000);
  const rows = db.prepare(`SELECT * FROM audit_log ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`).all(...p, limit);
  if (q.format === 'csv') {
    const cols = ['id', 'ts', 'user_name', 'action', 'entity', 'entity_id', 'summary', 'changes', 'ip'].map(k => ({ key: k, label: k }));
    return { __raw: reports.toCsv(cols, rows), type: 'text/csv; charset=utf-8', filename: `audit-${crud.today()}.csv` };
  }
  return { rows };
});

// Attachments
function attachmentPerm(ctx, ename, id, action) {
  const e = entities[ename];
  if (!e) throw new HttpError(404, 'Unknown entity');
  crud.get(ctx, ename, id); // read permission + existence
  if (action === 'write') need(['admin', 'supervisor', 'technician'].includes(ctx.user.role) || (ename === 'service_requests'));
}
route('GET', '/api/files', (ctx) => {
  attachmentPerm(ctx, ctx.query.entity, Number(ctx.query.id), 'read');
  return { rows: db.prepare('SELECT id, filename, mime, size, uploaded_by, created_at FROM attachments WHERE entity = ? AND entity_id = ? ORDER BY id').all(ctx.query.entity, Number(ctx.query.id)) };
});
route('POST', '/api/files', async (ctx) => {
  const ename = ctx.query.entity; const id = Number(ctx.query.id);
  attachmentPerm(ctx, ename, id, 'write');
  const name = path.basename(String(ctx.query.name || 'file')).replace(/[^\w.\- ()]/g, '_').slice(0, 150) || 'file';
  const buf = await readBody(ctx.req, config.maxUploadMB * 1024 * 1024);
  if (!buf.length) throw new HttpError(400, 'Empty file');
  const stored = `${crypto.randomUUID()}${path.extname(name).toLowerCase().replace(/[^.\w]/g, '')}`;
  fs.writeFileSync(path.join(config.uploadDir, stored), buf);
  const mime = MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
  const r = db.prepare('INSERT INTO attachments (entity, entity_id, filename, stored_name, mime, size, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(ename, id, name, stored, mime, buf.length, ctx.user.username, new Date().toISOString());
  crud.audit(ctx, 'attach', ename, id, `Attached ${name} (${buf.length} bytes)`, { sha256: crypto.createHash('sha256').update(buf).digest('hex') });
  return { id: Number(r.lastInsertRowid) };
});
route('GET', '/api/files/:id', (ctx, p) => {
  const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(Number(p.id));
  if (!a) throw new HttpError(404, 'File not found');
  attachmentPerm(ctx, a.entity, a.entity_id, 'read');
  const inline = /^(image\/|application\/pdf|video\/|text\/plain)/.test(a.mime);
  return { __file: path.join(config.uploadDir, a.stored_name), type: a.mime, filename: a.filename, inline };
});
route('DELETE', '/api/files/:id', (ctx, p) => {
  const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(Number(p.id));
  if (!a) throw new HttpError(404, 'File not found');
  need(isManager(ctx.user) || a.uploaded_by === ctx.user.username);
  db.prepare('DELETE FROM attachments WHERE id = ?').run(a.id);
  fs.rmSync(path.join(config.uploadDir, a.stored_name), { force: true });
  crud.audit(ctx, 'detach', a.entity, a.entity_id, `Removed attachment ${a.filename}`);
  return { ok: true };
});

// Notifications
route('GET', '/api/notifications', ctx => ({
  rows: db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(ctx.user.id),
  unread: db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(ctx.user.id).n,
}));
route('POST', '/api/notifications/read', (ctx) => {
  db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(new Date().toISOString(), ctx.user.id);
  return { ok: true };
});

// Administration
const SETTING_KEYS = ['org_name', 'portal_enabled', 'portal_message', 'sla_emergency_hours', 'sla_urgent_hours', 'sla_high_hours', 'public_url', 'label_code', 'label_qr_content', 'label_size', 'device_lookup_online',
  'smtp_host', 'smtp_port', 'smtp_security', 'smtp_user', 'smtp_from', 'smtp_from_name', 'smtp_reply_to', 'smtp_allow_self_signed',
  'email_utl_subject', 'email_utl_body', 'email_pm_subject', 'email_pm_body', 'pm_progress_auto', 'pm_progress_day', 'password_reset_enabled', 'po_approval_limit'];
route('GET', '/api/settings', (ctx) => {
  need(ctx.user.role === 'admin');
  const s = {}; for (const k of SETTING_KEYS) s[k] = dbm.getSetting(db, k, '') || emailReports.DEFAULT_TEMPLATES[k] || '';
  s.smtp_pass_set = !!dbm.getSetting(db, 'smtp_pass', ''); // the password itself is never sent to the browser
  if (!s.password_reset_enabled) s.password_reset_enabled = '1';
  s.password_reset_status = passwordReset.unavailableReason(db) || 'available';
  return { settings: s, defaults: emailReports.DEFAULT_TEMPLATES, lookups: db.prepare('SELECT * FROM lookups ORDER BY list, sort, value').all(),
    server: { version: VERSION, node: process.version, dataDir: config.dataDir, port: config.port, https: config.https.enabled, backupDir: config.backup.dir } };
});
route('PUT', '/api/settings', async (ctx) => {
  need(ctx.user.role === 'admin');
  const b = await jsonBody(ctx.req);
  for (const k of SETTING_KEYS) if (k in b) dbm.setSetting(db, k, String(b[k] ?? '').slice(0, 5000));
  if (typeof b.smtp_pass === 'string' && b.smtp_pass !== '') dbm.setSetting(db, 'smtp_pass', b.smtp_pass);
  if (b.smtp_pass_clear) dbm.setSetting(db, 'smtp_pass', '');
  const logged = { ...b }; if ('smtp_pass' in logged) logged.smtp_pass = '(changed)';
  crud.audit(ctx, 'settings', null, null, 'Settings updated', logged);
  return { ok: true };
});
route('PUT', '/api/lookups/:list', async (ctx, p) => {
  need(ctx.user.role === 'admin');
  const b = await jsonBody(ctx.req);
  const values = [].concat(b.values || []).map(v => String(v).trim()).filter(Boolean);
  dbm.tx(db, () => {
    db.prepare('DELETE FROM lookups WHERE list = ?').run(p.list);
    const ins = db.prepare('INSERT INTO lookups (list, value, sort) VALUES (?,?,?)');
    values.forEach((v, i) => ins.run(p.list, v, i));
  });
  crud.audit(ctx, 'settings', null, null, `Lookup list ${p.list} updated`, { values });
  return { ok: true };
});
route('GET', '/api/backups', (ctx) => {
  need(ctx.user.role === 'admin');
  fs.mkdirSync(config.backup.dir, { recursive: true });
  return { dir: config.backup.dir, rows: fs.readdirSync(config.backup.dir).filter(f => f.endsWith('.db')).sort().reverse()
    .map(f => ({ name: f, size: fs.statSync(path.join(config.backup.dir, f)).size })) };
});
route('POST', '/api/backups', (ctx) => {
  need(ctx.user.role === 'admin');
  const f = dbm.backup(db, config.backup.dir, config.backup.keep);
  crud.audit(ctx, 'backup', null, null, `Manual backup ${path.basename(f)}`);
  return { file: path.basename(f) };
});
route('GET', '/api/backups/:name', (ctx, p) => {
  need(ctx.user.role === 'admin');
  const name = path.basename(decodeURIComponent(p.name));
  if (!/^libre-[\w-]+\.db$/.test(name)) throw new HttpError(400, 'Bad name');
  crud.audit(ctx, 'backup-download', null, null, `Downloaded backup ${name}`);
  return { __file: path.join(config.backup.dir, name), type: 'application/octet-stream', filename: name };
});

// ---------------- request handling ----------------
const PUBLIC_DIR = path.join(ROOT, 'public');

function serveStatic(req, res, pathname) {
  if (pathname === '/' || pathname === '') pathname = '/index.html';
  if (pathname === '/portal' || pathname === '/request') pathname = '/portal.html';
  const file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return send(res, 404, 'Not found', 'text/plain');
  }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const st = fs.statSync(file);
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); return res.end(); }
  // Always revalidate so upgrades take effect immediately; unchanged files return 304.
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', ETag: etag });
  fs.createReadStream(file).pipe(res);
}

async function handle(req, res) {
  securityHeaders(res);
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  if (!pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', 'text/plain');
    return serveStatic(req, res, pathname);
  }
  const ctx = { db, req, res, ip: clientIp(req), query: Object.fromEntries(url.searchParams) };
  try {
    let found = null; let params = {};
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = pathname.match(r.re);
      if (m) { found = r; r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); }); break; }
    }
    if (!found) throw new HttpError(404, 'Not found');
    // CSRF defence: state-changing API calls must carry a custom header,
    // which browsers will not send cross-site without a CORS preflight.
    if (req.method !== 'GET' && req.headers['x-libre'] !== '1') throw new HttpError(403, 'Missing request header');
    if (!found.opts.public) {
      ctx.token = auth.parseCookies(req.headers.cookie).libre_session;
      ctx.user = auth.sessionUser(db, ctx.token);
      if (!ctx.user) throw new HttpError(401, 'Please sign in');
      if (ctx.user.must_change_password && !found.opts.allowPasswordChange) throw new HttpError(428, 'You must change your password before continuing');
    }
    const result = await found.handler(ctx, params);
    const extra = ctx.setCookie ? { 'Set-Cookie': ctx.setCookie } : {};
    if (result && result.__raw !== undefined) {
      return send(res, 200, result.__raw, result.type, { ...extra, 'Content-Disposition': `attachment; filename="${result.filename}"` });
    }
    if (result && result.__file) {
      if (!fs.existsSync(result.__file)) throw new HttpError(404, 'File missing on server');
      res.writeHead(200, { 'Content-Type': result.type, 'Cache-Control': 'private, no-store',
        'Content-Disposition': `${result.inline ? 'inline' : 'attachment'}; filename="${result.filename.replace(/"/g, '')}"` });
      return fs.createReadStream(result.__file).pipe(res);
    }
    send(res, 200, result ?? { ok: true }, undefined, extra);
  } catch (err) {
    const status = err.status || (/UNIQUE constraint/.test(err.message) ? 409 : 500);
    if (status === 500) console.error(new Date().toISOString(), req.method, pathname, err);
    send(res, status, { error: status === 500 ? 'Internal server error. See server log.' : err.message });
  }
}

// ---------------- background jobs ----------------
function jobs() {
  const ctx = { db, user: null, ip: 'scheduler' };
  try {
    const created = logic.generatePMs(ctx);
    if (created.length) console.log(`[pm] generated ${created.length} PM work orders`);
    logic.runAlerts(ctx);
    emailReports.autoMonthly(db).then(r => { if (r) console.log(`[email] monthly PM progress: ${r.sent} sent, ${r.failed} failed`); }).catch(e => console.error('[email]', e.message));
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
    passwordReset.cleanup(db);
    if (config.backup.enabled && new Date().getHours() >= config.backup.hour) {
      const last = dbm.getSetting(db, 'last_auto_backup', '');
      const day = new Date().toISOString().slice(0, 10);
      if (last !== day) {
        const f = dbm.backup(db, config.backup.dir, config.backup.keep);
        dbm.setSetting(db, 'last_auto_backup', day);
        console.log(`[backup] ${f}`);
      }
    }
  } catch (e) { console.error('[jobs]', e); }
}

// ---------------- start ----------------
function start() {
  let server;
  if (config.https.enabled) {
    server = https.createServer({
      cert: fs.readFileSync(path.resolve(ROOT, config.https.certFile)),
      key: fs.readFileSync(path.resolve(ROOT, config.https.keyFile)),
    }, handle);
    if (config.https.redirectHttpPort) {
      http.createServer((req, res) => {
        const host = (req.headers.host || '').replace(/:\d+$/, '');
        res.writeHead(301, { Location: `https://${host}${config.port === 443 ? '' : ':' + config.port}${req.url}` });
        res.end();
      }).listen(config.https.redirectHttpPort, config.host);
    }
  } else {
    server = http.createServer(handle);
  }
  server.requestTimeout = 5 * 60e3;
  server.listen(config.port, config.host, () => {
    const proto = config.https.enabled ? 'https' : 'http';
    console.log(`Libre CMMS ${VERSION} - Copyright (C) 2026 CreativeMed LLC - AGPL-3.0`);
    console.log(`Listening on ${proto}://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
    console.log(`Data directory: ${config.dataDir}`);
    if (db.prepare('SELECT COUNT(*) n FROM users').get().n === 0) console.log('First run: open the address above in a browser to create the administrator account.');
  });
  setTimeout(jobs, 5000);
  setInterval(jobs, 60 * 60e3);
  const shutdown = () => { console.log('Shutting down...'); server.close(); try { db.close(); } catch {} process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) start();
module.exports = { handle, db, config, jobs };

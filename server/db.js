// Libre CMMS - Copyright (C) 2026 CreativeMed LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { entities, DEFAULT_LOOKUPS } = require('./schema');

const SQL_TYPE = { int: 'INTEGER', bool: 'INTEGER', ref: 'INTEGER', number: 'REAL', money: 'REAL' };
const sqlType = f => SQL_TYPE[f.type] || 'TEXT';

// Tables that are not exposed through the generic entity API.
const SYSTEM_TABLES = `
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL, ip TEXT, user_agent TEXT);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, user_id INTEGER, user_name TEXT,
  action TEXT NOT NULL, entity TEXT, entity_id INTEGER, summary TEXT, changes TEXT, ip TEXT);
CREATE INDEX IF NOT EXISTS ix_audit_entity ON audit_log(entity, entity_id);
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL, entity_id INTEGER NOT NULL,
  filename TEXT NOT NULL, stored_name TEXT NOT NULL, mime TEXT, size INTEGER,
  uploaded_by TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_attach_entity ON attachments(entity, entity_id);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS lookups (
  id INTEGER PRIMARY KEY AUTOINCREMENT, list TEXT NOT NULL, value TEXT NOT NULL, sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, message TEXT NOT NULL,
  link TEXT, created_at TEXT NOT NULL, read_at TEXT, dedupe_key TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS ux_notif_dedupe ON notifications(user_id, dedupe_key);
CREATE TABLE IF NOT EXISTS test_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, step_id INTEGER, seq INTEGER,
  step_type TEXT, prompt TEXT, unit TEXT, nominal REAL, lower_limit REAL, upper_limit REAL,
  required INTEGER, only_if_step INTEGER,
  as_found TEXT, value TEXT, error_pct REAL, result TEXT, note TEXT, recorded_at TEXT, recorded_by TEXT);
CREATE INDEX IF NOT EXISTS ix_results_run ON test_results(run_id);
`;

// Extra columns on entity tables that are never edited through forms.
const EXTRA_COLUMNS = {
  users: [['password_hash', 'TEXT'], ['must_change_password', 'INTEGER DEFAULT 0'], ['last_login', 'TEXT'], ['failed_logins', 'INTEGER DEFAULT 0'], ['locked_until', 'TEXT']],
  test_runs: [['procedure_snapshot', 'TEXT']],
  service_requests: [['public_token', 'TEXT']],
  inventory_scans: [['flags_json', 'TEXT']],
};

const INDEXES = [
  'CREATE INDEX IF NOT EXISTS ix_assets_model ON assets(model_id)',
  'CREATE INDEX IF NOT EXISTS ix_assets_dept ON assets(department_id)',
  'CREATE INDEX IF NOT EXISTS ix_wo_asset ON work_orders(asset_id)',
  'CREATE INDEX IF NOT EXISTS ix_wo_status ON work_orders(status)',
  'CREATE INDEX IF NOT EXISTS ix_wo_pm ON work_orders(pm_schedule_id)',
  'CREATE INDEX IF NOT EXISTS ix_pm_asset ON pm_schedules(asset_id)',
  'CREATE INDEX IF NOT EXISTS ix_steps_proc ON procedure_steps(procedure_id)',
  'CREATE INDEX IF NOT EXISTS ix_labor_wo ON wo_labor(work_order_id)',
  'CREATE INDEX IF NOT EXISTS ix_parts_wo ON wo_parts(work_order_id)',
  'CREATE INDEX IF NOT EXISTS ix_wo_team ON work_orders(team_id)',
  'CREATE INDEX IF NOT EXISTS ix_wo_assigned ON work_orders(assigned_to)',
  'CREATE UNIQUE INDEX IF NOT EXISTS ux_team_member ON team_members(team_id, user_id)',
  'CREATE INDEX IF NOT EXISTS ix_assets_curdept ON assets(current_department_id)',
  'CREATE INDEX IF NOT EXISTS ix_assets_tag_nocase ON assets(asset_tag COLLATE NOCASE)',
  'CREATE INDEX IF NOT EXISTS ix_utl_asset ON utl_events(asset_id, status)',
  'CREATE INDEX IF NOT EXISTS ix_scans_inv ON inventory_scans(inventory_id)',
];

function open(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'libre.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

// Creates any missing tables / columns. Safe to run on every start, so
// upgrading Libre is: replace the program files, restart.
function migrate(db) {
  db.exec(SYSTEM_TABLES);
  const AUDIT_COLS = ['created_at', 'updated_at', 'created_by', 'updated_by'];
  for (const e of Object.values(entities)) {
    const cols = e.columns.filter(f => !AUDIT_COLS.includes(f.name)).map(f => `"${f.name}" ${sqlType(f)}`);
    db.exec(`CREATE TABLE IF NOT EXISTS "${e.name}" (id INTEGER PRIMARY KEY AUTOINCREMENT,
      ${cols.join(', ')}, created_at TEXT, updated_at TEXT, created_by TEXT, updated_by TEXT)`);
    const existing = new Set(db.prepare(`PRAGMA table_info("${e.name}")`).all().map(r => r.name));
    const wanted = [...e.columns.map(f => [f.name, sqlType(f)]), ...(EXTRA_COLUMNS[e.name] || []),
      ['created_at', 'TEXT'], ['updated_at', 'TEXT'], ['created_by', 'TEXT'], ['updated_by', 'TEXT']];
    for (const [name, type] of wanted) {
      if (!existing.has(name)) db.exec(`ALTER TABLE "${e.name}" ADD COLUMN "${name}" ${type}`);
    }
    for (const f of e.columns.filter(f => f.unique)) {
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS "ux_${e.name}_${f.name}" ON "${e.name}"("${f.name}") WHERE "${f.name}" IS NOT NULL AND "${f.name}" <> ''`);
    }
  }
  for (const sql of INDEXES) db.exec(sql);

  const count = db.prepare('SELECT COUNT(*) AS n FROM lookups').get().n;
  if (!count) {
    const ins = db.prepare('INSERT INTO lookups (list, value, sort) VALUES (?, ?, ?)');
    for (const [list, values] of Object.entries(DEFAULT_LOOKUPS)) values.forEach((v, i) => ins.run(list, v, i));
  }
  const ver = db.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get();
  if (!ver) db.prepare("INSERT INTO settings (key, value) VALUES ('schema_version', '1')").run();
}

// Transactions nest via savepoints, so business functions can call each other freely.
const depth = new WeakMap();
function tx(db, fn) {
  const d = depth.get(db) || 0;
  const sp = `sp${d}`;
  db.exec(d === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
  depth.set(db, d + 1);
  try {
    const r = fn();
    depth.set(db, d);
    db.exec(d === 0 ? 'COMMIT' : `RELEASE ${sp}`);
    return r;
  } catch (e) {
    depth.set(db, d);
    db.exec(d === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw e;
  }
}

// Sequential document numbers, e.g. WO-2026-000123.
function nextNumber(db, spec) {
  const year = new Date().getFullYear();
  const key = spec.yearly ? `${spec.prefix}-${year}` : spec.prefix;
  db.prepare('INSERT INTO counters (name, value) VALUES (?, 0) ON CONFLICT(name) DO NOTHING').run(key);
  db.prepare('UPDATE counters SET value = value + 1 WHERE name = ?').run(key);
  const n = db.prepare('SELECT value FROM counters WHERE name = ?').get(key).value;
  return `${key}-${String(n).padStart(spec.pad || 5, '0')}`;
}

function getSetting(db, key, def = null) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : def;
}
function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

function backup(db, dir, keep = 14) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(dir, `libre-${stamp}.db`);
  db.prepare('VACUUM INTO ?').run(file);
  const files = fs.readdirSync(dir).filter(f => /^libre-.*\.db$/.test(f)).sort();
  while (files.length > keep) fs.rmSync(path.join(dir, files.shift()));
  return file;
}

module.exports = { open, tx, nextNumber, getSetting, setSetting, backup };

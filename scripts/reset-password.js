#!/usr/bin/env node
// Libre CMMS - Copyright (C) 2026 CreativeMed LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
// Emergency password reset, run on the server while Libre is stopped:
//   node scripts/reset-password.js <username> <new-password>
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const dbm = require('../server/db');
const auth = require('../server/lib/auth');

const [username, password] = process.argv.slice(2);
if (!username || !password) { console.error('Usage: node scripts/reset-password.js <username> <new-password>'); process.exit(1); }
const problem = auth.passwordProblem(password);
if (problem) { console.error(problem); process.exit(1); }
const root = path.resolve(__dirname, '..');
const cfgFile = process.env.LIBRE_CONFIG || path.join(root, 'config', 'libre.config.json');
const cfg = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {};
const db = dbm.open(path.resolve(root, process.env.LIBRE_DATA_DIR || cfg.dataDir || 'data'));
const u = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username);
if (!u) { console.error(`No user named ${username}`); process.exit(1); }
db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1, failed_logins = 0, locked_until = NULL, active = 1 WHERE id = ?').run(auth.hashPassword(password), u.id);
db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
db.prepare("INSERT INTO audit_log (ts, user_name, action, entity, entity_id, summary) VALUES (?, 'console', 'password-reset', 'users', ?, 'Password reset from server console')").run(new Date().toISOString(), u.id);
console.log(`Password for ${username} reset. They must change it at next sign-in.`);
db.close();

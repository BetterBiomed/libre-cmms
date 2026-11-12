// Libre CMMS - Copyright (C) 2026 CreativeMed LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
const crypto = require('node:crypto');

const SCRYPT = { N: 16384, r: 8, p: 1 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, saltHex, hashHex] = stored.split('$');
  const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64, SCRYPT);
  const expected = Buffer.from(hashHex, 'hex');
  return expected.length === hash.length && crypto.timingSafeEqual(expected, hash);
}

function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters.';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password must contain letters and numbers.';
  return null;
}

function createSession(db, userId, hours, ip, ua) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const exp = new Date(now.getTime() + hours * 3600e3);
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at, ip, user_agent) VALUES (?,?,?,?,?,?)')
    .run(token, userId, now.toISOString(), exp.toISOString(), ip, (ua || '').slice(0, 200));
  return token;
}

function sessionUser(db, token) {
  if (!token) return null;
  const row = db.prepare(`SELECT u.id, u.username, u.full_name, u.role, u.email, u.active, u.must_change_password, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`).get(token);
  if (!row) return null;
  if (row.expires_at < new Date().toISOString() || !row.active) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return row;
}

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function can(user, entity, action) {
  if (!user) return false;
  const roles = entity.perms[action] || [];
  return roles.includes(user.role);
}

module.exports = { hashPassword, verifyPassword, passwordProblem, createSession, sessionUser, parseCookies, can };

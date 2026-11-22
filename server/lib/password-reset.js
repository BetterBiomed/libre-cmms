// Libre CMMS - Copyright (C) 2026 CreativeMed LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// Self-service "Forgot password": a one-time, time-limited link emailed to the
// address on the user's account. Only a SHA-256 hash of the link's token is stored.
const crypto = require('node:crypto');
const auth = require('./auth');
const crud = require('./crud');
const mailer = require('./mailer');
const { getSetting } = require('../db');
const { HttpError } = crud;

const TOKEN_MINUTES = 60;
const PER_USER_PER_HOUR = 3;
const GENERIC = 'If that account exists and has an email address, a password reset link has been sent to it. The link works once and expires in 60 minutes.';

const sha256 = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const publicUrl = db => String(getSetting(db, 'public_url', '') || '').trim().replace(/\/+$/, '');

// Why self-service reset is unavailable (null when it is available).
function unavailableReason(db) {
  if (getSetting(db, 'password_reset_enabled', '1') === '0') return 'disabled';
  if (!mailer.configured(db)) return 'email';
  if (!/^https?:\/\//i.test(publicUrl(db))) return 'public_url';
  return null;
}
const available = db => !unavailableReason(db);

// Background sends, so the response time does not reveal whether an account exists.
// Tests await `pending` to see the result.
let pending = Promise.resolve();

function request(ctx, body = {}) {
  const db = ctx.db;
  if (!available(db)) throw new HttpError(503, 'Password reset by email is not available. Please contact your Libre administrator.');
  const id = String(body.identifier || '').trim();
  if (!id || id.length > 200) throw new HttpError(400, 'Enter your username or email address.');
  const users = id.includes('@')
    ? db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE AND active = 1').all(id)
    : db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE AND active = 1').all(id);
  const now = new Date();
  const jobs = [];
  for (const u of users) {
    if (!mailer.validEmail(u.email)) continue;
    const recent = db.prepare('SELECT COUNT(*) n FROM password_resets WHERE user_id = ? AND created_at > ?').get(u.id, new Date(now - 3600e3).toISOString()).n;
    if (recent >= PER_USER_PER_HOUR) { crud.audit({ db, user: { id: u.id, username: u.username }, ip: ctx.ip }, 'password-reset-request', 'users', u.id, 'Reset request ignored (too many in the last hour)'); continue; }
    const token = crypto.randomBytes(32).toString('base64url');
    // A new link replaces any earlier unused link for this account.
    db.prepare('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(now.toISOString(), u.id);
    db.prepare('INSERT INTO password_resets (token_hash, user_id, created_at, expires_at, ip) VALUES (?,?,?,?,?)')
      .run(sha256(token), u.id, now.toISOString(), new Date(+now + TOKEN_MINUTES * 60e3).toISOString(), ctx.ip || null);
    crud.audit({ db, user: { id: u.id, username: u.username }, ip: ctx.ip }, 'password-reset-request', 'users', u.id, 'Password reset link emailed');
    jobs.push(sendLink(db, u, `${publicUrl(db)}/#/reset-password?token=${token}`, ctx.ip));
  }
  pending = Promise.allSettled(jobs);
  return { ok: true, message: GENERIC };
}

function sendLink(db, u, link, ip) {
  const org = getSetting(db, 'org_name', 'Libre CMMS');
  const text = [`Hello ${u.full_name},`, '',
    `Someone (hopefully you) asked to reset the password for your ${org} Libre CMMS account (user name: ${u.username}).`, '',
    `To choose a new password, open this link within ${TOKEN_MINUTES} minutes. It can be used once:`, link, '',
    'If you did not ask for this, you can ignore this email; your password has not changed.', '',
    `Request made from IP address ${ip || 'unknown'}.`].join('\n');
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1d2733"><p>Hello ${esc(u.full_name)},</p>
<p>Someone (hopefully you) asked to reset the password for your ${esc(org)} Libre CMMS account (user name: <strong>${esc(u.username)}</strong>).</p>
<p><a href="${esc(link)}" style="display:inline-block;background:#0f5e6e;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Choose a new password</a></p>
<p style="font-size:12px;color:#66727f">The link works once and expires in ${TOKEN_MINUTES} minutes. If the button does not work, copy this address into your browser:<br>${esc(link)}</p>
<p>If you did not ask for this, ignore this email; your password has not changed.</p><p style="font-size:12px;color:#66727f">Request made from IP address ${esc(ip || 'unknown')}.</p></div>`;
  return mailer.send(db, { to: [u.email], subject: `${org}: reset your Libre password`, text, html }, { kind: 'Password reset', related: `User ${u.username}`, sent_by: 'system' })
    .catch(() => {}); // logged as Failed in the email log
}

function findToken(db, token) {
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  const r = db.prepare(`SELECT r.*, u.username, u.full_name, u.email, u.active FROM password_resets r JOIN users u ON u.id = r.user_id WHERE r.token_hash = ?`).get(sha256(token));
  if (!r || r.used_at || !r.active || r.expires_at < new Date().toISOString()) return null;
  return r;
}
const INVALID = 'This password reset link is invalid, has already been used, or has expired. Please request a new one.';

function check(ctx, body = {}) {
  const r = findToken(ctx.db, body.token);
  if (!r) throw new HttpError(400, INVALID);
  return { ok: true, username: r.username, full_name: r.full_name, expires_at: r.expires_at };
}

function reset(ctx, body = {}) {
  const db = ctx.db;
  const r = findToken(db, body.token);
  if (!r) throw new HttpError(400, INVALID);
  const problem = auth.passwordProblem(body.password);
  if (problem) throw new HttpError(400, problem);
  const now = new Date().toISOString();
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, failed_logins = 0, locked_until = NULL WHERE id = ?').run(auth.hashPassword(body.password), r.user_id);
  db.prepare('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(now, r.user_id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(r.user_id); // sign out everywhere
  crud.audit({ db, user: { id: r.user_id, username: r.username }, ip: ctx.ip }, 'password-reset', 'users', r.user_id, 'Password reset with emailed link');
  const org = getSetting(db, 'org_name', 'Libre CMMS');
  pending = mailer.send(db, { to: [r.email], subject: `${org}: your Libre password was changed`,
    text: [`Hello ${r.full_name},`, '', `The password for your ${org} Libre CMMS account (user name: ${r.username}) was just changed using a password reset link, and you were signed out on all devices.`, '',
      `If you did not do this, contact your Libre administrator or Clinical Engineering right away.`, '', `Changed from IP address ${ctx.ip || 'unknown'} at ${now}.`].join('\n') },
  { kind: 'Password changed', related: `User ${r.username}`, sent_by: 'system' }).catch(() => {});
  return { ok: true, username: r.username };
}

// Remove old links (called by the hourly job).
function cleanup(db) {
  db.prepare('DELETE FROM password_resets WHERE created_at < ?').run(new Date(Date.now() - 30 * 86400e3).toISOString());
}

module.exports = { request, check, reset, cleanup, available, unavailableReason, get pending() { return pending; }, TOKEN_MINUTES };

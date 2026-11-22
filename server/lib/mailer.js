// Libre CMMS - Copyright (C) 2026 CreativeMed LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// Dependency-free SMTP client (SSL/TLS, STARTTLS or plain; AUTH PLAIN/LOGIN) and
// MIME message builder with HTML/text bodies and attachments.
// Settings (Settings -> Email): smtp_host, smtp_port, smtp_security (ssl|starttls|none),
// smtp_user, smtp_pass, smtp_from, smtp_from_name, smtp_reply_to.
const net = require('node:net');
const tls = require('node:tls');
const os = require('node:os');
const crypto = require('node:crypto');
const { getSetting } = require('../db');

class MailError extends Error {}

function config(db) {
  const g = (k, d = '') => getSetting(db, k, d) || d;
  return {
    host: g('smtp_host'), port: Number(g('smtp_port')) || 0, security: g('smtp_security', 'starttls'),
    user: g('smtp_user'), pass: g('smtp_pass'), from: g('smtp_from'), fromName: g('smtp_from_name', getSetting(db, 'org_name', 'Libre CMMS')),
    replyTo: g('smtp_reply_to'), allowSelfSigned: g('smtp_allow_self_signed') === '1',
  };
}
const configured = db => { const c = config(db); return !!(c.host && c.from); };

const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
const validEmail = e => EMAIL_RE.test(String(e || '').trim());
// "a@x.org, b@y.org; c@z.org" -> ['a@x.org', 'b@y.org', 'c@z.org']
function parseList(v) {
  const arr = Array.isArray(v) ? v : String(v || '').split(/[,;\s]+/);
  return [...new Set(arr.map(s => String(s).trim()).filter(Boolean))];
}

// RFC 2047 encoded-word for non-ASCII header text.
const encWord = s => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
const b64lines = buf => Buffer.from(buf).toString('base64').replace(/.{1,76}/g, '$&\r\n');
const addr = (email, name) => (name ? `${encWord(String(name).replace(/["\\]/g, ''))} <${email}>` : `<${email}>`);

function buildMessage({ from, fromName, to, cc = [], replyTo, subject, text, html, attachments = [] }) {
  const mixed = `mixed_${crypto.randomBytes(12).toString('hex')}`;
  const alt = `alt_${crypto.randomBytes(12).toString('hex')}`;
  const domain = String(from).split('@')[1] || 'libre.local';
  const headers = [
    `From: ${addr(from, fromName)}`,
    `To: ${to.map(e => `<${e}>`).join(', ')}`,
    cc.length ? `Cc: ${cc.map(e => `<${e}>`).join(', ')}` : null,
    replyTo ? `Reply-To: <${replyTo}>` : null,
    `Subject: ${encWord(subject)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    'X-Mailer: Libre CMMS',
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
  ].filter(Boolean);
  const parts = [
    `--${mixed}`, `Content-Type: multipart/alternative; boundary="${alt}"`, '',
    `--${alt}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64lines(text || ''),
    `--${alt}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64lines(html || `<pre>${text || ''}</pre>`),
    `--${alt}--`, '',
  ];
  for (const a of attachments) {
    const name = String(a.filename).replace(/["\r\n]/g, '');
    parts.push(`--${mixed}`, `Content-Type: ${a.contentType || 'application/octet-stream'}; name="${name}"`, 'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${name}"`, '', b64lines(a.content));
  }
  parts.push(`--${mixed}--`, '');
  return `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}`;
}

// Minimal SMTP conversation.
function smtpSend(c, envelope, data) {
  return new Promise((resolve, reject) => {
    const timeoutMs = 30000;
    let sock; let buf = ''; let waiter = null; let done = false;
    const fail = e => { if (done) return; done = true; try { sock?.destroy(); } catch { } reject(e instanceof MailError ? e : new MailError(e.message || String(e))); };
    const onData = d => {
      buf += d.toString('utf8');
      // A reply is complete when a line "NNN " (space after code) arrives.
      const lines = buf.split('\r\n');
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i])) {
          const reply = lines.slice(0, i + 1);
          buf = lines.slice(i + 1).join('\r\n');
          const w = waiter; waiter = null;
          if (w) w({ code: Number(lines[i].slice(0, 3)), text: reply.join('\n'), lines: reply });
          return;
        }
      }
    };
    const wire = s => { s.setTimeout(timeoutMs, () => fail(new MailError('Mail server timed out'))); s.on('data', onData); s.on('error', fail); };
    const read = () => new Promise(r => { waiter = r; });
    const cmd = async (line, expect) => {
      if (line != null) sock.write(line + '\r\n');
      const r = await read();
      if (expect && !expect.includes(r.code)) throw new MailError(`Mail server rejected ${line ? line.split(' ')[0] : 'connection'}: ${r.text.replace(/\n/g, ' ')}`);
      return r;
    };
    const tlsOpts = { servername: c.host, rejectUnauthorized: !c.allowSelfSigned };
    (async () => {
      sock = c.security === 'ssl' ? tls.connect({ host: c.host, port: c.port || 465, ...tlsOpts }) : net.connect({ host: c.host, port: c.port || (c.security === 'none' ? 25 : 587) });
      sock.once('error', fail);
      wire(sock);
      await cmd(null, [220]);
      const helo = os.hostname().replace(/[^A-Za-z0-9.-]/g, '') || 'libre';
      let ehlo = await cmd(`EHLO ${helo}`, [250]);
      if (c.security === 'starttls') {
        if (!/STARTTLS/i.test(ehlo.text)) throw new MailError('Mail server does not offer STARTTLS. Choose SSL/TLS or None in Settings.');
        await cmd('STARTTLS', [220]);
        sock.removeListener('data', onData);
        sock = await new Promise((res, rej) => { const t = tls.connect({ socket: sock, ...tlsOpts }, () => res(t)); t.once('error', rej); });
        wire(sock);
        ehlo = await cmd(`EHLO ${helo}`, [250]);
      }
      if (c.user) {
        if (/AUTH[^\n]*PLAIN/i.test(ehlo.text)) {
          await cmd(`AUTH PLAIN ${Buffer.from(`\0${c.user}\0${c.pass}`).toString('base64')}`, [235]);
        } else {
          await cmd('AUTH LOGIN', [334]);
          await cmd(Buffer.from(c.user).toString('base64'), [334]);
          await cmd(Buffer.from(c.pass).toString('base64'), [235]);
        }
      }
      await cmd(`MAIL FROM:<${envelope.from}>`, [250]);
      for (const r of envelope.to) await cmd(`RCPT TO:<${r}>`, [250, 251]);
      await cmd('DATA', [354]);
      // Dot-stuffing: lines starting with "." get an extra ".".
      sock.write(data.replace(/\r\n\./g, '\r\n..') + '\r\n.\r\n');
      const r = await cmd(null, [250]);
      try { sock.write('QUIT\r\n'); } catch { }
      done = true; sock.end();
      resolve({ response: r.text });
    })().catch(fail);
  });
}

function log(db, row) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO email_log (sent_at, to_addresses, cc_addresses, subject, status, error, kind, related, attachments, sent_by, created_at, updated_at, created_by, updated_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(now, row.to, row.cc || null, row.subject, row.status, row.error || null, row.kind || null, row.related || null,
    row.attachments || null, row.sent_by || 'system', now, now, row.sent_by || 'system', row.sent_by || 'system');
}

// Send one email. Throws MailError on failure; every attempt is logged.
async function send(db, msg, meta = {}) {
  const c = config(db);
  if (!c.host || !c.from) throw new MailError('Email is not set up. An administrator can configure it under Settings -> Email.');
  const to = parseList(msg.to); const cc = parseList(msg.cc);
  const bad = [...to, ...cc].filter(e => !validEmail(e));
  if (!to.length) throw new MailError('No recipient email address.');
  if (bad.length) throw new MailError(`Invalid email address: ${bad.join(', ')}`);
  const data = buildMessage({ from: c.from, fromName: c.fromName, replyTo: msg.replyTo || c.replyTo || undefined, to, cc, subject: msg.subject, text: msg.text, html: msg.html, attachments: msg.attachments || [] });
  const base = { to: to.join(', '), cc: cc.join(', '), subject: msg.subject, kind: meta.kind, related: meta.related, attachments: (msg.attachments || []).map(a => a.filename).join(', '), sent_by: meta.sent_by };
  try {
    await smtpSend(c, { from: c.from, to: [...to, ...cc] }, data);
    log(db, { ...base, status: 'Sent' });
    return { ok: true, to, cc };
  } catch (e) {
    log(db, { ...base, status: 'Failed', error: e.message });
    throw e instanceof MailError ? e : new MailError(e.message);
  }
}

module.exports = { send, config, configured, buildMessage, validEmail, parseList, MailError };

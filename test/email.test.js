// Libre CMMS - Copyright (C) 2026 CreativeMed LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// Email: SMTP client against a fake mail server, Unable To Locate reports to
// department managers, PM progress reports, PDF attachments and required emails.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-mail-'));
process.env.LIBRE_DATA_DIR = dir;
process.env.LIBRE_CONFIG = path.join(dir, 'none.json');
const { handle, db } = require('../server/server');
const pdf = require('../server/lib/pdf');

// ---- fake SMTP server ----
const inbox = [];
let rejectRcpt = null;
const smtp = net.createServer(sock => {
  let state = 'cmd'; let data = ''; let cur = { to: [], auth: null };
  sock.write('220 fake.smtp ready\r\n');
  let buf = '';
  sock.on('data', d => {
    buf += d.toString('latin1');
    if (state === 'data') {
      const end = buf.indexOf('\r\n.\r\n');
      if (end < 0) return;
      data = buf.slice(0, end); buf = buf.slice(end + 5);
      inbox.push({ ...cur, data: data.replace(/\r\n\.\./g, '\r\n.') });
      cur = { to: [], auth: cur.auth }; state = 'cmd';
      sock.write('250 queued\r\n');
    }
    let i;
    while (state === 'cmd' && (i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (/^EHLO/i.test(line)) sock.write('250-fake.smtp\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n');
      else if (/^AUTH PLAIN /i.test(line)) { cur.auth = Buffer.from(line.slice(11), 'base64').toString(); sock.write('235 ok\r\n'); }
      else if (/^MAIL FROM:/i.test(line)) { cur.from = line.slice(10); sock.write('250 ok\r\n'); }
      else if (/^RCPT TO:/i.test(line)) {
        const r = line.slice(8).replace(/[<>]/g, '');
        if (rejectRcpt && r === rejectRcpt) sock.write('550 no such user\r\n'); else { cur.to.push(r); sock.write('250 ok\r\n'); }
      } else if (/^DATA/i.test(line)) { state = 'data'; sock.write('354 go\r\n'); if (buf.includes('\r\n.\r\n')) sock.emit('data', Buffer.alloc(0)); }
      else if (/^QUIT/i.test(line)) { sock.end('221 bye\r\n'); }
      else sock.write('500 ?\r\n');
    }
  });
});

let base; let cookie = '';
async function api(method, url, body) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Libre': '1', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const buf = Buffer.from(await res.arrayBuffer());
  let data; try { data = JSON.parse(buf.toString()); } catch { data = buf; }
  return { status: res.status, data, type: res.headers.get('content-type') };
}
// Extract a MIME part body (base64) by content type.
function part(msg, type) {
  const re = new RegExp(`Content-Type: ${type.replace('/', '\\/')}[^\\r]*\\r\\n(?:[^\\r]+\\r\\n)*\\r\\n([A-Za-z0-9+/=\\r\\n]+)`);
  const m = msg.match(re);
  return m ? Buffer.from(m[1].replace(/\r\n/g, ''), 'base64') : null;
}
const subjectOf = m => { const s = m.data.match(/^Subject: (.*)$/m)[1]; const e = s.match(/^=\?UTF-8\?B\?(.*)\?=$/); return e ? Buffer.from(e[1], 'base64').toString() : s; };

test('Email', async (t) => {
  await new Promise(r => smtp.listen(0, '127.0.0.1', r));
  const server = http.createServer(handle);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.close(); smtp.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  await t.test('emails are required for admin, users and service requests', async () => {
    assert.equal((await api('POST', '/api/setup', { username: 'admin', full_name: 'Admin User', password: 'Password123', sample_data: true })).status, 400);
    assert.equal((await api('POST', '/api/setup', { username: 'admin', full_name: 'Admin User', password: 'Password123', sample_data: true, email: 'ce.manager@example.org' })).status, 200);
    await api('POST', '/api/auth/login', { username: 'admin', password: 'Password123' });
    const u = await api('POST', '/api/e/users', { username: 'noemail', full_name: 'No Email', role: 'technician' });
    assert.equal(u.status, 400);
    assert.match(u.data.error, /Email is required/);
    const saved = cookie; cookie = '';
    const sr = await api('POST', '/api/public/requests', { requester_name: 'Nurse', problem: 'Broken', asset_text: 'RGH-00001' });
    assert.equal(sr.status, 400);
    assert.match(sr.data.error, /email/i);
    assert.equal((await api('POST', '/api/public/requests', { requester_name: 'Nurse', requester_email: 'nurse@example.org', problem: 'Broken', asset_text: 'RGH-00001' })).status, 200);
    cookie = saved;
  });

  await t.test('SMTP settings: password never returned; test email delivered', async () => {
    assert.equal((await api('POST', '/api/email/test', {})).status, 502, 'not configured yet');
    const port = smtp.address().port;
    assert.equal((await api('PUT', '/api/settings', { smtp_host: '127.0.0.1', smtp_port: String(port), smtp_security: 'none', smtp_user: 'libre', smtp_pass: 's3cret!', smtp_from: 'biomed@example.org', smtp_from_name: 'Clinical Engineering' })).status, 200);
    const s = await api('GET', '/api/settings');
    assert.equal(s.data.settings.smtp_pass_set, true);
    assert.ok(!JSON.stringify(s.data).includes('s3cret!'), 'password not exposed');
    assert.match(s.data.settings.email_utl_body, /Clinical Engineering is unable to find the assets in the attached report/);
    const r = await api('POST', '/api/email/test', { to: 'someone@example.org' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(inbox.length, 1);
    assert.deepEqual(inbox[0].to, ['someone@example.org']);
    assert.equal(inbox[0].auth, '\0libre\0s3cret!');
    assert.match(inbox[0].data, /From: "?Clinical Engineering"? <biomed@example.org>/);
  });

  await t.test('Unable To Locate: grouped by department and sent to each manager with a PDF', async () => {
    const icu = db.prepare("SELECT id FROM departments WHERE name = 'ICU'").get().id;
    const ed = db.prepare("SELECT id FROM departments WHERE name = 'Emergency'").get().id;
    const icuAssets = db.prepare('SELECT id, asset_tag FROM assets WHERE department_id = ? ORDER BY id LIMIT 3').all(icu);
    const edAsset = db.prepare('SELECT id, asset_tag FROM assets WHERE department_id = ? ORDER BY id LIMIT 1').get(ed);
    for (const a of [...icuAssets, edAsset]) assert.equal((await api('POST', `/api/assets/${a.id}/utl`, { notes: 'Searched unit and storage' })).status, 200);
    // ICU manager is a CMMS user (their account email is used); ED has no manager yet.
    const mgr = (await api('POST', '/api/e/users', { username: 'icu.mgr', full_name: 'Pat Icu', role: 'viewer', email: 'pat.icu@example.org' })).data.row;
    await api('PUT', `/api/e/departments/${icu}`, { manager_user_id: mgr.id, manager_email: 'ignored@example.org' });
    const ids = db.prepare("SELECT id FROM utl_events WHERE status = 'Open'").all().map(r => r.id);
    const prev = await api('POST', '/api/utl/email/preview', { utl_ids: ids });
    assert.equal(prev.status, 200, JSON.stringify(prev.data));
    const g = Object.fromEntries(prev.data.groups.map(x => [x.department, x]));
    assert.equal(g.ICU.count, 3);
    assert.equal(g.ICU.to, 'pat.icu@example.org');
    assert.equal(g.ICU.manager.source, 'CMMS user');
    assert.match(g.ICU.subject, /3 medical device\(s\) assigned to ICU/);
    assert.match(g.ICU.body, /^Hello Pat Icu,/);
    assert.equal(g.Emergency.to, '', 'no manager email yet');

    const before = inbox.length;
    const groups = prev.data.groups.map(x => ({ ...x, to: x.to || 'ed.manager@example.org', save_as_manager: true }));
    const sent = await api('POST', '/api/utl/email', { groups, attach_csv: true, cc_me: true });
    assert.equal(sent.status, 200, JSON.stringify(sent.data));
    assert.equal(sent.data.sent, 2);
    const msgs = inbox.slice(before);
    const icuMsg = msgs.find(m => m.to.includes('pat.icu@example.org'));
    assert.ok(icuMsg.to.includes('ce.manager@example.org'), 'cc me');
    assert.match(subjectOf(icuMsg), /ICU/);
    const textBody = part(icuMsg.data, 'text/plain').toString();
    assert.match(textBody, /Clinical Engineering is unable to find the assets in the attached report and are unable to provide necessary routine maintenance to ensure patient safety\./);
    assert.match(textBody, /tracked by hospital administration/);
    const pdfBuf = part(icuMsg.data, 'application/pdf');
    assert.ok(pdfBuf && pdfBuf.subarray(0, 5).toString() === '%PDF-', 'PDF attached');
    for (const a of icuAssets) assert.ok(pdfBuf.toString('latin1').includes(a.asset_tag), `${a.asset_tag} in PDF`);
    assert.match(icuMsg.data, /filename="Unable-To-Locate-ICU-\d{4}-\d{2}-\d{2}\.pdf"/);
    assert.ok(part(icuMsg.data, 'text/csv').toString().includes('Asset Tag'), 'CSV attached');
    assert.equal(db.prepare('SELECT manager_email FROM departments WHERE id = ?').get(ed).manager_email, 'ed.manager@example.org', 'typed address saved as manager email');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM utl_events WHERE manager_notified_at IS NOT NULL').get().n, 4);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM email_log WHERE kind = 'Unable To Locate' AND status = 'Sent'").get().n, 2);

    // Failures are reported per department and logged.
    rejectRcpt = 'pat.icu@example.org';
    const f = await api('POST', '/api/utl/email', { groups: [groups.find(x => x.department === 'ICU')] });
    rejectRcpt = null;
    assert.equal(f.data.failed, 1);
    assert.match(f.data.results[0].error, /rejected RCPT/);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM email_log WHERE status = 'Failed'").get().n, 1);
    const dl = await api('GET', `/api/utl/report.pdf?utl_ids=${ids.join(',')}`);
    assert.equal(dl.type, 'application/pdf');
  });

  await t.test('PM progress to a technician and a team', async () => {
    const tech = db.prepare("SELECT id, email FROM users WHERE username = 'mtorres'").get();
    const team = db.prepare("SELECT id FROM teams WHERE name = 'Infusion & Monitoring'").get();
    const ym = new Date().toISOString().slice(0, 7);
    const data = await api('GET', `/api/pm/progress?month=${ym}&user_id=${tech.id}`);
    assert.equal(data.status, 200, JSON.stringify(data.data));
    assert.ok(data.data.due >= 0 && data.data.open.length >= 1, JSON.stringify(data.data));
    const before = inbox.length;
    const r = await api('POST', '/api/pm/progress/email', { month: ym, technician_ids: [tech.id], team_ids: [team.id] });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.sent, 2);
    const msgs = inbox.slice(before);
    assert.deepEqual(msgs[0].to, [tech.email]);
    assert.match(subjectOf(msgs[0]), /^PM progress for /);
    assert.ok(msgs[1].to.length >= 2, 'team email goes to every member');
    assert.ok(part(msgs[0].data, 'application/pdf').subarray(0, 5).toString() === '%PDF-');
  });

  await t.test('Forgot password: emailed one-time link, generic answer, sessions ended', async () => {
    const reset = require('../server/lib/password-reset');
    const anon = async (method, url, body) => { const saved = cookie; cookie = ''; try { return await api(method, url, body); } finally { cookie = saved; } };
    // Needs the Public URL (the link points there).
    assert.equal((await anon('GET', '/api/setup/status')).data.password_reset, false);
    assert.equal((await anon('POST', '/api/auth/forgot', { identifier: 'mtorres' })).status, 503);
    await api('PUT', '/api/settings', { public_url: 'https://cmms.example.org/' });
    assert.equal((await anon('GET', '/api/setup/status')).data.password_reset, true);

    // Unknown account: same answer, nothing sent.
    const before = inbox.length;
    const unknown = await anon('POST', '/api/auth/forgot', { identifier: 'nobody-here' });
    await reset.pending;
    assert.equal(unknown.status, 200);
    assert.equal(inbox.length, before);

    const known = await anon('POST', '/api/auth/forgot', { identifier: 'MTorres' });
    await reset.pending;
    assert.equal(known.data.message, unknown.data.message, 'no account enumeration');
    const tech = db.prepare("SELECT id, email FROM users WHERE username = 'mtorres'").get();
    const msg = inbox[inbox.length - 1];
    assert.deepEqual(msg.to, [tech.email]);
    const text = part(msg.data, 'text/plain').toString();
    const token = text.match(/https:\/\/cmms\.example\.org\/#\/reset-password\?token=([A-Za-z0-9_-]+)/)[1];
    assert.ok(!db.prepare('SELECT 1 FROM password_resets WHERE token_hash = ?').get(token), 'raw token is not stored');

    // The technician is signed in elsewhere; the reset ends that session.
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(require('../server/lib/auth').hashPassword('OldPassword1'), tech.id);
    const saved = cookie; cookie = '';
    await api('POST', '/api/auth/login', { username: 'mtorres', password: 'OldPassword1' });
    const techCookie = cookie; cookie = saved;

    assert.equal((await anon('POST', '/api/auth/reset/check', { token })).data.username, 'mtorres');
    assert.equal((await anon('POST', '/api/auth/reset', { token, password: 'short' })).status, 400, 'password rules apply');
    assert.equal((await anon('POST', '/api/auth/reset', { token, password: 'BrandNewPass42' })).status, 200);
    await reset.pending;
    assert.match(subjectOf(inbox[inbox.length - 1]), /password was changed/);
    assert.equal((await anon('POST', '/api/auth/reset', { token, password: 'AnotherPass42' })).status, 400, 'link works once');
    cookie = techCookie;
    assert.equal((await api('GET', '/api/auth/me')).status, 401, 'signed out everywhere');
    cookie = '';
    assert.equal((await api('POST', '/api/auth/login', { username: 'mtorres', password: 'BrandNewPass42' })).status, 200);
    cookie = saved;

    // A newer link replaces an older one; expired links fail; limit per hour.
    await anon('POST', '/api/auth/forgot', { identifier: tech.email }); await reset.pending;
    const t1 = part(inbox[inbox.length - 1].data, 'text/plain').toString().match(/token=([A-Za-z0-9_-]+)/)[1];
    await anon('POST', '/api/auth/forgot', { identifier: tech.email }); await reset.pending;
    const t2 = part(inbox[inbox.length - 1].data, 'text/plain').toString().match(/token=([A-Za-z0-9_-]+)/)[1];
    assert.equal((await anon('POST', '/api/auth/reset/check', { token: t1 })).status, 400);
    db.prepare("UPDATE password_resets SET expires_at = '2000-01-01' WHERE used_at IS NULL").run();
    assert.equal((await anon('POST', '/api/auth/reset/check', { token: t2 })).status, 400);
    const n = inbox.length;
    await anon('POST', '/api/auth/forgot', { identifier: 'mtorres' }); await reset.pending;
    assert.equal(inbox.length, n, 'no more than 3 links per hour');

    // Inactive accounts get nothing; admins can turn the feature off.
    db.prepare("UPDATE users SET active = 0 WHERE username = 'achen'").run();
    await anon('POST', '/api/auth/forgot', { identifier: 'achen' }); await reset.pending;
    assert.equal(inbox.length, n);
    db.prepare("UPDATE users SET active = 1 WHERE username = 'achen'").run();
    await api('PUT', '/api/settings', { password_reset_enabled: '0' });
    assert.equal((await anon('GET', '/api/setup/status')).data.password_reset, false);
    assert.equal((await anon('POST', '/api/auth/forgot', { identifier: 'achen' })).status, 429, 'per-IP limit of 5 requests per 15 minutes');
    await api('PUT', '/api/settings', { password_reset_enabled: '1' });
  });

  await t.test('PDF structure is valid (cross-reference offsets point at objects)', () => {
    const buf = pdf.report({ title: 'Test (report) \\ ok', meta: [['A', 'B']], paragraphs: ['Long paragraph '.repeat(80)],
      table: { columns: [{ label: 'X' }, { label: 'Y', align: 'right' }], rows: Array.from({ length: 150 }, (_, i) => [`row ${i} — café`, i]) } });
    const s = buf.toString('latin1');
    const startxref = Number(s.match(/startxref\n(\d+)/)[1]);
    assert.ok(s.slice(startxref).startsWith('xref'));
    const offsets = [...s.slice(startxref).matchAll(/(\d{10}) 00000 n/g)].map(m => Number(m[1]));
    offsets.forEach((o, i) => assert.ok(s.slice(o).startsWith(`${i + 1} 0 obj`), `object ${i + 1}`));
    assert.ok(/\/Count ([3-9]|\d\d)/.test(s), 'multi-page');
  });
});

// Libre CMMS - Copyright (C) 2026 CreativeMed LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// Purchase order approval limit: admin sets the limit; POs at or above it need a
// supervisor's electronic signature before they can be ordered or received.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-po-'));
process.env.LIBRE_DATA_DIR = dir;
process.env.LIBRE_CONFIG = path.join(dir, 'none.json');
const { handle, db } = require('../server/server');

let base;
function client() {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Libre': '1', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const t = await res.text(); let data; try { data = JSON.parse(t); } catch { data = t; }
    return { status: res.status, data };
  };
}

test('PO approval limit', async (t) => {
  const server = http.createServer(handle);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const admin = client(); const sup = client(); const tech = client();
  assert.equal((await admin('POST', '/api/setup', { username: 'admin', full_name: 'Admin', password: 'Password123', email: 'admin@example.org' })).status, 200);
  await admin('POST', '/api/auth/login', { username: 'admin', password: 'Password123' });
  for (const [u, role] of [['sup', 'supervisor'], ['tech', 'technician']]) {
    const row = (await admin('POST', '/api/e/users', { username: u, full_name: `${role} user`, role, email: `${u}@example.org` })).data.row;
    await admin('POST', `/api/users/${row.id}/password`, { password: 'Password123' });
    db.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').run(row.id);
  }
  await sup('POST', '/api/auth/login', { username: 'sup', password: 'Password123' });
  await tech('POST', '/api/auth/login', { username: 'tech', password: 'Password123' });

  const vendor = (await admin('POST', '/api/e/vendors', { name: 'Parts Co' })).data.row;
  const part = (await admin('POST', '/api/e/parts', { part_number: 'P-1', name: 'Board', unit_cost: 1000 })).data.row;
  const newPo = async (qty) => {
    const po = (await tech('POST', '/api/e/purchase_orders', { vendor_id: vendor.id })).data.row;
    assert.equal((await tech('POST', '/api/e/po_lines', { po_id: po.id, part_id: part.id, quantity: qty })).status, 200);
    return po;
  };
  const order = (c, po) => c('PUT', `/api/e/purchase_orders/${po.id}`, { status: 'Ordered' });

  await t.test('no limit set: anything can be ordered', async () => {
    const po = await newPo(10);
    assert.equal((await order(tech, po)).status, 200);
    assert.equal((await admin('GET', `/api/po/${po.id}/approval`)).data.required, false);
  });

  await t.test('admin sets the limit; only admins can', async () => {
    assert.equal((await sup('PUT', '/api/settings', { po_approval_limit: '1' })).status, 403);
    assert.equal((await admin('PUT', '/api/settings', { po_approval_limit: '5000' })).status, 200);
  });

  await t.test('below the limit needs no signature', async () => {
    const po = await newPo(4); // $4,000
    assert.equal((await order(tech, po)).status, 200);
  });

  await t.test('at or above the limit needs a supervisor signature', async () => {
    const po = await newPo(5); // $5,000
    const blocked = await order(tech, po);
    assert.equal(blocked.status, 409);
    assert.match(blocked.data.error, /approval limit/);
    assert.equal((await tech('POST', `/api/po/${po.id}/receive`, {})).status, 409, 'cannot receive either');
    assert.equal((await tech('POST', `/api/po/${po.id}/approve`, { password: 'Password123' })).status, 403, 'technicians cannot approve');
    assert.equal((await sup('POST', `/api/po/${po.id}/approve`, { password: 'wrong' })).status, 401, 'signature needs the password');
    assert.equal((await tech('PUT', `/api/e/purchase_orders/${po.id}`, { approved_total: 99999, approval_signature: 'me' })).status, 200);
    assert.equal(db.prepare('SELECT approved_total FROM purchase_orders WHERE id = ?').get(po.id).approved_total, null, 'approval fields cannot be typed in');
    const ok = await sup('POST', `/api/po/${po.id}/approve`, { password: 'Password123' });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.row.approved_total, 5000);
    assert.match(ok.data.row.approval_signature, /supervisor user/);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'e-signature' AND entity = 'purchase_orders'").get().n, 1);
    assert.equal((await order(tech, po)).status, 200);
    // Adding lines to an ordered PO cannot exceed what was approved (and the change is rolled back).
    const add = await tech('POST', '/api/e/po_lines', { po_id: po.id, part_id: part.id, quantity: 1 });
    assert.equal(add.status, 409);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM po_lines WHERE po_id = ?').get(po.id).n, 1, 'rolled back');
    assert.equal(db.prepare('SELECT total FROM purchase_orders WHERE id = ?').get(po.id).total, 5000);
    assert.equal((await tech('POST', `/api/po/${po.id}/receive`, {})).status, 200);
  });

  await t.test('raising a draft above the approved amount needs approval again', async () => {
    const po = await newPo(6);
    await sup('POST', `/api/po/${po.id}/approve`, { password: 'Password123' });
    await tech('POST', '/api/e/po_lines', { po_id: po.id, part_id: part.id, quantity: 1 }); // $7,000 now
    const a = (await tech('GET', `/api/po/${po.id}/approval`)).data;
    assert.equal(a.approved, false);
    assert.equal(a.voided, true);
    assert.match((await order(tech, po)).data.error, /approved for \$6,000\.00/);
    assert.equal((await admin('POST', `/api/po/${po.id}/approve`, { password: 'Password123' })).status, 200, 'admins can approve too');
    assert.equal((await order(tech, po)).status, 200);
  });
});

// Libre CMMS - Copyright (C) 2026 CreativeMed LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// Inventory Mode, red/yellow flags, Unable To Locate and the related reports.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-inv-'));
process.env.LIBRE_DATA_DIR = dir;
process.env.LIBRE_CONFIG = path.join(dir, 'none.json');
const { handle, db } = require('../server/server');

let base; let cookie = '';
async function api(method, url, body) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Libre': '1', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const asset = tag => db.prepare('SELECT * FROM assets WHERE asset_tag = ?').get(tag);
const codes = flags => flags.map(f => f.code).sort();

test('Inventory Mode end-to-end', async (t) => {
  const server = http.createServer(handle);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  assert.equal((await api('POST', '/api/setup', { username: 'admin', full_name: 'Admin User', password: 'Password123', sample_data: true })).status, 200);
  assert.equal((await api('POST', '/api/auth/login', { username: 'admin', password: 'Password123' })).status, 200);

  const icu = db.prepare("SELECT * FROM departments WHERE name = 'ICU'").get();
  const ed = db.prepare("SELECT * FROM departments WHERE name = 'Emergency'").get();
  const pump1 = asset('RGH-00001'); const pump2 = asset('RGH-00002'); const pump3 = asset('RGH-00003');
  const icuMonitor = db.prepare('SELECT a.* FROM assets a JOIN models m ON m.id = a.model_id WHERE m.category = ? AND a.department_id = ? ORDER BY a.id').get('Patient Monitor', icu.id);
  const vent = db.prepare("SELECT a.* FROM assets a JOIN models m ON m.id = a.model_id WHERE m.category = 'Ventilator'").get();
  const edDefib = db.prepare("SELECT a.* FROM assets a JOIN models m ON m.id = a.model_id WHERE m.category = 'Defibrillator' AND a.department_id = ?").get(ed.id);

  await t.test('flag conditions are set up', async () => {
    const recall = db.prepare('SELECT id FROM recalls').get();
    assert.equal((await api('POST', `/api/recalls/${recall.id}/match`)).status, 200); // MV-300 pumps become recall-affected
    const r = await api('POST', '/api/e/documents', { title: 'VX-12 end of support notice', doc_type: 'End of Life / End of Support Letter', model_id: icuMonitor.model_id });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal((await api('POST', `/api/assets/${vent.id}/utl`, {})).status, 400, 'notes required');
    assert.equal((await api('POST', `/api/assets/${vent.id}/utl`, { notes: 'Not in ICU bed 6 or storage' })).status, 200);
    assert.ok(asset(vent.asset_tag).utl_since);
    const f = (await api('GET', `/api/assets/${pump2.id}/flags`)).data.flags;
    assert.ok(codes(f).includes('recall') && codes(f).includes('repair'), JSON.stringify(f)); // sample WO-1 is an open repair on RGH-00002
  });

  let invId;
  await t.test('start, resume and session', async () => {
    assert.equal((await api('POST', '/api/inventories', {})).status, 400);
    assert.equal((await api('POST', '/api/inventories', { facility_id: icu.facility_id + 99, department_id: icu.id })).status, 400);
    const s = await api('POST', '/api/inventories', { facility_id: icu.facility_id, department_id: icu.id });
    assert.equal(s.status, 200, JSON.stringify(s.data));
    invId = s.data.id;
    assert.equal((await api('POST', '/api/inventories', { department_id: icu.id })).data.resumed, true);
    const sess = await api('GET', `/api/inventories/${invId}/session`);
    const tags = sess.data.expected.map(e => e.asset_tag);
    assert.ok(tags.includes(pump1.asset_tag) && tags.includes(vent.asset_tag) && !tags.includes(edDefib.asset_tag));
    assert.equal(sess.data.inventory.expected_count, sess.data.expected.length);
    assert.equal(sess.data.expected.find(e => e.id === vent.id).flag_level, 'Red'); // previous UTL shows red before it is scanned
  });

  await t.test('scanning applies red / yellow flags', async () => {
    const s1 = await api('POST', `/api/inventories/${invId}/scan`, { code: pump1.asset_tag.toLowerCase(), room: 'Bed 1' });
    assert.equal(s1.status, 200, JSON.stringify(s1.data));
    assert.equal(s1.data.scan.flag_level, 'Red');
    const recallFlag = s1.data.scan.flags.find(f => f.code === 'recall');
    assert.ok(recallFlag && recallFlag.alert, 'recall raises an alert');
    assert.ok(s1.data.scan.flags.some(f => f.code === 'pm'), 'pump PM due/overdue is flagged');

    const s2 = await api('POST', `/api/inventories/${invId}/scan`, { code: pump2.asset_tag, room: 'Bed 2' });
    assert.ok(codes(s2.data.scan.flags).includes('repair'));

    const s3 = await api('POST', `/api/inventories/${invId}/scan`, { code: icuMonitor.asset_tag, room: 'Bed 4' });
    assert.equal(s3.data.scan.flag_level, 'Yellow', JSON.stringify(s3.data.scan.flags));
    assert.ok(codes(s3.data.scan.flags).includes('eol'));

    const s4 = await api('POST', `/api/inventories/${invId}/scan`, { code: `https://cmms.example.org/portal?asset=${vent.asset_tag}`, room: 'Bed 6' }); // QR label link
    assert.ok(codes(s4.data.scan.flags).includes('utl'));
    assert.equal(s4.data.scan.flag_level, 'Red');

    const s5 = await api('POST', `/api/inventories/${invId}/scan`, { code: edDefib.asset_tag, room: 'Crash cart 2' });
    assert.equal(s5.data.scan.result, 'Found - Other Department');
    assert.ok(codes(s5.data.scan.flags).includes('other_dept'));

    const dup = await api('POST', `/api/inventories/${invId}/scan`, { code: pump1.asset_tag });
    assert.equal(dup.data.duplicate, true);
  });

  await t.test('unknown tag: red flag, add to inventory with department prefilled, link scan', async () => {
    const s = await api('POST', `/api/inventories/${invId}/scan`, { code: 'NEW-777', room: 'Bed 9' });
    assert.equal(s.data.notFound, true);
    assert.equal(s.data.scan.flag_level, 'Red');
    const a = await api('POST', '/api/e/assets', { asset_tag: 'NEW-777', facility_id: icu.facility_id, department_id: icu.id, current_department_id: icu.id, current_room: 'Bed 9', description: 'Found pump' });
    assert.equal(a.status, 200, JSON.stringify(a.data));
    const l = await api('POST', `/api/inventories/${invId}/scans/${s.data.scan.id}/link`, { asset_id: a.data.row.id });
    assert.equal(l.data.scan.result, 'Added To Inventory');
  });

  await t.test('complete: current location updated, owning dept unchanged, UTL resolved and created', async () => {
    const sess = (await api('GET', `/api/inventories/${invId}/session`)).data;
    const unscanned = sess.expected.filter(e => !e.scanned).map(e => e.id);
    assert.ok(unscanned.includes(pump3.id));
    const c = await api('POST', `/api/inventories/${invId}/complete`, { utl_asset_ids: unscanned });
    assert.equal(c.status, 200, JSON.stringify(c.data));
    assert.equal(c.data.row.status, 'Completed');
    assert.equal(c.data.row.missing_count, unscanned.length);
    assert.equal(c.data.row.added_count, 1);
    assert.equal(c.data.row.unexpected_count, 1);
    assert.ok(c.data.row.red_count >= 5 && c.data.row.yellow_count >= 1);

    const d = asset(edDefib.asset_tag);
    assert.equal(d.department_id, ed.id, 'owning department is not changed');
    assert.equal(d.current_department_id, icu.id, 'current location is updated');
    assert.equal(d.current_room, 'Crash cart 2');
    assert.ok(d.last_seen_at);
    assert.equal(asset(pump1.asset_tag).current_room, 'Bed 1');
    assert.equal(asset(vent.asset_tag).utl_since, null, 'previous UTL resolved when found');
    assert.equal(db.prepare("SELECT status FROM utl_events WHERE asset_id = ? AND source = 'Manual'").get(vent.id).status, 'Resolved');
    assert.ok(asset(pump3.asset_tag).utl_since, 'unscanned asset marked UTL');
    assert.equal((await api('POST', `/api/inventories/${invId}/scan`, { code: pump1.asset_tag })).status, 409, 'completed inventory is locked');
  });

  await t.test('PM work order marked Unable To Locate, released when found by a later inventory', async () => {
    const pm = db.prepare("SELECT * FROM work_orders WHERE pm_schedule_id IS NOT NULL AND asset_id = ? AND status NOT IN ('Completed','Closed','Cancelled')").get(pump1.id);
    assert.ok(pm, 'sample PM WO for pump 1');
    assert.equal((await api('POST', `/api/wo/${pm.id}/utl`, {})).status, 400);
    const u = await api('POST', `/api/wo/${pm.id}/utl`, { notes: 'Checked ICU, clean utility, biomed shop' });
    assert.equal(u.status, 200, JSON.stringify(u.data));
    assert.equal(u.data.row.status, 'On Hold');
    assert.equal(u.data.row.unable_to_locate, 1);
    assert.equal(db.prepare('SELECT source FROM utl_events WHERE work_order_id = ?').get(pm.id).source, 'PM Work Order');
    assert.ok(asset(pump1.asset_tag).utl_since);
    const ul = await api('GET', '/api/e/work_orders?view=utl');
    assert.ok(ul.data.rows.some(r => r.id === pm.id));

    const s = await api('POST', '/api/inventories', { department_id: icu.id });
    await api('POST', `/api/inventories/${s.data.id}/scan`, { code: pump1.asset_tag, room: 'Bed 3' });
    assert.equal((await api('POST', `/api/inventories/${s.data.id}/complete`, { utl_asset_ids: [] })).status, 200);
    const w = db.prepare('SELECT * FROM work_orders WHERE id = ?').get(pm.id);
    assert.equal(w.unable_to_locate, 0);
    assert.equal(w.status, 'Assigned');
    assert.equal(asset(pump1.asset_tag).utl_since, null);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM utl_events WHERE work_order_id = ? AND status = 'Resolved'").get(pm.id).n, 1);

    // The 'located' action on a work order also resolves.
    const pm3 = db.prepare("SELECT * FROM work_orders WHERE pm_schedule_id IS NOT NULL AND asset_id = ? AND status NOT IN ('Completed','Closed','Cancelled')").get(pump2.id);
    await api('POST', `/api/wo/${pm3.id}/utl`, { notes: 'Not in room' });
    const loc = await api('POST', `/api/wo/${pm3.id}/located`, { notes: 'Was in OR 2' });
    assert.equal(loc.data.row.unable_to_locate, 0);
    assert.equal(asset(pump2.asset_tag).utl_since, null);
  });

  await t.test('reports', async () => {
    const r1 = await api('GET', '/api/reports/unable_to_locate');
    assert.equal(r1.status, 200, JSON.stringify(r1.data));
    assert.ok(r1.data.rows.some(r => r.source === 'Inventory' && r.status === 'Open'));
    assert.ok(r1.data.rows.some(r => r.source === 'PM Work Order' && r.status === 'Resolved'));
    const open = await api('GET', '/api/reports/unable_to_locate?utl_status=Open');
    assert.ok(open.data.rows.every(r => r.status === 'Open'));
    const r2 = await api('GET', '/api/reports/utl_by_department');
    const icuRow = r2.data.rows.find(r => r.department === 'ICU');
    assert.ok(icuRow.utl_now >= 1 && icuRow.utl_period >= 3 && icuRow.last_inventory, JSON.stringify(icuRow));
    const r3 = await api('GET', `/api/reports/inventory_flags?inventory_id=${invId}`);
    assert.ok(r3.data.rows.some(r => r.result === 'Unable To Locate'));
    assert.ok(r3.data.rows.some(r => r.flag === 'Yellow'));
    assert.ok(r3.data.rows.some(r => /OPEN RECALL/.test(r.reasons)));
    const red = await api('GET', `/api/reports/inventory_flags?inventory_id=${invId}&flag=Red`);
    assert.ok(red.data.rows.length && red.data.rows.every(r => r.flag === 'Red'));
    const pmc = await api('GET', '/api/reports/pm_compliance');
    assert.ok(pmc.data.columns.some(c => c.key === 'utl'));
    const csv = await api('GET', `/api/reports/inventory_flags?inventory_id=${invId}&format=csv`);
    assert.match(csv.data, /Reason\(s\)/);
    const dash = await api('GET', '/api/dashboard');
    assert.ok(dash.data.kpi.utl_assets >= 1);
  });
});

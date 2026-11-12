// Libre CMMS - Copyright (C) 2026 CreativeMed LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// End-to-end API test against a throwaway database: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-test-'));
process.env.LIBRE_DATA_DIR = dir;
process.env.LIBRE_CONFIG = path.join(dir, 'none.json');
const { handle, db } = require('../server/server');

let base; let cookie = '';
async function api(method, url, body, raw) {
  const res = await fetch(base + url, {
    method, headers: { 'Content-Type': raw ? 'text/csv' : 'application/json', 'X-Libre': '1', Cookie: cookie },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

test('Libre end-to-end', async (t) => {
  const server = http.createServer(handle);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  await t.test('setup + login', async () => {
    assert.equal((await api('GET', '/api/setup/status')).data.needsSetup, true);
    assert.equal((await api('POST', '/api/setup', { username: 'admin', full_name: 'Admin User', password: 'short' })).status, 400);
    const s = await api('POST', '/api/setup', { org_name: 'Test Hospital', username: 'admin', full_name: 'Admin User', password: 'Password123', sample_data: true });
    assert.equal(s.status, 200, JSON.stringify(s.data));
    assert.equal((await api('POST', '/api/setup', { username: 'x', full_name: 'x', password: 'Password123' })).status, 409);
    assert.equal((await api('GET', '/api/meta')).status, 401);
    assert.equal((await api('POST', '/api/auth/login', { username: 'admin', password: 'wrong' })).status, 401);
    assert.equal((await api('POST', '/api/auth/login', { username: 'ADMIN', password: 'Password123' })).status, 200);
    const me = await api('GET', '/api/auth/me');
    assert.equal(me.data.user.role, 'admin');
  });

  await t.test('csrf header required', async () => {
    const res = await fetch(base + '/api/e/vendors', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{"name":"x"}' });
    assert.equal(res.status, 403);
  });

  await t.test('meta, dashboard, search', async () => {
    const m = await api('GET', '/api/meta');
    assert.ok(m.data.entities.assets.fields.length > 10);
    const d = await api('GET', '/api/dashboard');
    assert.equal(d.status, 200, JSON.stringify(d.data));
    assert.ok(d.data.kpi.active_assets >= 10);
    assert.ok(d.data.kpi.open_wos >= 2);
    const s = await api('GET', '/api/search?q=MV-300');
    assert.ok(s.data.results.length > 0);
  });

  let woId;
  await t.test('asset + work order lifecycle', async () => {
    const assets = await api('GET', '/api/e/assets?q=RGH-00001');
    assert.equal(assets.status, 200);
    const asset = assets.data.rows[0];
    assert.ok(asset._labels.model_id.includes('Medivance'));
    const w = await api('POST', '/api/e/work_orders', { type: 'Corrective', asset_id: asset.id, problem: 'Door alarm', priority: 'High' });
    assert.equal(w.status, 200, JSON.stringify(w.data));
    woId = w.data.row.id;
    assert.match(w.data.row.wo_number, /^WO-\d{4}-\d{6}$/);
    assert.equal((await api('POST', `/api/wo/${woId}/start`, {})).data.row.status, 'In Progress');
    const part = (await api('GET', '/api/e/parts?q=BAT-MV300')).data.rows[0];
    const before = part.quantity_on_hand;
    assert.equal((await api('POST', '/api/e/wo_parts', { work_order_id: woId, part_id: part.id, quantity: 2 })).status, 200);
    assert.equal((await api('GET', `/api/e/parts/${part.id}`)).data.row.quantity_on_hand, before - 2);
    await api('POST', '/api/e/wo_labor', { work_order_id: woId, hours: 1.5 });
    const wo = (await api('GET', `/api/e/work_orders/${woId}`)).data.row;
    assert.equal(wo.labor_hours, 1.5);
    assert.equal(wo.parts_cost, 179);
    assert.equal((await api('POST', `/api/wo/${woId}/complete`, { work_performed: 'Replaced latch', password: 'bad' })).status, 401);
    const done = await api('POST', `/api/wo/${woId}/complete`, { work_performed: 'Replaced latch', password: 'Password123', return_to_service: true });
    assert.equal(done.data.row.status, 'Completed');
    const signed = await api('POST', `/api/wo/${woId}/supervisor_sign`, { password: 'Password123' });
    assert.equal(signed.data.row.status, 'Closed');
    assert.equal((await api('PUT', `/api/e/work_orders/${woId}`, { problem: 'changed' })).status, 409);
    const audit = await api('GET', `/api/audit?entity=work_orders&entity_id=${woId}`);
    assert.ok(audit.data.rows.some(r => r.action === 'e-signature'));
  });

  await t.test('PM test record with tolerance evaluation and failure follow-up', async () => {
    const pms = await api('GET', '/api/e/work_orders?view=pm');
    const pm = pms.data.rows.find(r => r.problem && r.problem.includes('PM-INF-01'));
    assert.ok(pm, 'PM work order auto-generated');
    const proc = (await api('GET', '/api/e/procedures?q=PM-INF-01')).data.rows[0];
    const te = (await api('GET', '/api/e/assets?view=test_equipment')).data.rows;
    const run = await api('POST', '/api/runs', { work_order_id: pm.id, procedure_id: proc.id, test_equipment_ids: te.map(x => x.id) });
    assert.equal(run.status, 200, JSON.stringify(run.data));
    const rs = run.data.results;
    const flow = rs.find(r => r.seq === 5);
    assert.equal(flow.lower_limit, 95); assert.equal(flow.upper_limit, 105);
    const entries = rs.map(r => ({ id: r.id, value: { Instruction: 'Done', 'Pass/Fail': 'Pass', Measurement: '0.1', 'Text Entry': '' }[r.step_type] }));
    entries.find(e => e.id === flow.id).value = '92.5';
    entries.find(e => e.id === rs.find(r => r.seq === 6).id).value = '15';
    const rec = await api('PUT', `/api/runs/${run.data.run.id}/results`, { results: entries });
    assert.equal(rec.data.results.find(r => r.seq === 5).result, 'Fail');
    assert.equal(rec.data.results.find(r => r.seq === 5).error_pct, -7.5);
    const fin = await api('POST', `/api/runs/${run.data.run.id}/complete`, { password: 'Password123' });
    assert.equal(fin.status, 200, JSON.stringify(fin.data));
    assert.equal(fin.data.run.result, 'Fail');
    assert.ok(fin.data.followup.wo_number);
    // Approved procedures are locked
    assert.equal((await api('PUT', `/api/e/procedures/${proc.id}`, { name: 'x' })).status, 409);
    const rev = await api('POST', `/api/procedures/${proc.id}/revise`);
    assert.equal(rev.data.row.version, 2);
    assert.equal((await api('POST', `/api/procedures/${rev.data.row.id}/approve`)).data.row.status, 'Approved');
    assert.equal((await api('GET', `/api/e/procedures/${proc.id}`)).data.row.status, 'Retired');
  });

  await t.test('recalls', async () => {
    const r = (await api('GET', '/api/e/recalls')).data.rows[0];
    const m = await api('POST', `/api/recalls/${r.id}/match`);
    assert.equal(m.data.added, 6);
    const w = await api('POST', `/api/recalls/${r.id}/workorders`);
    assert.equal(w.data.created.length, 6);
  });

  await t.test('work order filters, teams and bulk assignment', async () => {
    // Filters: device type (via asset -> model category), multi-status, due range
    const pumps = await api('GET', '/api/e/work_orders?' + new URLSearchParams({ view: 'open', asset_category: 'Infusion Pump', limit: 500 }));
    assert.equal(pumps.status, 200, JSON.stringify(pumps.data));
    assert.ok(pumps.data.total >= 6);
    assert.ok(pumps.data.rows.every(r => r._labels.asset_id.includes('Infusion Pump')));
    const statuses = await api('GET', '/api/e/work_orders?fin_status=Open,Assigned&limit=500');
    assert.ok(statuses.data.rows.every(r => ['Open', 'Assigned'].includes(r.status)));
    const ranged = await api('GET', `/api/e/work_orders?from_due_date=2000-01-01&to_due_date=2000-12-31`);
    assert.equal(ranged.data.total, 0);
    const cats = await api('GET', '/api/distinct/models/category');
    assert.ok(cats.data.values.includes('Infusion Pump'));

    const users = (await api('GET', '/api/e/users?view=techs')).data.rows;
    const achen = users.find(u => u.username === 'achen');
    const teams = (await api('GET', '/api/e/teams')).data.rows;
    assert.ok(teams.length >= 2, 'sample teams exist');
    const team = await api('POST', '/api/e/teams', { name: 'Night Shift', active: 1 });
    assert.equal(team.status, 200, JSON.stringify(team.data));
    await api('POST', '/api/e/team_members', { team_id: team.data.row.id, user_id: achen.id });
    assert.equal((await api('POST', '/api/e/team_members', { team_id: team.data.row.id, user_id: achen.id })).status, 409, 'no duplicate membership');

    // Bulk assign every open infusion-pump work order (by filter) to one technician
    const filter = { view: 'open', asset_category: 'Infusion Pump' };
    const b1 = await api('POST', '/api/wo/bulk', { filter, changes: { assigned_to: achen.id } });
    assert.equal(b1.status, 200, JSON.stringify(b1.data));
    assert.equal(b1.data.updated, pumps.data.total);
    const after = await api('GET', '/api/e/work_orders?' + new URLSearchParams({ ...filter, limit: 500 }));
    assert.ok(after.data.rows.every(r => r.assigned_to === achen.id && r.status !== 'Open'));

    // Bulk assign selected ids to a team queue, clearing the technician; closed WO is skipped
    const ids = after.data.rows.slice(0, 3).map(r => r.id);
    const b2 = await api('POST', '/api/wo/bulk', { ids: [...ids, woId], changes: { team_id: team.data.row.id }, clear_technician: true });
    assert.equal(b2.data.updated, 3);
    assert.equal(b2.data.skipped.length, 1);
    assert.match(b2.data.skipped[0].reason, /closed/);
    for (const id of ids) {
      const w = (await api('GET', `/api/e/work_orders/${id}`)).data.row;
      assert.equal(w.team_id, team.data.row.id);
      assert.equal(w.assigned_to, null);
      assert.equal(w.status, 'Open');
    }
    const q = await api('GET', `/api/e/work_orders?f_team_id=${team.data.row.id}&f_assigned_to=null`);
    assert.equal(q.data.total, 3);

    // Validation
    assert.equal((await api('POST', '/api/wo/bulk', { ids, changes: { status: 'Completed' } })).status, 400);
    assert.equal((await api('POST', '/api/wo/bulk', { ids, changes: {} })).status, 400);
    assert.equal((await api('POST', '/api/wo/bulk', { ids, changes: { assigned_to: 999999 } })).status, 400);

    // Workload, audit and one summary notification per person
    const wl = await api('GET', '/api/workload');
    assert.ok(wl.data.techs.find(x => x.id === achen.id).open >= pumps.data.total - 3);
    assert.equal(wl.data.teams.find(x => x.name === 'Night Shift').queue, 3);
    const audit = await api('GET', '/api/audit?action=bulk-update');
    assert.equal(audit.data.rows.length, 2);
    const notes = db.prepare("SELECT message FROM notifications WHERE user_id = ? AND message LIKE '%assigned you%'").all(achen.id);
    assert.equal(notes.length, 1);
    const teamNotes = db.prepare("SELECT message FROM notifications WHERE user_id = ? AND message LIKE '%Night Shift queue%'").all(achen.id);
    assert.equal(teamNotes.length, 1);
  });

  await t.test('public portal', async () => {
    const saved = cookie; cookie = '';
    const s = await api('POST', '/api/public/requests', { requester_name: 'Nurse', problem: 'Pump beeping', asset_text: 'RGH-00002', urgency: 'High' });
    assert.equal(s.status, 200, JSON.stringify(s.data));
    assert.equal(s.data.asset_found, true);
    const st = await api('GET', `/api/public/requests/${s.data.request_number}?token=${s.data.token}`);
    assert.equal(st.data.status, 'New');
    assert.equal((await api('GET', `/api/public/requests/${s.data.request_number}?token=nope`)).status, 404);
    cookie = saved;
    const sr = (await api('GET', `/api/e/service_requests?q=${s.data.request_number}`)).data.rows[0];
    const conv = await api('POST', `/api/requests/${sr.id}/convert`, {});
    assert.equal(conv.data.row.priority, 'High');
  });

  await t.test('reports + csv', async () => {
    const list = (await api('GET', '/api/meta')).data.reports;
    for (const r of list) {
      const res = await api('GET', `/api/reports/${r.key}`);
      assert.equal(res.status, 200, `${r.key}: ${JSON.stringify(res.data)}`);
    }
    const csv = await api('GET', '/api/reports/asset_inventory?format=csv');
    assert.match(csv.data, /Asset Tag/);
    const ecsv = await api('GET', '/api/e/assets?format=csv');
    assert.match(ecsv.data, /RGH-00001/);
  });

  await t.test('csv import with duplicate detection', async () => {
    const csv = 'asset_tag,Model,serial_number,status\nIMP-1,Medivance|MV-300,NEW-1,Active\nIMP-2,Newco|NX-1,NEW-2,Active\nIMP-3,Medivance|MV-300,NEW-1,Active\n';
    const r = await api('POST', '/api/import/assets', csv, true);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.created, 2);
    assert.equal(r.data.duplicates, 1);
  });

  await t.test('roles enforced', async () => {
    const tech = (await api('GET', '/api/e/users?q=mtorres')).data.rows[0];
    assert.equal((await api('POST', `/api/users/${tech.id}/password`, { password: 'TechPass123' })).status, 200);
    const saved = cookie; cookie = '';
    await api('POST', '/api/auth/login', { username: 'mtorres', password: 'TechPass123' });
    assert.equal((await api('GET', '/api/meta')).status, 428); // must change password
    assert.equal((await api('POST', '/api/auth/password', { current: 'TechPass123', password: 'TechPass456' })).status, 200);
    assert.equal((await api('GET', '/api/meta')).status, 200);
    assert.equal((await api('POST', '/api/e/users', { username: 'x', full_name: 'x', role: 'admin' })).status, 403);
    assert.equal((await api('GET', '/api/settings')).status, 403);
    assert.equal((await api('POST', '/api/e/vendors', { name: 'Tech Vendor' })).status, 200);
    assert.equal((await api('DELETE', '/api/e/vendors/1')).status, 403);
    cookie = saved;
  });

  await t.test('attachments + backup', async () => {
    const up = await fetch(`${base}/api/files?entity=assets&id=1&name=photo.txt`, { method: 'POST', headers: { 'X-Libre': '1', Cookie: cookie }, body: 'hello' });
    assert.equal(up.status, 200);
    const list = await api('GET', '/api/files?entity=assets&id=1');
    assert.equal(list.data.rows.length, 1);
    const dl = await fetch(`${base}/api/files/${list.data.rows[0].id}`, { headers: { Cookie: cookie } });
    assert.equal(await dl.text(), 'hello');
    const b = await api('POST', '/api/backups');
    assert.equal(b.status, 200);
    assert.ok(fs.existsSync(path.join(dir, 'backups', b.data.file)));
  });
});

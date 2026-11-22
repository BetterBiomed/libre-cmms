// Libre CMMS - Copyright (C) 2026 CreativeMed LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// PM Planner: forecast, month lists, moves (preview and real), deferral safeguard,
// cycle shifting, spreading across workdays and scheduling unscheduled assets.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-plan-'));
process.env.LIBRE_DATA_DIR = dir;
process.env.LIBRE_CONFIG = path.join(dir, 'none.json');
const { handle, db } = require('../server/server');
const logic = require('../server/lib/logic');

let base; let cookie = '';
async function api(method, url, body) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Libre': '1', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const t = await res.text(); let data; try { data = JSON.parse(t); } catch { data = t; }
  return { status: res.status, data };
}
const TODAY = new Date().toISOString().slice(0, 10);
const ym = n => logic.addMonths(TODAY.slice(0, 8) + '01', n).slice(0, 7);
const day = (n, d) => `${ym(n)}-${String(d).padStart(2, '0')}`;
const sched = id => db.prepare('SELECT * FROM pm_schedules WHERE id = ?').get(id);

test('PM Planner', async (t) => {
  const server = http.createServer(handle);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal((await api('POST', '/api/setup', { username: 'admin', full_name: 'Admin', password: 'Password123' , email: 'admin@example.org' })).status, 200);
  await api('POST', '/api/auth/login', { username: 'admin', password: 'Password123' });

  const fac = (await api('POST', '/api/e/facilities', { name: 'Test Hospital' })).data.row;
  const icu = (await api('POST', '/api/e/departments', { name: 'ICU', facility_id: fac.id })).data.row;
  const ed = (await api('POST', '/api/e/departments', { name: 'ED', facility_id: fac.id })).data.row;
  const pump = (await api('POST', '/api/e/models', { manufacturer: 'Acme', model: 'P1', category: 'Infusion Pump', pm_interval_months: 12 })).data.row;
  const bare = (await api('POST', '/api/e/models', { manufacturer: 'Acme', model: 'NoPM', category: 'Scale' })).data.row;
  const mk = async (tag, dept, model = pump.id) => (await api('POST', '/api/e/assets', { asset_tag: tag, model_id: model, facility_id: fac.id, department_id: dept })).data.row;
  const schedules = [];
  for (let i = 0; i < 4; i++) {
    const a = await mk(`ICU-${i}`, icu.id);
    schedules.push((await api('POST', '/api/e/pm_schedules', { asset_id: a.id, interval_months: 12, next_due: day(1, 10), active: 1 })).data.row);
  }
  for (let i = 0; i < 2; i++) {
    const a = await mk(`ED-${i}`, ed.id);
    schedules.push((await api('POST', '/api/e/pm_schedules', { asset_id: a.id, interval_months: 12, next_due: day(3, 12), active: 1 })).data.row);
  }
  const q3asset = await mk('ED-Q', ed.id);
  const quarterly = (await api('POST', '/api/e/pm_schedules', { asset_id: q3asset.id, interval_months: 3, next_due: day(2, 5), active: 1 })).data.row;
  const unA = await mk('UN-1', ed.id);
  const unB = await mk('UN-2', ed.id, bare.id);

  await t.test('forecast counts every occurrence in the horizon', async () => {
    const f = await api('GET', '/api/pm/forecast?months=12');
    assert.equal(f.status, 200, JSON.stringify(f.data));
    const by = Object.fromEntries(f.data.months.map(m => [m.month, m.count]));
    assert.equal(f.data.months.length, 12);
    assert.equal(by[ym(1)], 4);
    assert.equal(by[ym(2)], 1); // quarterly
    assert.equal(by[ym(3)], 2);
    assert.equal(by[ym(5)], 1); // quarterly again
    assert.equal(f.data.months.reduce((a, m) => a + m.count, 0), 6 + 4);
    assert.ok(f.data.balance_cv > 0);
    const icuOnly = await api('GET', `/api/pm/forecast?months=12&department_id=${icu.id}`);
    assert.equal(icuOnly.data.months.reduce((a, m) => a + m.count, 0), 4);
  });

  await t.test('month list and unscheduled assets', async () => {
    const l = await api('GET', `/api/pm/plan?month=${ym(5)}`);
    assert.equal(l.data.total, 1);
    assert.equal(l.data.rows[0].occurrence, day(5, 5));
    const u = await api('GET', '/api/pm/unscheduled');
    assert.deepEqual(u.data.rows.map(r => r.asset_tag).sort(), ['UN-1', 'UN-2']);
  });

  await t.test('preview does not save; deferral needs a supervisor and a reason', async () => {
    const items = schedules.slice(0, 2).map(s => ({ schedule_id: s.id, from: s.next_due }));
    const prev = await api('POST', '/api/pm/reschedule', { items, target_month: ym(2), day_mode: 'keep', dry_run: true, reason: 'x', forecast: { months: 12 } });
    assert.equal(prev.status, 200, JSON.stringify(prev.data));
    const after = Object.fromEntries(prev.data.after.months.map(m => [m.month, m.count]));
    assert.equal(after[ym(1)], 2);
    assert.equal(after[ym(2)], 3);
    assert.equal(sched(schedules[0].id).next_due, day(1, 10), 'dry run rolled back');

    // Moving a month later exceeds the 30-day grace: supervisor + reason required.
    assert.equal((await api('POST', '/api/pm/reschedule', { items, target_month: ym(2), day_mode: 'keep' })).status, 400);
    const tech = (await api('POST', '/api/e/users', { username: 'tech', full_name: 'Tech One', role: 'technician', email: 'tech@example.org' })).data.row;
    await api('POST', `/api/users/${tech.id}/password`, { password: 'TechPass123' });
    const adminCookie = cookie; cookie = '';
    await api('POST', '/api/auth/login', { username: 'tech', password: 'TechPass123' });
    await api('POST', '/api/auth/password', { current: 'TechPass123', password: 'TechPass456' });
    assert.equal((await api('POST', '/api/pm/reschedule', { items, target_month: ym(2), day_mode: 'keep', reason: 'busy' })).status, 403);
    // Moving EARLIER is fine for a technician: ED PMs from month+3 to month+2.
    const earlier = schedules.slice(4, 6).map(s => ({ schedule_id: s.id, from: s.next_due }));
    const e = await api('POST', '/api/pm/reschedule', { items: earlier, target_month: ym(2), day_mode: 'keep' });
    assert.equal(e.status, 200, JSON.stringify(e.data));
    assert.equal(e.data.moved, 2);
    assert.equal(sched(schedules[4].id).next_due, day(2, 12));
    cookie = adminCookie;

    const real = await api('POST', '/api/pm/reschedule', { items, target_month: ym(2), day_mode: 'keep', reason: 'Biomed staffing for ICU expansion' });
    assert.equal(real.status, 200, JSON.stringify(real.data));
    assert.equal(real.data.moved, 2);
    assert.equal(sched(schedules[0].id).next_due, day(2, 10));
    assert.match(sched(schedules[0].id).deferral_reason, /staffing/);
    const audit = db.prepare("SELECT summary FROM audit_log WHERE action = 'pm-reschedule' ORDER BY id DESC").get();
    assert.match(audit.summary, /moved 2/);
  });

  await t.test('moving a later occurrence shifts the whole cycle', async () => {
    // Quarterly next due month+2 day 5; move its month+5 occurrence to month+6 day 5.
    const r = await api('POST', '/api/pm/reschedule', { items: [{ schedule_id: quarterly.id, from: day(5, 5) }], target_month: ym(6), day_mode: 'date', date: day(6, 5), reason: 'balance' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const s = sched(quarterly.id);
    // The moved occurrence was one interval after next_due, so next_due becomes one interval before the target.
    assert.equal(s.next_due, logic.addMonths(day(6, 5), -3));
    assert.equal((await api('POST', '/api/pm/reschedule', { items: [{ schedule_id: quarterly.id }], target_month: ym(-1) })).status, 400, 'past month rejected');
  });

  await t.test('moving a far occurrence earlier shifts the phase of a repeating schedule', async () => {
    // Quarterly schedule: take an occurrence ~9 months out and move it to month+1.
    // The exact shift would land the next PM in the past; instead the cycle's phase
    // shifts so month+1 is one of its due dates and the next PM stays in the future.
    const s0 = sched(quarterly.id);
    const far = logic.addMonths(s0.next_due, 9);
    const r = await api('POST', '/api/pm/reschedule', { items: [{ schedule_id: quarterly.id, from: far }], target_month: ym(1), day_mode: 'date', date: day(1, 20) });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.moved, 1, JSON.stringify({ data: r.data, s0, far }));
    assert.equal(r.data.skipped.length, 0);
    const s1 = sched(quarterly.id);
    assert.ok(s1.next_due >= TODAY && s1.next_due <= day(1, 20), s1.next_due);
    const f = (await api('GET', `/api/pm/plan?month=${ym(1)}`)).data.rows.filter(x => x.id === quarterly.id);
    assert.equal(f.length, 1, 'a PM of the quarterly schedule now falls in month+1');
    assert.equal(f[0].occurrence, day(1, 20));
  });

  await t.test('open PM work order follows; spread uses workdays', async () => {
    const s = sched(schedules[2].id);
    const woId = Number(db.prepare(`INSERT INTO work_orders (wo_number, type, asset_id, status, priority, due_date, pm_schedule_id, requested_at, created_at)
      VALUES ('WO-T-1','Preventive',?, 'Assigned','Normal', ?, ?, ?, ?)`).run(s.asset_id, s.next_due, s.id, new Date().toISOString(), new Date().toISOString()).lastInsertRowid);
    const items = schedules.slice(2, 4).map(x => ({ schedule_id: x.id, from: sched(x.id).next_due }));
    const r = await api('POST', '/api/pm/reschedule', { items, target_month: ym(4), day_mode: 'spread', reason: 'spread out' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    for (const it of items) {
      const nd = sched(it.schedule_id).next_due;
      assert.equal(nd.slice(0, 7), ym(4));
      assert.ok(![0, 6].includes(new Date(nd + 'T12:00:00Z').getUTCDay()), `${nd} is a weekday`);
    }
    assert.equal(db.prepare('SELECT due_date FROM work_orders WHERE id = ?').get(woId).due_date, sched(schedules[2].id).next_due);
  });

  await t.test('schedule unscheduled assets into a month', async () => {
    const r = await api('POST', '/api/pm/schedule-assets', { asset_ids: [unA.id, unB.id], target_month: ym(7) });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.created, 1);
    assert.match(r.data.skipped[0].reason, /no PM interval/);
    const s = db.prepare('SELECT * FROM pm_schedules WHERE asset_id = ?').get(unA.id);
    assert.equal(s.interval_months, 12);
    assert.equal(s.next_due.slice(0, 7), ym(7));
    const withInterval = await api('POST', '/api/pm/schedule-assets', { asset_ids: [unB.id], target_month: ym(7), interval_months: 24 });
    assert.equal(withInterval.data.created, 1);
    assert.equal((await api('GET', '/api/pm/unscheduled')).data.total, 0);
  });
});

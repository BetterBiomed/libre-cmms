// Libre CMMS - Copyright (C) 2026 CreativeMed LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// Device Lookup with a mocked openFDA (no internet needed).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-lookup-'));
process.env.LIBRE_DATA_DIR = dir;
process.env.LIBRE_CONFIG = path.join(dir, 'none.json');

// ---- mock openFDA ----
const realFetch = globalThis.fetch;
const fdaCalls = [];
let offline = false;
const UDI = [
  { company_name: 'CAREFUSION 303, INC.', brand_name: 'BD Alaris™ PCU Module, Model 8015', version_or_model_number: '8015', device_description: 'BD Alaris™ PCU Module, Model 8015 v12.3.1',
    gmdn_terms: [{ name: 'Bedside infusion pump, single-channel' }], product_codes: [{ code: 'FRN', name: 'Pump, infusion', openfda: { device_class: '2' } }], identifiers: [{ id: '10885403516023', type: 'Primary' }] },
  { company_name: 'CAREFUSION 303, INC.', brand_name: 'BD Alaris™ PCU Module, Model 8015', version_or_model_number: '8015', device_description: 'BD Alaris™ PCU Module, Model 8015 v12.1.3',
    gmdn_terms: [{ name: 'Bedside infusion pump, single-channel' }], product_codes: [{ code: 'FRN', name: 'Pump, infusion', openfda: { device_class: '2' } }], identifiers: [{ id: '10885403515231', type: 'Primary' }] },
  { company_name: 'ULTRADENT PRODUCTS, INC.', brand_name: 'Amelogen Plus', version_or_model_number: '8015', gmdn_terms: [{ name: 'Dental composite resin' }],
    product_codes: [{ code: 'EBF', name: 'Material, tooth shade, resin', openfda: { device_class: '2' } }], identifiers: [{ id: '00883205000001' }] },
];
const CLASSIFICATION = [
  { product_code: 'FRN', device_name: 'Pump, Infusion', device_class: '2', regulation_number: '880.5725', medical_specialty_description: 'General Hospital', life_sustain_support_flag: 'N', implant_flag: 'N' },
  { product_code: 'MKJ', device_name: 'Automated External Defibrillators (Non-Wearable)', device_class: '3', regulation_number: '870.5310', medical_specialty_description: 'Cardiovascular', life_sustain_support_flag: 'Y', implant_flag: 'N' },
  { product_code: 'DXN', device_name: 'System, Measurement, Blood-Pressure, Non-Invasive', device_class: '2', regulation_number: '870.1130', medical_specialty_description: 'Cardiovascular', life_sustain_support_flag: 'N', implant_flag: 'N' },
  { product_code: 'EBF', device_name: 'Material, Tooth Shade, Resin', device_class: '2', regulation_number: '872.3690', medical_specialty_description: 'Dental', life_sustain_support_flag: 'N', implant_flag: 'N' },
];
const K510 = [
  { k_number: 'K102972', device_name: 'LIFEPAK 12', applicant: 'Physio-Control, Inc.', product_code: 'MKJ', decision_date: '2010-12-22', openfda: { device_class: '3', device_name: 'Automated External Defibrillators (Non-Wearable)' } },
  { k_number: 'K010918', device_name: 'LIFEPAK 12 DEFIBRILLATOR/MONITOR SYSTEM', applicant: 'Medtronic Physio-Control Corp.', product_code: 'MKJ', decision_date: '2001-08-23', openfda: { device_class: '3' } },
  { k_number: 'K990338', device_name: 'NIBP AND CO2 OPTIONS FOR THE PHYSIO-CONTROL LIFEPAK 12 DEFIBRILLATOR/MONITOR SYSTEM', applicant: 'Physio-Control Corp.', product_code: 'DXN', decision_date: '1999-09-01', openfda: { device_class: '2' } },
];
const ENFORCEMENT = [
  { recall_number: 'Z-0430-2026', classification: 'Class I', status: 'Ongoing', recall_initiation_date: '20251017', recalling_firm: 'CareFusion 303, Inc.',
    product_description: 'BD Alaris PCU Model 8015', reason_for_recall: 'If dropped the module may be damaged. Inspect before use.', code_info: 'All units' },
];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (!u.startsWith('https://api.fda.gov')) return realFetch(url, opts);
  fdaCalls.push(decodeURIComponent(u));
  if (offline) throw new TypeError('fetch failed');
  const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const search = new URL(u).searchParams.get('search') || '';
  if (u.includes('/device/udi.json')) {
    if (!search.includes('8015')) return new Response('{"error":{"code":"NOT_FOUND"}}', { status: 404 });
    assert.ok(!search.includes('company_name'), 'manufacturer is matched locally, not sent');
    return json({ meta: { results: { total: UDI.length } }, results: UDI });
  }
  if (u.includes('/device/510k.json')) {
    if (!/LIFEPAK 12/i.test(search)) return new Response('{"error":{"code":"NOT_FOUND"}}', { status: 404 });
    return json({ meta: { results: { total: K510.length } }, results: K510 });
  }
  if (u.includes('/device/classification.json')) return json({ meta: { results: { total: 2 } }, results: CLASSIFICATION.filter(c => search.includes(c.product_code)) });
  if (u.includes('/device/enforcement.json')) return json({ meta: { results: { total: 1 } }, results: ENFORCEMENT });
  return new Response('{}', { status: 404 });
};

const { handle, db } = require('../server/server');
let base; let cookie = '';
async function api(method, url, body) {
  const res = await realFetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Libre': '1', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const t = await res.text(); let data; try { data = JSON.parse(t); } catch { data = t; }
  return { status: res.status, data };
}

test('Device Lookup', async (t) => {
  const server = http.createServer(handle);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.close(); db.close(); globalThis.fetch = realFetch; fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal((await api('POST', '/api/setup', { username: 'admin', full_name: 'Admin', password: 'Password123' })).status, 200);
  await api('POST', '/api/auth/login', { username: 'admin', password: 'Password123' });

  await t.test('looks up model number: FDA data + reference suggestions', async () => {
    assert.equal((await api('GET', '/api/device-lookup')).status, 400);
    const r = await api('GET', '/api/device-lookup?model=8015');
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.online, true);
    const c = r.data.candidates[0];
    assert.equal(c.manufacturer, 'Carefusion 303, Inc.');
    assert.equal(c.model, '8015');
    assert.equal(c.variants, 2, 'software versions are grouped');
    assert.equal(c.common_name, 'BD Alaris PCU Module, Model 8015');
    assert.equal(c.fda_product_code, 'FRN');
    assert.equal(c.risk_class, 'Class II');
    assert.equal(c.regulation_number, '880.5725');
    assert.equal(c.category, 'Infusion Pump');
    assert.equal(c.pm_interval_months, 12);
    assert.equal(c.expected_life_years, 8);
    assert.equal(c.criticality, 'High');
    assert.equal(c.equipment, true);
    assert.ok(c.links.some(l => /ecri/.test(l.url)) && c.links.some(l => /aami/.test(l.url)) && c.links.some(l => /FRN/.test(l.url)));
    const dental = r.data.candidates.find(x => x.fda_product_code === 'EBF');
    assert.equal(dental.equipment, false);
    assert.equal(dental.pm_interval_months, null, 'no PM suggestion for consumables');
    assert.equal(r.data.candidates.indexOf(dental) > 0, true, 'equipment listed first');
  });

  await t.test('older model found through FDA 510(k) (no UDI records)', async () => {
    for (const [model, mf] of [['lifepak 12', 'physiocontrol'], ['Lifepak12', ''], ['LIFEPAK 12', 'Stryker']]) {
      const r = await api('GET', '/api/device-lookup?' + new URLSearchParams({ model, manufacturer: mf }));
      assert.equal(r.status, 200, JSON.stringify(r.data));
      const c = r.data.candidates[0];
      assert.ok(c, `${model} / ${mf} found`);
      assert.equal(c.source, '510k');
      assert.equal(c.manufacturer, 'Physio-Control, Inc.', 'latest clearance holder');
      assert.equal(c.model, 'LIFEPAK 12');
      assert.equal(c.risk_class, 'Class III');
      assert.equal(c.fda_product_code, 'MKJ');
      assert.equal(c.category, 'Defibrillator / Monitor');
      assert.equal(c.criticality, 'Life Support');
      assert.equal(c.pm_interval_months, 6);
      assert.match(c.fda_510k, /K102972 \(2010-12-22\)/);
      assert.match(c.note, /510\(k\)/);
      const opt = r.data.candidates.find(x => x.fda_product_code === 'DXN');
      assert.equal(opt.equipment, false, 'option module is not the device');
    }
    const searched = fdaCalls.filter(u => u.includes('/510k.json')).pop();
    assert.match(searched, /LIFEPAK 12/, 'spacing variant searched');
  });

  await t.test('manufacturer filter and caching', async () => {
    const before = fdaCalls.length;
    const r = await api('GET', '/api/device-lookup?model=8015&manufacturer=CareFusion');
    assert.equal(r.data.candidates.length, 1);
    const n = fdaCalls.length - before;
    await api('GET', '/api/device-lookup?model=8015&manufacturer=CareFusion');
    assert.equal(fdaCalls.length - before, n, 'second identical lookup served from cache');
    assert.ok(!fdaCalls.some(u => /api_key/.test(u)));
  });

  let modelId;
  await t.test('apply creates the equipment model, then only fills blanks', async () => {
    const c = (await api('GET', '/api/device-lookup?model=8015&manufacturer=CareFusion')).data.candidates[0];
    const a = await api('POST', '/api/device-lookup/apply', { ...c, lookup_source: 'FDA GUDID' });
    assert.equal(a.status, 200, JSON.stringify(a.data));
    assert.equal(a.data.created, true);
    modelId = a.data.row.id;
    assert.equal(a.data.row.fda_product_code, 'FRN');
    assert.equal(a.data.row.pm_interval_months, 12);
    assert.ok(a.data.row.lookup_at);
    await api('PUT', `/api/e/models/${modelId}`, { pm_interval_months: 6 });
    const again = await api('POST', '/api/device-lookup/apply', { ...c, gmdn_term: 'changed' });
    assert.equal(again.data.created, false);
    assert.equal(again.data.row.pm_interval_months, 6, "user's own value is kept");
    const local = await api('GET', '/api/device-lookup?model=8015');
    assert.equal(local.data.local[0].id, modelId, 'catalog match is shown');
  });

  await t.test('recalls listed and importable', async () => {
    const r = await api('GET', '/api/device-lookup/recalls?model=8015&manufacturer=CareFusion');
    assert.equal(r.data.rows[0].recall_number, 'Z-0430-2026');
    const imp = await api('POST', '/api/device-lookup/recall', { ...r.data.rows[0], model_id: modelId, model: '8015' });
    assert.equal(imp.status, 200, JSON.stringify(imp.data));
    assert.equal(imp.data.row.classification, 'Class I');
    assert.equal(imp.data.row.issued_date, '2025-10-17');
    assert.equal((await api('POST', '/api/device-lookup/recall', r.data.rows[0])).data.created, false, 'no duplicate import');
    assert.equal((await api('GET', '/api/device-lookup/recalls?model=8015&manufacturer=CareFusion')).data.rows[0].already_imported, true);
  });

  await t.test('offline and disabled modes degrade gracefully', async () => {
    offline = true;
    const r = await api('GET', '/api/device-lookup?model=XYZ-1&refresh=1');
    assert.equal(r.status, 200);
    assert.equal(r.data.online, false);
    assert.match(r.data.message, /unreachable/);
    assert.ok(r.data.links.length >= 5);
    offline = false;
    await api('PUT', '/api/settings', { device_lookup_online: '0' });
    const before = fdaCalls.length;
    const d = await api('GET', '/api/device-lookup?model=8015&refresh=1');
    assert.equal(fdaCalls.length, before, 'no internet calls when disabled');
    assert.match(d.data.message, /turned off/);
    assert.equal(d.data.local.length, 1);
  });
});

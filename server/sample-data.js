// Libre CMMS - Copyright (C) 2026 CreativeMed LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// Optional demonstration data, loaded from the first-run setup screen.
// All organizations, manufacturers and people below are fictional.
const crud = require('./lib/crud');
const logic = require('./lib/logic');
const { tx } = require('./db');

function load(db, admin) {
  const ctx = { db, user: admin, ip: 'setup', internal: true };
  const c = (e, d) => crud.create(ctx, e, d);
  const t = crud.today();
  const d = n => logic.addDays(t, n);

  tx(db, () => {
    const fac = c('facilities', { name: 'Riverside General Hospital', code: 'RGH', address: '100 River Rd' });
    const dept = {};
    for (const [n, cc] of [['ICU', '6010'], ['Emergency', '6020'], ['Surgery', '6030'], ['Med-Surg 3W', '6040'], ['Clinical Engineering', '8800']]) {
      dept[n] = c('departments', { name: n, facility_id: fac.id, cost_center: cc }).id;
    }
    const tech1 = c('users', { username: 'mtorres', full_name: 'Morgan Torres', role: 'technician', labor_rate: 48, email: 'mtorres@example.org', skills: 'Infusion, defibrillators, monitoring' });
    const tech2 = c('users', { username: 'achen', full_name: 'Alex Chen', role: 'technician', labor_rate: 52, email: 'achen@example.org', skills: 'Imaging support, ventilators' });
    const teamInf = c('teams', { name: 'Infusion & Monitoring', lead_id: tech1.id, facility_id: fac.id, specialty: 'Infusion pumps, patient monitors, defibrillators', active: 1 });
    const teamCC = c('teams', { name: 'Critical Care Equipment', lead_id: tech2.id, facility_id: fac.id, specialty: 'Ventilators, anesthesia', active: 1 });
    c('team_members', { team_id: teamInf.id, user_id: tech1.id });
    c('team_members', { team_id: teamCC.id, user_id: tech2.id });
    c('team_members', { team_id: teamInf.id, user_id: tech2.id });
    c('certifications', { user_id: tech1.id, name: 'Infusion Pump Service Training', issuer: 'Medivance', obtained_date: d(-700), expires_date: d(30) });
    c('certifications', { user_id: tech2.id, name: 'Ventilator Service Certification', issuer: 'AirLife Systems', obtained_date: d(-200), expires_date: d(530) });

    const vend = c('vendors', { name: 'Medivance Service', vendor_type: 'Manufacturer (OEM)', phone: '555-0100', email: 'service@example.com' });
    const vend2 = c('vendors', { name: 'Tri-County Biomedical Supply', vendor_type: 'Parts Supplier', phone: '555-0150' });
    const contract = c('contracts', { name: 'Ventilator Full Service', contract_number: 'FS-2291', vendor_id: vend.id, contract_type: 'Full Service',
      start_date: d(-300), end_date: d(65), annual_cost: 18500, response_hours: 24, covers_labor: 1, covers_parts: 1, covers_pm: 1 });

    const m = {};
    const models = [
      ['pump', 'Medivance', 'MV-300', 'Large Volume Infusion Pump', 'Infusion Pump', 'Class II', 'High', 12, 8],
      ['defib', 'Cardiowave', 'CW-5', 'Monitor / Defibrillator', 'Defibrillator', 'Class III', 'Life Support', 6, 8],
      ['monitor', 'Vitalis', 'VX-12', 'Bedside Patient Monitor', 'Patient Monitor', 'Class II', 'High', 12, 10],
      ['esu', 'ElectroCut', 'EC-400', 'Electrosurgical Generator', 'Electrosurgical Unit', 'Class II', 'High', 12, 10],
      ['vent', 'AirLife Systems', 'AL-900', 'ICU Ventilator', 'Ventilator', 'Class II', 'Life Support', 6, 10],
      ['esa', 'SafeTest Instruments', 'ST-601', 'Electrical Safety Analyzer', 'Test Equipment', null, 'Low', null, 10],
      ['ipa', 'Generic Test Co', 'IPA-1', 'Infusion Pump Analyzer', 'Test Equipment', null, 'Low', null, 10],
    ];
    for (const [k, mf, mo, desc, cat, rc, crit, pm, life] of models) {
      m[k] = c('models', { manufacturer: mf, model: mo, description: desc, category: cat, risk_class: rc, criticality: crit, pm_interval_months: pm, expected_life_years: life }).id;
    }

    const esa = c('assets', { asset_tag: 'TE-0001', model_id: m.esa, serial_number: 'ES24-1187', status: 'Active', is_test_equipment: 1, cal_due_date: d(120), cal_certificate: 'CAL-55821', facility_id: fac.id, department_id: dept['Clinical Engineering'] });
    const ipa = c('assets', { asset_tag: 'TE-0002', model_id: m.ipa, serial_number: 'IPA-0419', status: 'Active', is_test_equipment: 1, cal_due_date: d(20), facility_id: fac.id, department_id: dept['Clinical Engineering'] });

    // Procedures
    const pumpProc = c('procedures', { code: 'PM-INF-01', name: 'Large Volume Infusion Pump Annual PM', procedure_type: 'Manufacturer', model_id: m.pump, standard: 'OEM Service Manual rev D; IEC 62353', description: 'Annual inspection, electrical safety and performance verification.' });
    const steps = [
      ['Instruction', 'Clean exterior and inspect housing, door, latch and pole clamp for damage.'],
      ['Pass/Fail', 'AC power cord and plug intact; strain relief secure.'],
      ['Measurement', 'Protective earth resistance (IEC 62353)', 'Ohm', null, null, 0.3],
      ['Measurement', 'Equipment leakage current - alternative method', 'uA', null, null, 500],
      ['Measurement', 'Flow rate accuracy at 100 mL/h', 'mL/h', 100, null, null, 5],
      ['Measurement', 'Downstream occlusion alarm pressure', 'psi', 15, 10, 20],
      ['Pass/Fail', 'Air-in-line alarm activates'],
      ['Pass/Fail', 'Battery operates unit for 5 minutes on battery power'],
      ['Text Entry', 'Troubleshooting notes for failed flow test', null, null, null, null, null, 5],
    ];
    steps.forEach(([type, prompt, unit, nominal, lo, hi, tol, onlyIf], i) => c('procedure_steps', {
      procedure_id: pumpProc.id, seq: i + 1, step_type: type, prompt, unit, nominal, lower_limit: lo, upper_limit: hi, tolerance_pct: tol,
      required: onlyIf ? 0 : 1, only_if_step: onlyIf ?? null,
    }));
    crud.update(ctx, 'procedures', pumpProc.id, { status: 'Approved', approved_by: admin.full_name, approved_at: crud.nowIso() });

    const defibProc = c('procedures', { code: 'PM-DEF-01', name: 'Defibrillator Semiannual PM', procedure_type: 'Manufacturer', model_id: m.defib, standard: 'OEM Service Manual; IEC 60601-2-4' });
    [['Pass/Fail', 'Paddles / pads cable and connectors intact'], ['Measurement', 'Delivered energy at 200 J setting', 'J', 200, null, null, 15],
      ['Measurement', 'Charge time to 200 J', 's', null, null, 10], ['Pass/Fail', 'Synchronized cardioversion delivers on R-wave'], ['Pass/Fail', 'Recorder prints correctly']]
      .forEach(([type, prompt, unit, nominal, lo, hi, tol], i) => c('procedure_steps', { procedure_id: defibProc.id, seq: i + 1, step_type: type, prompt, unit, nominal, lower_limit: lo, upper_limit: hi, tolerance_pct: tol, required: 1 }));
    crud.update(ctx, 'procedures', defibProc.id, { status: 'Approved', approved_by: admin.full_name, approved_at: crud.nowIso() });

    // Equipment
    let n = 1;
    const mk = (model, dep, extra = {}) => c('assets', { asset_tag: `RGH-${String(n++).padStart(5, '0')}`, model_id: m[model], serial_number: `SN${100000 + n * 37}`,
      facility_id: fac.id, department_id: dept[dep], status: 'Active', install_date: d(-365 * (2 + (n % 8))), purchase_price: { pump: 3200, defib: 24000, monitor: 15000, esu: 21000, vent: 42000 }[model], ...extra });
    const pumps = [];
    for (let i = 0; i < 6; i++) pumps.push(mk('pump', i < 3 ? 'ICU' : 'Med-Surg 3W', { room: `${300 + i}` }));
    const defibs = [mk('defib', 'Emergency', { room: 'Trauma 1' }), mk('defib', 'ICU', { room: 'Crash cart' })];
    const mons = [mk('monitor', 'ICU', { room: 'Bed 4', ip_address: '10.20.4.14', mac_address: '00:1A:2B:3C:4D:14', os_version: 'Embedded Linux 3.10', firmware_version: '4.2.1', network_segment: 'VLAN 220 Clinical', cyber_risk: 'Medium', patch_status: 'Patch Available' }),
      mk('monitor', 'ICU', { room: 'Bed 5', ip_address: '10.20.4.15', mac_address: '00:1A:2B:3C:4D:15', os_version: 'Embedded Linux 3.10', firmware_version: '4.2.1', network_segment: 'VLAN 220 Clinical', cyber_risk: 'Medium', patch_status: 'Patch Available' })];
    mk('esu', 'Surgery', { room: 'OR 2', warranty_expires: d(200) });
    const vent = mk('vent', 'ICU', { room: 'Bed 6', contract_id: contract.id });

    // PM schedules (some overdue, some coming due)
    pumps.forEach((a, i) => c('pm_schedules', { asset_id: a.id, procedure_id: pumpProc.id, interval_months: 12, next_due: d(-20 + i * 12), assigned_to: tech1.id, program: 'Manufacturer Recommended' }));
    defibs.forEach(a => c('pm_schedules', { asset_id: a.id, procedure_id: defibProc.id, interval_months: 6, next_due: d(5), assigned_to: tech1.id }));
    mons.forEach(a => c('pm_schedules', { asset_id: a.id, interval_months: 24, next_due: d(90), program: 'AEM (Alternative Equipment Maintenance)' }));
    c('pm_schedules', { asset_id: vent.id, interval_months: 6, next_due: d(40), team_id: teamCC.id, notes: 'Performed by vendor under contract' });

    // Parts
    const battery = c('parts', { part_number: 'BAT-MV300', name: 'Battery pack, MV-300 pump', vendor_id: vend2.id, unit_cost: 89.5, min_qty: 4, max_qty: 12, storeroom: 'Biomed Shop', bin: 'A3' });
    c('parts', { part_number: 'CLMP-01', name: 'Pole clamp assembly', vendor_id: vend2.id, unit_cost: 42, min_qty: 2, max_qty: 6, storeroom: 'Biomed Shop', bin: 'A4' });
    logic.adjustStock(ctx, battery.id, { type: 'Receive', quantity: 6, note: 'Initial stock' });

    // Work orders
    const wo = c('work_orders', { type: 'Corrective', asset_id: pumps[1].id, priority: 'High', problem: 'Battery will not hold charge; unit alarms within 2 minutes when unplugged.', requested_by: 'ICU Charge Nurse', assigned_to: tech1.id, due_date: d(2) });
    c('work_orders', { type: 'Corrective', asset_id: defibs[0].id, priority: 'Urgent', problem: 'Printer jams during daily check.', requested_by: 'ED', due_date: d(1) });
    c('service_requests', { problem: 'Monitor in bed 5 shows intermittent SpO2 dropouts', requester_name: 'J. Rivera RN', requester_email: 'jrivera@example.org', department_id: dept.ICU, room: 'Bed 5', asset_id: mons[1].id, urgency: 'High' });
    c('recalls', { recall_number: 'Z-0420-2026', title: 'MV-300 door latch may fail to detect open door', source: 'FDA Recall', classification: 'Class II', issued_date: d(-10),
      manufacturer: 'Medivance', model_id: m.pump, action_required: 'Install latch sensor kit LK-7 per field notice FN-118.', due_date: d(45) });
    c('documents', { title: 'Vitalis VX-12 end-of-support notice', doc_type: 'End of Life / End of Support Letter', model_id: m.monitor, revision: '2026-01' });
    c('documents', { title: 'MV-300 Service Manual', doc_type: 'Service Manual', revision: 'D', model_id: m.pump });
    c('documents', { title: 'Pump alarms within minutes on battery', doc_type: 'Knowledge Article', model_id: m.pump, tags: 'battery alarm MV-300',
      body: 'If the MV-300 alarms "Low Battery" shortly after unplugging, replace battery BAT-MV300 and run the 5-minute battery test. Batteries older than 3 years commonly fail this test.' });
    void wo; void esa; void ipa;
  });
  logic.generatePMs({ db, user: admin, ip: 'setup' });
}

module.exports = { load };

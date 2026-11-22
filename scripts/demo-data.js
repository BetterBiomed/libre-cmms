#!/usr/bin/env node
// Libre CMMS - Copyright (C) 2026 CreativeMed LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
// Generates a fully populated DEMONSTRATION database: 3 facilities, 26 departments
// with 50+ department-appropriate assets each, 12 months of PM and repair history,
// test records, service requests, recalls, inventories, Unable To Locate, contracts,
// parts, teams and users. All organizations, people, manufacturers, models, recalls
// and events are FICTIONAL.
//
//   LIBRE_DATA_DIR=<dir> node scripts/demo-data.js [seed]
// The data directory must be empty (build-demo.js takes care of that).
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const dbm = require('../server/db');
const crud = require('../server/lib/crud');
const logic = require('../server/lib/logic');
const auth = require('../server/lib/auth');
const inventory = require('../server/lib/inventory');

const DATA_DIR = path.resolve(process.env.LIBRE_DATA_DIR || path.join(__dirname, '..', 'data'));
const SEED = Number(process.argv[2]) || 20261121;
const DEMO_PASSWORD = 'LibreDemo2026';

// ---------------- deterministic random ----------------
let s = SEED >>> 0;
const rnd = () => { s += 0x6D2B79F5; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const rf = (a, b) => a + rnd() * (b - a);
const pick = arr => arr[Math.floor(rnd() * arr.length)];
const chance = p => rnd() < p;
const round2 = x => Math.round(x * 100) / 100;

// ---------------- dates ----------------
const NOW = new Date();
const TODAY = NOW.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const addMonths = (d, m) => logic.addMonths(d, m);
const at = (date, hour = 9, min = 0) => new Date(`${date}T${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:00`).toISOString();
const plusHours = (iso, h) => new Date(Date.parse(iso) + h * 3600e3).toISOString();
const minDate = (a, b) => (a < b ? a : b);
const iso = () => new Date().toISOString();

// ---------------- catalog (fictional) ----------------
// key: [manufacturer, model, device type, FDA class, criticality, PM months, life yrs, price, procedure, cyber]
const MODELS = {
  lvp: ['Medivra', 'MV-300', 'Infusion Pump', 'Class II', 'High', 12, 8, 3200, 'PM-INF-01', 'pump'],
  lvp_old: ['Medivra', 'MV-200', 'Infusion Pump', 'Class II', 'High', 12, 8, 2900, 'PM-INF-01', 'pump'],
  syringe: ['Medivra', 'MV-SP2', 'Syringe Pump', 'Class II', 'High', 12, 8, 2800, 'PM-INF-01', 'pump'],
  pca: ['Medivra', 'PCA-7', 'PCA Pump', 'Class II', 'High', 12, 8, 3900, 'PM-INF-01', 'pump'],
  enteral: ['Nutrilink', 'EF-200', 'Enteral Feeding Pump', 'Class II', 'Medium', 12, 7, 1200, 'ES-GEN-01', null],
  monitor: ['Vitalyn', 'VX-12', 'Patient Monitor', 'Class II', 'High', 12, 8, 15000, 'PM-MON-01', 'monitor'],
  monitor_old: ['Vitalyn', 'VX-8', 'Patient Monitor', 'Class II', 'High', 12, 8, 9800, 'PM-MON-01', 'monitor'],
  transport_mon: ['Vitalyn', 'VX-T4', 'Patient Monitor', 'Class II', 'High', 12, 8, 8200, 'PM-MON-01', 'monitor'],
  central: ['Vitalyn', 'CentralView CS-2', 'Telemetry System', 'Class II', 'High', 12, 7, 25000, 'ES-GEN-01', 'server'],
  telemetry: ['Cardiotrace', 'TX-4', 'Telemetry System', 'Class II', 'High', 12, 8, 2500, null, null],
  spot: ['Vitalyn', 'SpotCheck V3', 'NIBP Monitor', 'Class II', 'Medium', 12, 7, 3100, 'PM-MON-01', null],
  oximeter: ['Vitalyn', 'OX-1', 'Pulse Oximeter', 'Class II', 'Medium', 12, 7, 900, null, null],
  defib: ['Cardiowave', 'CW-5', 'Defibrillator / Monitor', 'Class III', 'Life Support', 6, 8, 24000, 'PM-DEF-01', null],
  aed: ['Cardiowave', 'CW-AED2', 'Defibrillator / Monitor', 'Class III', 'Life Support', 12, 8, 1800, 'PM-DEF-01', null],
  vent: ['Ventara', 'AV-900', 'Ventilator', 'Class II', 'Life Support', 6, 10, 42000, 'PM-VEN-01', 'vent'],
  tvent: ['Ventara', 'TV-300', 'Ventilator', 'Class II', 'Life Support', 6, 10, 14000, 'PM-VEN-01', null],
  bipap: ['Ventara', 'NIV-60', 'CPAP / BiPAP', 'Class II', 'High', 12, 7, 9000, 'ES-GEN-01', null],
  anesthesia: ['Novasthesia', 'NA-7', 'Anesthesia Machine', 'Class II', 'Life Support', 6, 12, 65000, 'ES-GEN-01', 'vent'],
  esu: ['Coagent Surgical', 'CG-400', 'Electrosurgical Unit', 'Class II', 'High', 6, 10, 21000, 'PM-ESU-01', null],
  orlight: ['Brightfield Surgical', 'BF-LED2', 'Surgical Light', 'Class II', 'Medium', 12, 15, 28000, null, null],
  ortable: ['Mobilis Patient Care', 'OT-500', 'Surgical Table', 'Class I', 'Medium', 12, 15, 45000, null, null],
  scd: ['Circulex', 'SC-3', 'Sequential Compression Device', 'Class II', 'Low', 12, 7, 1500, 'ES-GEN-01', null],
  hypo: ['Thermalyn', 'TH-20', 'Hypo/Hyperthermia Unit', 'Class II', 'High', 6, 8, 18000, 'ES-GEN-01', null],
  fluidwarm: ['Thermalyn', 'FW-1', 'Blood / Fluid Warmer', 'Class II', 'High', 12, 8, 3000, 'ES-GEN-01', null],
  tourniquet: ['Tourniq', 'PT-2', 'Pneumatic Tourniquet', 'Class II', 'High', 6, 8, 6000, null, null],
  vidproc: ['Endovista', 'EV-190', 'Endoscopy Equipment', 'Class II', 'Medium', 12, 7, 38000, 'ES-GEN-01', null],
  lightsrc: ['Endovista', 'LS-300', 'Endoscopy Equipment', 'Class II', 'Medium', 12, 7, 12000, 'ES-GEN-01', null],
  scope: ['Endovista', 'GF-1', 'Endoscopy Equipment', 'Class II', 'Medium', 12, 7, 30000, null, null],
  dr: ['Lumora Imaging', 'DR-600', 'X-ray / Radiographic', 'Class II', 'High', 6, 10, 180000, null, 'imaging'],
  mobilexr: ['Lumora Imaging', 'MC-9', 'X-ray / Radiographic', 'Class II', 'High', 6, 10, 95000, null, 'imaging'],
  carm: ['Lumora Imaging', 'CA-200', 'X-ray / Radiographic', 'Class II', 'High', 6, 10, 160000, null, 'imaging'],
  ct: ['Lumora Imaging', 'CT-64', 'CT Scanner', 'Class II', 'High', 3, 10, 900000, null, 'imaging'],
  us: ['Echoline', 'EU-7', 'Ultrasound Scanner', 'Class II', 'Medium', 12, 7, 65000, 'ES-GEN-01', 'imaging'],
  bladder: ['Echoline', 'BS-3', 'Bladder Scanner', 'Class II', 'Low', 12, 7, 9000, null, null],
  chem: ['Labrion', 'CX-50', 'Laboratory Analyzer', 'Class I', 'Medium', 6, 7, 120000, null, 'lab'],
  heme: ['Labrion', 'HX-20', 'Laboratory Analyzer', 'Class I', 'Medium', 6, 7, 60000, null, 'lab'],
  bloodgas: ['Labrion', 'BG-9', 'Laboratory Analyzer', 'Class II', 'High', 6, 7, 35000, null, 'lab'],
  coag: ['Labrion', 'CG-3', 'Laboratory Analyzer', 'Class II', 'Medium', 6, 7, 28000, null, 'lab'],
  centrifuge: ['Labrion', 'CF-12', 'Laboratory Centrifuge', 'Class I', 'Low', 12, 10, 4000, 'ES-GEN-01', null],
  labfridge: ['Frostline Scientific', 'MR-25', 'Medical Refrigerator / Freezer', 'Class I', 'Medium', 12, 10, 6000, null, null],
  suction: ['Breathline', 'SU-1', 'Suction / Aspirator', 'Class II', 'Medium', 12, 8, 320, null, null],
  flowmeter: ['Breathline', 'FM-15', 'Flowmeter / Regulator', 'Class I', 'Low', 24, 10, 150, null, null],
  o2conc: ['Breathline', 'OC-5', 'Oxygen Concentrator', 'Class II', 'Medium', 12, 5, 1500, null, null],
  incubator: ['Cradlewell', 'CI-4', 'Infant Incubator', 'Class II', 'High', 6, 10, 32000, 'ES-GEN-01', null],
  warmer: ['Cradlewell', 'RW-2', 'Infant Warmer', 'Class II', 'High', 6, 10, 18000, 'ES-GEN-01', null],
  photo: ['Cradlewell', 'PT-1', 'Phototherapy Unit', 'Class II', 'Medium', 12, 8, 7000, null, null],
  fetal: ['Cradlewell', 'FM-50', 'Fetal Monitor', 'Class II', 'High', 12, 8, 22000, 'ES-GEN-01', 'monitor'],
  dialysis: ['Nephrona', 'RX-5008', 'Hemodialysis System', 'Class II', 'Life Support', 6, 7, 28000, 'ES-GEN-01', null],
  ro: ['Nephrona', 'RO-2', 'Hemodialysis System', 'Class II', 'High', 3, 12, 45000, null, null],
  bed: ['Mobilis Patient Care', 'HB-900', 'Hospital Bed / Stretcher', 'Class II', 'Low', 12, 10, 12000, null, null],
  stretcher: ['Mobilis Patient Care', 'ST-5', 'Hospital Bed / Stretcher', 'Class I', 'Low', 12, 10, 8000, null, null],
  lift: ['Mobilis Patient Care', 'PL-400', 'Patient Lift', 'Class II', 'Low', 6, 10, 4000, null, null],
  ecg: ['Cardiotrace', 'EC-12', 'Electrocardiograph', 'Class II', 'Medium', 12, 8, 9000, 'ES-GEN-01', 'monitor'],
  stress: ['Cardiotrace', 'ST-500', 'Electrocardiograph', 'Class II', 'Medium', 12, 8, 35000, 'ES-GEN-01', 'monitor'],
  hemo: ['Cardiotrace', 'HL-9', 'Patient Monitor', 'Class II', 'High', 12, 8, 120000, 'ES-GEN-01', 'monitor'],
  thermometer: ['Tempra', 'TT-1', 'Thermometer', 'Class II', 'Low', 12, 5, 250, null, null],
  scale: ['Mobilis Patient Care', 'SC-2', 'Scale', 'Class I', 'Low', 12, 10, 2000, null, null],
  blanketwarm: ['Thermalyn', 'BW-6', 'Blanket / Solution Warming Cabinet', 'Class II', 'Low', 12, 12, 7000, null, null],
  steam: ['Steriforge', 'SF-1200', 'Sterilizer', 'Class II', 'High', 3, 15, 110000, null, null],
  lowtemp: ['Steriforge', 'LT-2', 'Sterilizer', 'Class II', 'High', 3, 12, 90000, null, null],
  washer: ['Steriforge', 'WD-4', 'Washer-Disinfector', 'Class II', 'Medium', 6, 12, 60000, null, null],
  ultrasonic: ['Steriforge', 'UC-10', 'Ultrasonic Cleaner', 'Class I', 'Low', 12, 10, 9000, null, null],
  // test equipment
  esa: ['SafeTest Instruments', 'ST-601', 'Electrical Safety Analyzer', null, 'Low', 12, 10, 6500, null, null],
  ipa: ['SafeTest Instruments', 'IPA-1', 'Infusion Pump Analyzer', null, 'Low', 12, 10, 9500, null, null],
  da: ['SafeTest Instruments', 'DA-3', 'Defibrillator Analyzer', null, 'Low', 12, 10, 8800, null, null],
  ps: ['SafeTest Instruments', 'PS-8', 'Patient Simulator', null, 'Low', 12, 10, 5200, null, null],
  esuan: ['SafeTest Instruments', 'ESU-5', 'ESU Analyzer', null, 'Low', 12, 10, 9900, null, null],
  vanl: ['SafeTest Instruments', 'VA-2', 'Gas Flow / Ventilator Analyzer', null, 'Low', 12, 10, 14500, null, null],
  nibpa: ['SafeTest Instruments', 'NB-1', 'NIBP Analyzer', null, 'Low', 12, 10, 4800, null, null],
};
const TEST_EQUIP = ['esa', 'ipa', 'da', 'ps', 'esuan', 'vanl', 'nibpa'];

// Department templates: model key -> typical count.
const DEPT_KINDS = {
  ED: { lvp: 22, syringe: 3, monitor: 20, transport_mon: 4, central: 1, defib: 4, spot: 6, ecg: 2, suction: 16, flowmeter: 18, stretcher: 14, thermometer: 6, fluidwarm: 2, bladder: 1, us: 1, tvent: 1, bipap: 2, scale: 2, oximeter: 4, telemetry: 6 },
  ICU: { lvp: 40, syringe: 12, pca: 4, monitor: 24, central: 2, defib: 3, vent: 12, bipap: 3, suction: 24, flowmeter: 24, bed: 24, hypo: 2, scd: 12, fluidwarm: 2, ecg: 1, bladder: 1, enteral: 6, lift: 2, oximeter: 4 },
  OR: { anesthesia: 10, esu: 10, orlight: 10, ortable: 10, monitor: 10, lvp: 12, syringe: 6, scd: 10, fluidwarm: 6, tourniquet: 4, suction: 20, carm: 2, defib: 2, hypo: 2, blanketwarm: 3 },
  PACU: { monitor: 16, lvp: 16, pca: 4, stretcher: 16, suction: 16, flowmeter: 16, defib: 1, bipap: 1, fluidwarm: 2, blanketwarm: 2, oximeter: 4, thermometer: 2 },
  MEDSURG: { lvp: 34, pca: 6, enteral: 4, spot: 8, telemetry: 12, central: 1, bed: 32, suction: 10, flowmeter: 12, scd: 10, lift: 2, defib: 1, bladder: 1, scale: 2, thermometer: 6, monitor_old: 4, lvp_old: 6 },
  LD: { fetal: 14, lvp: 14, warmer: 6, monitor: 6, bed: 14, suction: 12, flowmeter: 12, defib: 1, us: 1, scale: 3, photo: 2, fluidwarm: 1 },
  NICU: { incubator: 18, warmer: 8, photo: 6, monitor: 20, syringe: 20, lvp: 4, vent: 6, bipap: 2, suction: 10, flowmeter: 10, defib: 1, scale: 3 },
  CARDIO: { hemo: 3, carm: 2, defib: 4, ecg: 8, stress: 3, monitor: 12, lvp: 10, us: 2, stretcher: 8, suction: 6, flowmeter: 6, telemetry: 10 },
  RAD: { dr: 4, mobilexr: 4, ct: 2, carm: 2, us: 6, monitor: 6, lvp: 6, defib: 2, stretcher: 10, suction: 8, flowmeter: 8, lift: 1 },
  LAB: { chem: 4, heme: 4, bloodgas: 3, coag: 3, centrifuge: 14, labfridge: 16, thermometer: 8, us: 0, scale: 2 },
  DIAL: { dialysis: 24, ro: 2, monitor: 6, lvp: 6, defib: 1, suction: 6, flowmeter: 6, stretcher: 4, scale: 2, bed: 6 },
  CE: { esa: 4, ipa: 3, da: 2, ps: 3, esuan: 2, vanl: 2, nibpa: 2, lvp: 14, syringe: 4, monitor: 6, transport_mon: 2, defib: 2, suction: 6, spot: 2, scd: 4 },
  SPD: { steam: 4, lowtemp: 2, washer: 4, ultrasonic: 3, labfridge: 2, scale: 2, flowmeter: 0, blanketwarm: 2, thermometer: 2 },
  PREOP: { monitor: 20, lvp: 18, stretcher: 20, suction: 14, flowmeter: 14, spot: 4, defib: 2, fluidwarm: 2, blanketwarm: 2, oximeter: 4 },
  ENDO: { vidproc: 6, lightsrc: 6, scope: 24, monitor: 6, suction: 8, flowmeter: 8, esu: 2, stretcher: 6, defib: 1, ultrasonic: 1 },
  INFUSION: { lvp: 30, pca: 2, syringe: 4, spot: 6, monitor: 4, defib: 1, suction: 4, flowmeter: 6, scale: 2, thermometer: 4, labfridge: 2 },
};
// Fillers used to reach 50 if a template comes out short.
const FILLERS = ['flowmeter', 'suction', 'thermometer', 'spot', 'lvp'];

const FACILITIES = [
  { name: 'Riverside Regional Medical Center', code: 'RRMC', address: '1200 River Parkway, Riverside', phone: '555-0100', depts: [
    ['Emergency Department', 'ED', '6010', 'Main', '1'], ['Intensive Care Unit', 'ICU', '6020', 'Tower A', '4'], ['Operating Room', 'OR', '6030', 'Main', '2'],
    ['PACU', 'PACU', '6031', 'Main', '2'], ['Medical-Surgical 5 West', 'MEDSURG', '6040', 'Tower A', '5'], ['Labor & Delivery', 'LD', '6050', 'Tower B', '3'],
    ['Neonatal ICU', 'NICU', '6051', 'Tower B', '3'], ['Cardiology & Cath Lab', 'CARDIO', '6060', 'Heart Center', '1'], ['Radiology & Imaging', 'RAD', '6070', 'Main', 'G'],
    ['Laboratory', 'LAB', '6080', 'Main', 'G'], ['Dialysis Unit', 'DIAL', '6090', 'Tower A', '2'], ['Sterile Processing', 'SPD', '6100', 'Main', 'B'],
    ['Clinical Engineering', 'CE', '8800', 'Main', 'B']] },
  { name: 'Lakeside Community Hospital', code: 'LCH', address: '45 Shoreline Drive, Lakeside', phone: '555-0200', depts: [
    ['Emergency Department', 'ED', '7010', 'Main', '1'], ['Intensive Care Unit', 'ICU', '7020', 'Main', '3'], ['Operating Room', 'OR', '7030', 'Main', '2'],
    ['Medical-Surgical', 'MEDSURG', '7040', 'Main', '3'], ['Labor & Delivery', 'LD', '7050', 'Main', '2'], ['Radiology', 'RAD', '7070', 'Main', '1'],
    ['Laboratory', 'LAB', '7080', 'Main', '1']] },
  { name: 'Northgate Surgery & Outpatient Center', code: 'NSOC', address: '900 Northgate Blvd, Northgate', phone: '555-0300', depts: [
    ['Pre-Op / PACU', 'PREOP', '9010', 'Surgery', '1'], ['Operating Rooms', 'OR', '9030', 'Surgery', '1'], ['Endoscopy', 'ENDO', '9040', 'Surgery', '1'],
    ['Infusion Center', 'INFUSION', '9050', 'Clinic', '2'], ['Imaging', 'RAD', '9070', 'Clinic', '1'], ['Sterile Processing', 'SPD', '9100', 'Surgery', 'B']] },
];

const PEOPLE = [
  // username, name, role, facility index, title, rate, skills
  ['demo', 'Demo Administrator', 'admin', 0, 'CMMS Administrator', 55, 'Administration'],
  ['jreyes', 'Jordan Reyes', 'supervisor', 0, 'Clinical Engineering Manager', 62, 'Program management, regulatory, imaging contracts'],
  ['pnguyen', 'Priya Nguyen', 'supervisor', 1, 'Biomed Supervisor', 58, 'Critical care, anesthesia'],
  ['mtorres', 'Morgan Torres', 'technician', 0, 'BMET III', 52, 'Infusion, defibrillators, monitoring'],
  ['achen', 'Alex Chen', 'technician', 0, 'BMET II', 47, 'Ventilators, anesthesia, critical care'],
  ['sokafor', 'Sam Okafor', 'technician', 0, 'Imaging Specialist', 60, 'X-ray, CT, C-arm, ultrasound'],
  ['rpatel', 'Riley Patel', 'technician', 0, 'BMET II', 46, 'Lab, sterilizers, dialysis'],
  ['tbrooks', 'Taylor Brooks', 'technician', 1, 'BMET II', 45, 'General biomed, OR'],
  ['dkim', 'Dana Kim', 'technician', 1, 'BMET I', 39, 'Beds, suction, general'],
  ['cwhite', 'Casey White', 'technician', 2, 'BMET II', 48, 'Endoscopy, surgical, infusion'],
  ['lgarcia', 'Logan Garcia', 'technician', 2, 'BMET I', 40, 'Sterile processing equipment, general'],
  ['nurse.ed', 'Avery Lopez RN', 'requester', 0, 'ED Charge Nurse', null, null],
  ['cfo', 'Quinn Harper', 'viewer', 0, 'VP Finance', null, null],
];

const PROCEDURES = {
  'PM-INF-01': { name: 'Infusion Pump PM and Performance Verification', type: 'Manufacturer', standard: 'OEM service manual; IEC 62353', steps: [
    ['Instruction', 'Clean and inspect housing, door, latch, pole clamp, power cord and labels.'],
    ['Measurement', 'Protective earth resistance', 'Ohm', null, null, 0.3],
    ['Measurement', 'Equipment leakage current', 'uA', null, null, 500],
    ['Measurement', 'Flow rate accuracy at 100 mL/h', 'mL/h', 100, null, null, 5],
    ['Measurement', 'Downstream occlusion pressure', 'psi', 15, 10, 20],
    ['Pass/Fail', 'Air-in-line alarm'], ['Pass/Fail', 'Battery runs pump 5 minutes unplugged'],
    ['Text Entry', 'Troubleshooting notes for failed flow test', null, null, null, null, null, 4]] },
  'PM-DEF-01': { name: 'Defibrillator Performance Verification', type: 'Manufacturer', standard: 'OEM service manual; IEC 60601-2-4', steps: [
    ['Pass/Fail', 'Inspect paddles/pads cable, connectors and case'], ['Measurement', 'Delivered energy at 200 J', 'J', 200, null, null, 15],
    ['Measurement', 'Charge time to 200 J', 's', null, null, 10], ['Pass/Fail', 'Synchronized cardioversion'], ['Pass/Fail', 'ECG display and recorder'],
    ['Measurement', 'Pacing output at 70 mA', 'mA', 70, null, null, 10]] },
  'PM-MON-01': { name: 'Patient Monitor PM', type: 'Manufacturer', standard: 'OEM service manual', steps: [
    ['Instruction', 'Clean and inspect mount, cables and accessories'], ['Measurement', 'ECG heart rate at 80 bpm', 'bpm', 80, null, null, 2.5],
    ['Measurement', 'NIBP static pressure at 200 mmHg', 'mmHg', 200, 197, 203], ['Measurement', 'SpO2 at 97% simulated', '%', 97, 95, 99],
    ['Measurement', 'Temperature at 37.0 C', 'C', 37, 36.9, 37.1], ['Pass/Fail', 'Alarms audible and visual'], ['Measurement', 'Equipment leakage current', 'uA', null, null, 500]] },
  'PM-VEN-01': { name: 'Ventilator Performance Verification', type: 'Manufacturer', standard: 'OEM service manual', steps: [
    ['Pass/Fail', 'Run self-test / extended self-test'], ['Measurement', 'Tidal volume at 500 mL', 'mL', 500, null, null, 10],
    ['Measurement', 'PEEP at 5 cmH2O', 'cmH2O', 5, 4, 6], ['Measurement', 'FiO2 at 60%', '%', 60, 57, 63], ['Pass/Fail', 'High pressure and disconnect alarms'],
    ['Pass/Fail', 'Battery backup'], ['Measurement', 'Protective earth resistance', 'Ohm', null, null, 0.3]] },
  'PM-ESU-01': { name: 'Electrosurgical Unit PM', type: 'Manufacturer', standard: 'OEM service manual; IEC 60601-2-2', steps: [
    ['Pass/Fail', 'Inspect footswitch, cords, return electrode monitoring'], ['Measurement', 'Cut output at 100 W into 300 ohm', 'W', 100, null, null, 20],
    ['Measurement', 'Coag output at 50 W into 300 ohm', 'W', 50, null, null, 20], ['Measurement', 'HF leakage', 'mA', null, null, 150], ['Pass/Fail', 'REM / return electrode alarm']] },
  'ES-GEN-01': { name: 'General Electrical Safety and Functional Inspection', type: 'Electrical Safety', standard: 'IEC 62353 / NFPA 99', steps: [
    ['Instruction', 'Visual inspection: housing, cord, plug, labels, controls'], ['Measurement', 'Protective earth resistance', 'Ohm', null, null, 0.3],
    ['Measurement', 'Equipment leakage current', 'uA', null, null, 500], ['Pass/Fail', 'Functional check per operator manual']] },
};

const PARTS = [
  ['BAT-MV300', 'Battery pack, MV-300/MV-200 pump', 89.5, ['lvp', 'lvp_old', 'syringe', 'pca']], ['DOOR-MV300', 'Door assembly, MV-300', 145, ['lvp']],
  ['CLMP-01', 'Pole clamp assembly', 42, ['lvp', 'lvp_old', 'syringe', 'pca', 'enteral']], ['ECG-5LD', 'ECG trunk cable, 5-lead', 118, ['monitor', 'monitor_old', 'transport_mon', 'telemetry', 'ecg']],
  ['SPO2-SNS', 'SpO2 sensor, reusable adult', 165, ['monitor', 'monitor_old', 'transport_mon', 'spot', 'oximeter']], ['NIBP-HOSE', 'NIBP hose, 3 m', 38, ['monitor', 'monitor_old', 'spot']],
  ['NIBP-CUFF', 'NIBP cuff, adult reusable', 22, ['monitor', 'monitor_old', 'spot']], ['BAT-CW5', 'Battery, CW-5 defibrillator', 310, ['defib']],
  ['PAD-CW5', 'Therapy cable, CW-5', 260, ['defib', 'aed']], ['FLT-AV900', 'Exhalation filter kit, AV-900', 64, ['vent', 'tvent']], ['O2-CELL', 'Oxygen sensor cell', 129, ['vent', 'anesthesia', 'bipap']],
  ['FS-CG400', 'Footswitch, CG-400 ESU', 410, ['esu']], ['CSTR-01', 'Caster, 5 in. locking', 36, ['bed', 'stretcher', 'lift', 'ortable']],
  ['HSET-HB900', 'Hand control pendant, HB-900 bed', 175, ['bed']], ['MTR-ACT', 'Actuator motor, bed/stretcher', 395, ['bed', 'stretcher', 'ortable']],
  ['REG-SU1', 'Suction regulator gauge', 58, ['suction']], ['FM-REB', 'Flowmeter rebuild kit', 19, ['flowmeter']], ['TRX-TX4', 'Telemetry transmitter battery door', 24, ['telemetry']],
  ['PRB-TT1', 'Thermometer probe', 49, ['thermometer']], ['HTR-CI4', 'Heater element, CI-4 incubator', 285, ['incubator', 'warmer']], ['FAN-CI4', 'Fan assembly, CI-4', 96, ['incubator']],
  ['TRN-FM50', 'Toco transducer, FM-50', 520, ['fetal']], ['USX-FM50', 'Ultrasound transducer, FM-50', 640, ['fetal']], ['PMP-RX5008', 'Blood pump rotor, RX-5008', 220, ['dialysis']],
  ['CND-RX5008', 'Conductivity cell, RX-5008', 340, ['dialysis']], ['GSKT-SF1200', 'Door gasket, SF-1200 sterilizer', 480, ['steam', 'lowtemp']],
  ['VLV-SF1200', 'Steam solenoid valve', 315, ['steam']], ['PMP-WD4', 'Circulation pump, WD-4 washer', 690, ['washer']], ['LMP-LS300', 'Lamp module, LS-300', 410, ['lightsrc']],
  ['CBL-EV190', 'Video cable, EV-190', 230, ['vidproc', 'scope']], ['BAT-SPOT', 'Battery, SpotCheck V3', 72, ['spot']], ['FUSE-KIT', 'Assorted medical-grade fuses', 12, ['*']],
  ['PWR-CORD', 'Hospital-grade power cord', 28, ['*']], ['KNOB-KIT', 'Control knob kit', 15, ['*']],
];

const FAILURES = {
  default: [['Electrical Failure', 'Normal Wear', 'Replaced Part'], ['Physical Damage', 'Abuse / Damage', 'Replaced Part'], ['No Problem Found', 'User Error', 'User Trained'],
    ['Accessory / Cable', 'Normal Wear', 'Replaced Part'], ['Mechanical Failure', 'Normal Wear', 'Repaired']],
  pump: [['Battery', 'Normal Wear', 'Replaced Part', 'Battery will not hold charge; low battery alarm shortly after unplugging.'], ['Alarm Failure', 'Design Defect', 'Software Updated', 'Intermittent door-open alarm during infusion.'],
    ['Physical Damage', 'Abuse / Damage', 'Replaced Part', 'Pump dropped; cracked door and pole clamp loose.'], ['No Problem Found', 'User Error', 'User Trained', 'Occlusion alarm reported; unable to duplicate, staff in-serviced.'],
    ['Mechanical Failure', 'Normal Wear', 'Repaired', 'Air-in-line alarm with no air present.']],
  monitor: [['Accessory / Cable', 'Normal Wear', 'Replaced Part', 'ECG leads intermittent; noisy tracing.'], ['Display', 'Normal Wear', 'Replaced Part', 'Display flickering and dim.'],
    ['Network / Connectivity', 'Environmental', 'Adjusted / Calibrated', 'Monitor dropping off central station.'], ['No Problem Found', 'User Error', 'User Trained', 'SpO2 reading low; sensor applied incorrectly.'],
    ['Calibration Drift', 'Normal Wear', 'Adjusted / Calibrated', 'NIBP readings inconsistent with manual cuff.']],
  imaging: [['Software / Firmware', 'Design Defect', 'Software Updated', 'System hangs during image acquisition.'], ['Electrical Failure', 'Normal Wear', 'Sent to Vendor', 'Generator fault error on exposure.'],
    ['Mechanical Failure', 'Normal Wear', 'Repaired', 'Collimator / detector positioning fault.'], ['Network / Connectivity', 'Environmental', 'Adjusted / Calibrated', 'Images not sending to PACS.']],
  lab: [['Calibration Drift', 'Normal Wear', 'Adjusted / Calibrated', 'QC out of range on two levels.'], ['Mechanical Failure', 'Normal Wear', 'Sent to Vendor', 'Sample probe crash error.'],
    ['Leak', 'Normal Wear', 'Replaced Part', 'Reagent line leak under analyzer.'], ['Software / Firmware', 'Design Defect', 'Software Updated', 'LIS interface not transmitting results.']],
  bed: [['Mechanical Failure', 'Normal Wear', 'Replaced Part', 'Bed will not raise; actuator noisy.'], ['Physical Damage', 'Abuse / Damage', 'Replaced Part', 'Side rail latch broken.'],
    ['Electrical Failure', 'Normal Wear', 'Replaced Part', 'Hand pendant inoperative.'], ['Mechanical Failure', 'Normal Wear', 'Repaired', 'Brake not locking.']],
  vent: [['Alarm Failure', 'Normal Wear', 'Replaced Part', 'O2 sensor alarm; FiO2 reading low.'], ['Leak', 'Normal Wear', 'Replaced Part', 'Fails leak test at self-test.'],
    ['Software / Firmware', 'Design Defect', 'Software Updated', 'Intermittent technical fault code.']],
  sterilizer: [['Leak', 'Normal Wear', 'Replaced Part', 'Door gasket leaking steam; cycle aborts.'], ['Mechanical Failure', 'Normal Wear', 'Replaced Part', 'Chamber not reaching temperature.'],
    ['Electrical Failure', 'Normal Wear', 'Repaired', 'Printer / controller fault.']],
};
const FAIL_GROUP = { lvp: 'pump', lvp_old: 'pump', syringe: 'pump', pca: 'pump', enteral: 'pump', monitor: 'monitor', monitor_old: 'monitor', transport_mon: 'monitor', spot: 'monitor',
  telemetry: 'monitor', central: 'monitor', fetal: 'monitor', ecg: 'monitor', stress: 'monitor', hemo: 'monitor', dr: 'imaging', mobilexr: 'imaging', carm: 'imaging', ct: 'imaging', us: 'imaging',
  chem: 'lab', heme: 'lab', bloodgas: 'lab', coag: 'lab', bed: 'bed', stretcher: 'bed', ortable: 'bed', lift: 'bed', vent: 'vent', tvent: 'vent', anesthesia: 'vent', bipap: 'vent',
  steam: 'sterilizer', lowtemp: 'sterilizer', washer: 'sterilizer' };
// Expected repairs per asset per year.
// Per-model overrides of the group rate.
const RATE_OVERRIDE = { us: 0.4, bladder: 0.2, centrifuge: 0.15, labfridge: 0.2 };
const FAIL_RATE = { pump: 0.35, monitor: 0.22, imaging: 1.6, lab: 1.4, bed: 0.3, vent: 0.45, sterilizer: 1.2, default: 0.12 };
const VENDOR_SERVICED = new Set(['dr', 'mobilexr', 'carm', 'ct', 'chem', 'heme', 'bloodgas', 'coag', 'steam', 'lowtemp', 'washer']);

// ======================================================================
function main() {
  if (fs.existsSync(path.join(DATA_DIR, 'libre.db'))) {
    console.error(`Refusing to overwrite ${path.join(DATA_DIR, 'libre.db')}. Delete the data folder first (build-demo.js does this).`);
    process.exit(1);
  }
  const t0 = Date.now();
  const db = dbm.open(DATA_DIR);
  const stamp = iso();
  const ins = (table, obj) => crud.insertRow(db, table, { created_at: stamp, updated_at: stamp, created_by: 'demo', updated_by: 'demo', ...obj });
  // Document numbers for the year the record belongs to, sharing Libre's counters so
  // numbers created later by the application continue the sequence.
  const num = (prefix, date, pad) => {
    const k = `${prefix}-${String(date).slice(0, 4)}`;
    db.prepare('INSERT INTO counters (name, value) VALUES (?, 0) ON CONFLICT(name) DO NOTHING').run(k);
    db.prepare('UPDATE counters SET value = value + 1 WHERE name = ?').run(k);
    return `${k}-${String(db.prepare('SELECT value FROM counters WHERE name = ?').get(k).value).padStart(pad, '0')}`;
  };
  let summary;
  dbm.tx(db, () => {

  // ---------------- settings ----------------
  for (const [k, v] of Object.entries({ org_name: 'Libre Demo Health System', portal_enabled: '1', portal_message: 'DEMO SYSTEM - fictional data. For emergencies call Clinical Engineering at x4500.',
    sla_emergency_hours: '1', sla_urgent_hours: '4', sla_high_hours: '24', label_code: 'qr', label_qr_content: 'url', label_size: 'standard', device_lookup_online: '1', demo_built_at: stamp, demo_seed: String(SEED) })) dbm.setSetting(db, k, v);

  const DEPT_MANAGERS = ['Dana Whitfield', 'Marcus Okafor', 'Priya Raman', 'Helen Brooks', 'Tomas Alvarez', 'Grace Kim', 'Samuel Ortiz', 'Nora Lindqvist', 'Victor Hale', 'Aisha Mensah', 'Paul Duquesne', 'Leah Abrams', 'Owen Fitzgerald'];
  // ---------------- facilities & departments ----------------
  const facilities = []; const departments = [];
  for (const F of FACILITIES) {
    const fid = ins('facilities', { name: F.name, code: F.code, address: F.address, phone: F.phone });
    facilities.push({ ...F, id: fid });
    for (const [name, kind, cc, building, floor] of F.depts) {
      const mgr = DEPT_MANAGERS[departments.length % DEPT_MANAGERS.length];
      // Every 7th department has no manager email on file, to show the 'type an address' flow.
      const did = ins('departments', { name, facility_id: fid, cost_center: cc, building, floor, contact: `${name} manager`, phone: `x${ri(2000, 7999)}`,
        manager_name: mgr, manager_email: departments.length % 7 === 6 ? null : `${mgr.toLowerCase().replace(/[^a-z]+/g, '.')}@demo.libre.invalid` });
      departments.push({ id: did, name, kind, facility: facilities[facilities.length - 1], building, floor });
    }
  }

  // ---------------- users & teams ----------------
  const hash = auth.hashPassword(DEMO_PASSWORD);
  const users = {};
  for (const [username, full, role, fi, title, rate, skills] of PEOPLE) {
    const id = ins('users', { username, full_name: full, role, email: `${username}@demo.libre.invalid`, title, facility_id: facilities[fi].id, labor_rate: rate, skills,
      shift: role === 'technician' ? pick(['Days 07:00-15:30', 'Days 08:00-16:30', 'Evenings 14:00-22:30']) : 'Days', available: 1, active: 1, territory: facilities[fi].code });
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hash, id);
    users[username] = { id, full, role, fi, rate };
  }
  const techsBy = fi => Object.entries(users).filter(([, u]) => u.role === 'technician' && u.fi === fi).map(([k, u]) => ({ username: k, ...u }));
  const allTechs = Object.entries(users).filter(([, u]) => u.role === 'technician').map(([k, u]) => ({ username: k, ...u }));
  const sig = u => `${u.full} (${u.username})`;
  const supervisorFor = fi => (fi === 1 ? { username: 'pnguyen', ...users.pnguyen } : { username: 'jreyes', ...users.jreyes });
  const teamDefs = [
    ['Imaging & Radiology', 'sokafor', 0, 'X-ray, CT, C-arm, ultrasound', ['sokafor', 'mtorres']],
    ['Critical Care Equipment', 'achen', 0, 'Ventilators, anesthesia, defibrillators', ['achen', 'mtorres', 'pnguyen']],
    ['General Biomed - Riverside', 'mtorres', 0, 'Pumps, monitors, beds, general', ['mtorres', 'achen', 'rpatel']],
    ['General Biomed - Lakeside', 'tbrooks', 1, 'All equipment at Lakeside', ['tbrooks', 'dkim']],
    ['Northgate Surgery Center', 'cwhite', 2, 'Surgical, endoscopy, infusion, SPD', ['cwhite', 'lgarcia']],
    ['Lab & Sterile Processing', 'rpatel', 0, 'Analyzers, sterilizers, dialysis', ['rpatel', 'lgarcia']],
  ];
  const teams = {};
  for (const [name, lead, fi, spec, members] of teamDefs) {
    const tid = ins('teams', { name, lead_id: users[lead].id, facility_id: facilities[fi].id, specialty: spec, active: 1 });
    teams[name] = tid;
    for (const m of members) ins('team_members', { team_id: tid, user_id: users[m].id });
  }
  const teamFor = (fi, key) => {
    if (FAIL_GROUP[key] === 'imaging') return teams['Imaging & Radiology'];
    if (['vent', 'tvent', 'anesthesia', 'defib'].includes(key) && fi === 0) return teams['Critical Care Equipment'];
    if (['lab', 'sterilizer'].includes(FAIL_GROUP[key]) && fi !== 1) return teams['Lab & Sterile Processing'];
    return [teams['General Biomed - Riverside'], teams['General Biomed - Lakeside'], teams['Northgate Surgery Center']][fi];
  };
  const certs = [
    ['mtorres', 'Medivra MV-300 Service Training', 'Medivra', 380, 15], ['mtorres', 'Cardiowave CW-5 Service Certification', 'Cardiowave', 700, 330],
    ['achen', 'Ventara AV-900 Field Service', 'Ventara', 200, 530], ['achen', 'Novasthesia NA-7 Service', 'Novasthesia', 900, 40],
    ['sokafor', 'Lumora CT-64 Advanced Service', 'Lumora Imaging', 400, 330], ['sokafor', 'Radiation Safety Officer refresher', 'State Radiation Control', 300, 65],
    ['rpatel', 'Nephrona RX-5008 Technician', 'Nephrona', 500, 230], ['rpatel', 'Steriforge SF-1200 Service', 'Steriforge', 650, 80],
    ['tbrooks', 'CBET (Certified Biomedical Equipment Technician)', 'AAMI Credentials Institute', 1100, 720], ['cwhite', 'Endovista EV-190 Service', 'Endovista', 250, 480],
    ['dkim', 'Electrical Safety (IEC 62353) Training', 'In-house', 200, 160], ['lgarcia', 'Steriforge Operator & Maintenance', 'Steriforge', 120, 20],
  ];
  for (const [u, name, issuer, ago, until] of certs) ins('certifications', { user_id: users[u].id, name, issuer, obtained_date: addDays(TODAY, -ago), expires_date: addDays(TODAY, until) });

  // ---------------- vendors, contracts ----------------
  const vendorDefs = [
    ['Lumora Imaging Services', 'Manufacturer (OEM)', 5], ['Labrion Diagnostics Service', 'Manufacturer (OEM)', 4], ['Steriforge Service', 'Manufacturer (OEM)', 4],
    ['Nephrona Renal Service', 'Manufacturer (OEM)', 3], ['Ventara Customer Support', 'Manufacturer (OEM)', 4], ['Tri-County Biomedical Supply', 'Parts Supplier', 4],
    ['Apex Medical Parts', 'Parts Supplier', 3], ['MedRent Equipment Rental', 'Rental', 3],
  ];
  const vendors = {};
  for (const [name, type, rating] of vendorDefs) {
    vendors[name] = ins('vendors', { name, vendor_type: type, phone: `555-${ri(1000, 9999)}`, email: `service@${name.toLowerCase().replace(/[^a-z]/g, '')}.example`, contact: pick(['Service Desk', 'Field Service Coordinator', 'Account Manager']), performance_rating: rating, account_number: `ACCT-${ri(10000, 99999)}` });
  }
  const contractDefs = [
    ['imaging', 'Imaging Full Service - System-wide', 'Lumora Imaging Services', 'Full Service', -300, 65, 410000, 4, 98, 1, 1, 1],
    ['lab', 'Laboratory Analyzer Service Agreement', 'Labrion Diagnostics Service', 'Full Service', -200, 165, 96000, 8, 97, 1, 1, 1],
    ['sterilizer', 'Sterilizer PM Agreement', 'Steriforge Service', 'PM Only', -330, 35, 38000, 24, null, 0, 0, 1],
    ['dialysis', 'Dialysis Parts & Technical Support', 'Nephrona Renal Service', 'Parts Only', -100, 265, 22000, 48, null, 0, 1, 0],
    ['vent', 'Ventilator Extended Warranty', 'Ventara Customer Support', 'Extended Warranty', -500, 230, 31000, 24, null, 1, 1, 0],
  ];
  const contracts = {};
  for (const [key, name, vendor, type, start, end, cost, resp, up, labor, parts, pm] of contractDefs) {
    contracts[key] = ins('contracts', { name, contract_number: `SA-${ri(1000, 9999)}`, vendor_id: vendors[vendor], contract_type: type, start_date: addDays(TODAY, start), end_date: addDays(TODAY, end),
      annual_cost: cost, response_hours: resp, uptime_pct: up, covers_labor: labor, covers_parts: parts, covers_pm: pm, renewal_notice_days: 90, coverage_terms: `${type} coverage per signed agreement. Demo data.` });
  }
  const contractFor = key => (FAIL_GROUP[key] === 'imaging' && key !== 'us' ? contracts.imaging : FAIL_GROUP[key] === 'lab' ? contracts.lab
    : ['steam', 'lowtemp', 'washer'].includes(key) ? contracts.sterilizer : ['dialysis', 'ro'].includes(key) ? contracts.dialysis : key === 'vent' ? contracts.vent : null);
  const vendorFor = key => (FAIL_GROUP[key] === 'imaging' && key !== 'us' ? vendors['Lumora Imaging Services'] : FAIL_GROUP[key] === 'lab' ? vendors['Labrion Diagnostics Service']
    : FAIL_GROUP[key] === 'sterilizer' ? vendors['Steriforge Service'] : null);

  // ---------------- models & procedures ----------------
  const models = {};
  for (const [key, [mf, model, type, cls, crit, pm, life, price]] of Object.entries(MODELS)) {
    const eos = key === 'lvp_old' ? addDays(TODAY, -200) : key === 'monitor_old' ? addDays(TODAY, 120) : null;
    models[key] = { id: ins('models', { manufacturer: mf, model, description: type, category: type, risk_class: cls, criticality: crit, pm_interval_months: pm, expected_life_years: life,
      end_of_support: eos, common_name: `${mf} ${model}`, life_sustaining: crit === 'Life Support' ? 1 : 0, lookup_source: 'Demo catalog (fictional)' }), key, mf, model, type, crit, pm, life, price };
  }
  const approvedAt = at(addDays(TODAY, -420));
  const procs = {};
  for (const [code, P] of Object.entries(PROCEDURES)) {
    const pid = ins('procedures', { code, name: P.name, version: 1, status: 'Approved', procedure_type: P.type, standard: P.standard,
      description: `${P.name}. Demo procedure.`, approved_by: users.jreyes.full, approved_at: approvedAt });
    const steps = P.steps.map(([type, prompt, unit, nominal, lo, hi, tol, onlyIf], i) => {
      const step = { procedure_id: pid, seq: i + 1, step_type: type, prompt, unit: unit || null, nominal: nominal ?? null, lower_limit: lo ?? null, upper_limit: hi ?? null,
        tolerance_pct: tol ?? null, required: onlyIf ? 0 : 1, only_if_step: onlyIf ?? null };
      step.id = ins('procedure_steps', step);
      return step;
    });
    procs[code] = { id: pid, code, name: P.name, steps };
  }
  // A draft revision, to show procedure version control.
  const draft = ins('procedures', { code: 'PM-INF-01', name: PROCEDURES['PM-INF-01'].name, version: 2, status: 'Draft', procedure_type: 'Manufacturer', standard: 'OEM service manual rev E; IEC 62353',
    description: 'Revision 2 draft: adds secondary-infusion check per OEM bulletin. Awaiting supervisor approval.', supersedes_id: procs['PM-INF-01'].id });
  procs['PM-INF-01'].steps.forEach(({ id: _id, ...st }) => ins('procedure_steps', { ...st, procedure_id: draft }));
  ins('procedure_steps', { procedure_id: draft, seq: 9, step_type: 'Pass/Fail', prompt: 'Secondary (piggyback) infusion switches over correctly', required: 1 });

  // ---------------- parts & POs ----------------
  const parts = {};
  for (const [pn, name, cost, fits] of PARTS) {
    const min = cost > 300 ? 1 : cost > 100 ? 2 : 5;
    parts[pn] = { id: ins('parts', { part_number: pn, name, unit_cost: cost, vendor_id: pick([vendors['Tri-County Biomedical Supply'], vendors['Apex Medical Parts']]),
      mfr_part_number: `${pn}-OEM`, min_qty: min, max_qty: min * 4, quantity_on_hand: 0, storeroom: pick(['Biomed Shop - Riverside', 'Biomed Shop - Lakeside', 'Northgate Biomed Closet']),
      bin: `${pick(['A', 'B', 'C', 'D'])}${ri(1, 20)}` }), pn, name, cost, fits, min, used: 0 };
  }
  const partsFor = key => Object.values(parts).filter(p => p.fits.includes(key) || p.fits.includes('*'));

  // ---------------- assets ----------------
  const assets = [];
  const tagSeq = {};
  for (const d of departments) {
    const F = d.facility;
    const tpl = DEPT_KINDS[d.kind];
    const plan = [];
    for (const [key, n] of Object.entries(tpl)) {
      const c = n <= 2 ? n : Math.max(1, Math.round(n * rf(0.85, 1.15)));
      for (let i = 0; i < c; i++) plan.push(key);
    }
    while (plan.length < 52) plan.push(pick(FILLERS));
    for (const key of plan) {
      const m = models[key];
      tagSeq[F.code] = (tagSeq[F.code] || 0) + 1;
      const tag = `${F.code}-${String(tagSeq[F.code]).padStart(5, '0')}`;
      const ageYrs = key.endsWith('_old') ? rf(8, 12) : TEST_EQUIP.includes(key) ? rf(1, 6) : rf(0.3, Math.min(13, m.life * 1.35));
      const install = addDays(TODAY, -Math.round(ageYrs * 365));
      const room = d.kind === 'CE' ? pick(['Biomed shop', 'Loaner pool', 'Equipment storage']) : `${d.floor}${pick(['', '-'])}${ri(1, 40)}`;
      const cyber = MODELS[key][9];
      const a = {
        asset_tag: tag, control_number: `CN${ri(100000, 999999)}`, model_id: m.id, description: `${m.mf} ${m.model} (${m.type})`, serial_number: `${m.model.replace(/[^A-Z0-9]/gi, '').slice(0, 4).toUpperCase()}${ri(100000, 999999)}`,
        status: 'Active', criticality: m.crit, risk_score: { 'Life Support': ri(16, 20), High: ri(11, 16), Medium: ri(6, 11), Low: ri(2, 6) }[m.crit] || 5,
        facility_id: F.id, department_id: d.id, room, current_facility_id: F.id, current_department_id: d.id, current_room: room,
        purchase_date: addDays(install, -ri(10, 60)), install_date: install, purchase_price: round2(m.price * rf(0.92, 1.08)), po_reference: `PO-${install.slice(0, 4)}-${ri(1000, 9999)}`,
        warranty_expires: addDays(install, 365 * (FAIL_GROUP[key] === 'imaging' ? 2 : 1)), contract_id: contractFor(key), expected_life_years: m.life,
        replacement_date: addMonths(install, Math.round(m.life * 12)), end_of_support: key === 'lvp_old' ? addDays(TODAY, -200) : null,
        is_loaner: d.kind === 'CE' && !TEST_EQUIP.includes(key) && chance(0.6) ? 1 : 0, is_test_equipment: TEST_EQUIP.includes(key) ? 1 : 0,
        cal_due_date: TEST_EQUIP.includes(key) ? addDays(TODAY, ri(-10, 330)) : null, cal_certificate: TEST_EQUIP.includes(key) ? `CAL-${ri(10000, 99999)}` : null,
        last_seen_at: null,
      };
      if (cyber) {
        const third = String(facilities.indexOf(F) * 10 + 10 + (d.id % 10));
        Object.assign(a, { ip_address: `10.${third}.${ri(1, 254)}.${ri(2, 254)}`, mac_address: Array.from({ length: 6 }, () => ri(0, 255).toString(16).padStart(2, '0')).join(':').toUpperCase(),
          hostname: `${key}-${tag}`.toLowerCase(), network_segment: { pump: 'VLAN 210 Infusion', monitor: 'VLAN 220 Clinical Monitoring', server: 'VLAN 220 Clinical Monitoring', vent: 'VLAN 230 Respiratory', imaging: 'VLAN 300 Imaging / PACS', lab: 'VLAN 310 Laboratory' }[cyber],
          os_version: { pump: 'Embedded RTOS 4.1', monitor: 'Embedded Linux 3.10', server: 'Windows Server 2016', vent: 'Embedded Linux 4.4', imaging: 'Windows 10 IoT Enterprise', lab: 'Windows 10 IoT Enterprise' }[cyber],
          software_version: `${ri(2, 9)}.${ri(0, 9)}.${ri(0, 20)}`, firmware_version: `${ri(1, 5)}.${ri(0, 9)}`,
          patch_status: key.endsWith('_old') ? 'Unsupported' : pick(['Current', 'Current', 'Current', 'Patch Available', 'Patch Pending']),
          cyber_risk: key.endsWith('_old') || cyber === 'server' ? pick(['High', 'Critical']) : pick(['Low', 'Low', 'Medium', 'Medium', 'High']) });
        if (cyber === 'server') a.vulnerabilities = 'Windows Server 2016 reaches extended end of support in Jan 2027; vendor upgrade path under review. (Demo)';
      }
      const id = ins('assets', a);
      assets.push({ id, key, m, d, F, fi: facilities.indexOf(F), tag, install, status: 'Active', serial: a.serial_number, room });
    }
  }
  const testEquip = assets.filter(a => TEST_EQUIP.includes(a.key));

  // ---------------- work order history ----------------
  const woStmt = row => ins('work_orders', row);
  const laborRow = (woId, tech, date, hours, overtime = 0) => {
    ins('wo_labor', { work_order_id: woId, user_id: tech.id, work_date: date, hours, overtime, rate: tech.rate, notes: null });
    return hours * tech.rate * (overtime ? 1.5 : 1);
  };
  const usePart = (woId, part, qty, date) => {
    ins('wo_parts', { work_order_id: woId, part_id: part.id, quantity: qty, unit_cost: part.cost });
    ins('part_transactions', { part_id: part.id, txn_type: 'Issue', quantity: -qty, unit_cost: part.cost, work_order_id: woId, user_name: 'demo', created_at: at(date, 14) });
    part.used += qty;
    return qty * part.cost;
  };
  const setCosts = (woId, labor, partsCost, hours) => db.prepare('UPDATE work_orders SET labor_hours = ?, labor_cost = ?, parts_cost = ? WHERE id = ?').run(round2(hours), round2(labor), round2(partsCost), woId);
  const techFor = a => { const pool = techsBy(a.fi); return pool.length ? pick(pool) : pick(allTechs); };
  const pmHours = key => ({ ct: 6, dr: 4, carm: 3, mobilexr: 3, anesthesia: 2.5, vent: 2, steam: 3, lowtemp: 3, washer: 2, chem: 3, heme: 2, dialysis: 1.5, defib: 1, esu: 1, incubator: 1.25 }[key] || rf(0.6, 1.5));

  let pmCount = 0; let cmCount = 0; let trCount = 0;
  const windowStart = addDays(TODAY, -395);
  const schedules = [];
  for (const a of assets) {
    if (!a.m.pm || a.key === 'scope') continue;
    const interval = a.m.pm;
    const procCode = MODELS[a.key][8];
    const proc = procCode ? procs[procCode] : null;
    const tech = techFor(a);
    const teamId = teamFor(a.fi, a.key);
    const vendorPm = ['ct', 'dr', 'carm', 'mobilexr', 'chem', 'heme', 'bloodgas', 'coag', 'steam', 'lowtemp', 'washer'].includes(a.key);
    // Anchor the next due date somewhere in the coming interval (a few slightly overdue).
    let nextDue = addDays(TODAY, ri(-2, Math.round(interval * 30.4)));
    const dues = [];
    for (let d = addMonths(nextDue, -interval); d >= windowStart && d >= a.install; d = addMonths(d, -interval)) dues.unshift(d);
    const schedId = ins('pm_schedules', { asset_id: a.id, procedure_id: proc?.id || null, wo_type: 'Preventive', program: a.key === 'flowmeter' || a.key === 'thermometer' ? 'AEM (Alternative Equipment Maintenance)' : vendorPm ? 'Manufacturer Recommended' : chance(0.85) ? 'Manufacturer Recommended' : 'Risk-Based',
      interval_months: interval, next_due: nextDue, lead_days: 14, grace_days: 30, assigned_to: vendorPm ? null : tech.id, team_id: teamId, active: 1,
      notes: vendorPm ? 'Performed by vendor under service agreement; biomed verifies and files report.' : null });
    let lastDone = null; let openDue = null;
    for (const due of dues) {
      const age = (Date.parse(TODAY) - Date.parse(due)) / 864e5;
      // Older PMs are almost always done; the last week's are often still in progress.
      const done = age > 45 ? chance(0.991) : age > 7 ? chance(0.98) : age > 0 ? chance(0.82) : false;
      if (!done) { openDue = due; break; }
      const compDate = minDate(addDays(due, ri(-12, 9) + (chance(0.06) ? ri(15, 40) : 0)), addDays(TODAY, -1));
      const req = at(addDays(due, -14), 2);
      const started = at(compDate, ri(7, 14), ri(0, 59));
      const hours = round2(pmHours(a.key));
      const completed = plusHours(started, hours + rf(0.1, 0.6));
      const sup = supervisorFor(a.fi);
      const closed = age > 21 || chance(0.6);
      const wo = woStmt({ wo_number: num('WO', req, 6), type: 'Preventive', asset_id: a.id, status: closed ? 'Closed' : 'Completed', priority: 'Normal', assigned_to: vendorPm ? null : tech.id,
        team_id: teamId, vendor_id: vendorPm ? vendorFor(a.key) : null, due_date: due, requested_by: 'PM Scheduler', department_id: a.d.id,
        problem: `Scheduled maintenance every ${interval} month(s)${proc ? `\nProcedure: ${proc.code} ${proc.name} v1` : ''}`,
        requested_at: req, assigned_at: req, started_at: started, completed_at: completed, return_to_service: 1,
        work_performed: vendorPm ? 'Vendor PM completed per service agreement; service report reviewed and attached.' : 'PM completed per procedure. All checks within limits.',
        tech_signature: vendorPm ? `${sig(sup)} - Completed work and verified results` : `${sig(tech)} - Completed work and verified results`, tech_signed_at: completed,
        supervisor_signature: closed ? `${sig(sup)} - Reviewed and approved` : null, supervisor_signed_at: closed ? plusHours(completed, rf(4, 72)) : null,
        pm_schedule_id: schedId, external_cost: 0, created_at: req, updated_at: completed });
      let labor = 0; let pc = 0;
      if (!vendorPm) labor = laborRow(wo, tech, compDate, hours);
      if (!vendorPm && chance(0.2)) { const p = pick(partsFor(a.key)); if (p) pc = usePart(wo, p, 1, compDate); }
      setCosts(wo, labor, pc, vendorPm ? 0 : hours);
      pmCount++;
      lastDone = compDate;
      // Guided test record for recent PMs that use a procedure.
      if (proc && age < 200 && chance(0.55)) { trCount++; addTestRun(wo, a, proc, tech, started, completed); }
    }
    if (openDue) nextDue = openDue;
    db.prepare('UPDATE pm_schedules SET next_due = ?, last_completed = ? WHERE id = ?').run(nextDue, lastDone, schedId);
    schedules.push({ id: schedId, a, nextDue, tech, teamId, interval, proc });
    // Open PM work order when due (or overdue) within the lead window.
    if (addDays(nextDue, -14) <= TODAY) {
      const req = at(minDate(addDays(nextDue, -14), TODAY), 2);
      const state = nextDue < TODAY ? pick(['Assigned', 'Assigned', 'In Progress', 'In Progress']) : chance(0.1) ? 'Open' : 'Assigned';
      // Vendor PMs are coordinated by the facility's biomed supervisor.
      const owner = state === 'Open' ? null : vendorPm ? (a.fi === 2 ? users.cwhite.id : supervisorFor(a.fi).id) : tech.id;
      woStmt({ wo_number: num('WO', req, 6), type: 'Preventive', asset_id: a.id, status: state, priority: 'Normal', assigned_to: owner, team_id: teamId,
        vendor_id: vendorPm ? vendorFor(a.key) : null, due_date: nextDue, requested_by: 'PM Scheduler', department_id: a.d.id, requested_at: req, assigned_at: state === 'Open' ? null : req,
        started_at: state === 'In Progress' ? at(TODAY, 8) : null, pm_schedule_id: schedId,
        problem: `Scheduled maintenance every ${interval} month(s)${proc ? `\nProcedure: ${proc.code} ${proc.name} v1` : ''}`, created_at: req, updated_at: req });
      pmCount++;
    }
  }

  function addTestRun(woId, a, proc, tech, started, completed) {
    const date = completed.slice(0, 10);
    const te = testEquip.filter(t => (proc.code === 'PM-INF-01' ? ['esa', 'ipa'] : proc.code === 'PM-DEF-01' ? ['esa', 'da'] : proc.code === 'PM-MON-01' ? ['esa', 'ps', 'nibpa']
      : proc.code === 'PM-VEN-01' ? ['esa', 'vanl'] : proc.code === 'PM-ESU-01' ? ['esa', 'esuan'] : ['esa']).includes(t.key) && t.fi === a.fi).slice(0, 3);
    const teFallback = te.length ? te : testEquip.filter(t => t.key === 'esa').slice(0, 1);
    const runId = ins('test_runs', { run_number: num('TR', date, 6), work_order_id: woId, asset_id: a.id, procedure_id: proc.id, procedure_version: 1, technician_id: tech.id,
      test_equipment: teFallback.map(t => `${t.tag} ${t.m.mf} ${t.m.model} SN ${t.serial} cal due ${addDays(date, ri(60, 300))}`).join('\n'),
      status: 'Completed', result: 'Pass', started_at: started, completed_at: completed, signature: `${sig(tech)} ${completed}`, created_at: completed });
    db.prepare('UPDATE test_runs SET procedure_snapshot = ? WHERE id = ?').run(JSON.stringify({ procedure: { id: proc.id, code: proc.code, name: proc.name, version: 1 }, steps: proc.steps }), runId);
    const insR = db.prepare(`INSERT INTO test_results (run_id, step_id, seq, step_type, prompt, unit, nominal, lower_limit, upper_limit, required, only_if_step, as_found, value, error_pct, result, note, recorded_at, recorded_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    // About 1 in 14 tests fails one measurement, which creates a follow-up repair.
    const measures = proc.steps.filter(st => st.step_type === 'Measurement' && !st.only_if_step);
    const failStep = measures.length && chance(0.07) ? pick(measures) : null;
    let anyFail = false;
    let failed = null;
    for (const st of proc.steps) {
      if (st.only_if_step) continue;
      const { lo, hi } = logic.limitsFor(st);
      let value = null; let result = null; let err = null;
      if (st.step_type === 'Measurement') {
        if (st === failStep) value = hi != null ? round2(hi + Math.max(Math.abs(hi) * rf(0.08, 0.3), 0.2)) : round2(lo - Math.max(Math.abs(lo) * rf(0.08, 0.3), 0.2));
        // Normal readings: inside the limits, clustered around nominal.
        else if (lo != null && hi != null) value = round2(st.nominal != null ? st.nominal + (rnd() < 0.5 ? -1 : 1) * rf(0, 0.6) * Math.min(st.nominal - lo, hi - st.nominal) : lo + (hi - lo) * rf(0.25, 0.75));
        else if (hi != null) value = round2(hi * rf(0.15, 0.55));
        else value = round2(rf(0.05, 0.2));
        result = (lo == null || value >= lo) && (hi == null || value <= hi) ? 'Pass' : 'Fail';
        if (result === 'Fail') { anyFail = true; failed = st; }
        err = st.nominal ? round2(((value - st.nominal) / Math.abs(st.nominal)) * 100) : null;
      } else if (st.step_type === 'Pass/Fail') { value = 'Pass'; result = 'Pass'; } else if (st.step_type === 'Instruction') { value = 'Done'; result = 'Done'; }
      insR.run(runId, st.id, st.seq, st.step_type, st.prompt, st.unit, st.nominal, lo, hi, st.required, st.only_if_step, null, value == null ? null : String(value), err, result, null, completed, tech.username);
    }
    if (anyFail) {
      db.prepare("UPDATE test_runs SET result = 'Fail' WHERE id = ?").run(runId);
      // Libre creates a corrective work order automatically when a test fails.
      const pmWo = db.prepare('SELECT wo_number FROM work_orders WHERE id = ?').get(woId).wo_number;
      const { lo, hi } = logic.limitsFor(failed);
      const fixed = chance(0.75) || Date.parse(completed) < Date.now() - 20 * 864e5;
      const start2 = plusHours(completed, rf(1, 20));
      const end2 = plusHours(start2, rf(1, 6));
      const fu = ins('work_orders', { wo_number: num('WO', completed, 6), type: 'Corrective', asset_id: a.id, status: fixed ? 'Closed' : 'In Progress', priority: 'High', assigned_to: tech.id,
        team_id: teamFor(a.fi, a.key), due_date: addDays(date, 3), requested_by: 'Automatic (failed test)', department_id: a.d.id, parent_wo_id: woId,
        problem: `Failed test on ${pmWo}. Failed step: ${failed.prompt} (limits ${lo ?? '-'}..${hi ?? '-'} ${failed.unit || ''})`,
        requested_at: completed, assigned_at: completed, started_at: start2, completed_at: fixed ? end2 : null,
        work_performed: fixed ? 'Adjusted / replaced component and repeated the failed test: now within limits.' : null,
        failure_code: fixed ? 'Calibration Drift' : null, cause_code: fixed ? 'Normal Wear' : null, action_code: fixed ? 'Adjusted / Calibrated' : null,
        return_to_service: fixed ? 1 : 0, tech_signature: fixed ? `${sig(tech)} - Completed work and verified results` : null, tech_signed_at: fixed ? end2 : null,
        supervisor_signature: fixed ? `${sig(supervisorFor(a.fi))} - Reviewed and approved` : null, supervisor_signed_at: fixed ? plusHours(end2, 18) : null, created_at: completed });
      const labor = laborRow(fu, tech, (fixed ? end2 : start2).slice(0, 10), round2(rf(1, 3)));
      setCosts(fu, labor, 0, round2(labor / tech.rate));
      if (!fixed) db.prepare("UPDATE assets SET status = 'Out of Service' WHERE id = ?").run(a.id);
    }
  }

  // Corrective maintenance history (12 months) + current open repairs.
  const openCm = [];
  for (const a of assets) {
    if (TEST_EQUIP.includes(a.key)) continue;
    const grp = FAIL_GROUP[a.key] || 'default';
    const rate = RATE_OVERRIDE[a.key] ?? FAIL_RATE[grp] ?? FAIL_RATE.default;
    let n = 0; for (let k = 0; k < 6; k++) if (chance(rate / 6)) n++;
    if (a.key.endsWith('_old') && chance(0.5)) n++;
    for (let i = 0; i < n; i++) {
      const daysAgo = ri(0, 365);
      const reqDate = addDays(TODAY, -daysAgo);
      const [fc, cc, ac, text] = pick(FAILURES[grp] || FAILURES.default);
      const prio = pick(['Normal', 'Normal', 'Normal', 'High', 'High', 'Urgent', 'Low', ...(a.m.crit === 'Life Support' ? ['Urgent', 'Emergency'] : [])]);
      const tech = techFor(a);
      const vendorJob = VENDOR_SERVICED.has(a.key) && chance(0.6);
      const req = at(reqDate, ri(6, 20), ri(0, 59));
      const isOpen = daysAgo < 9 && chance(0.55);
      const respH = { Emergency: rf(0.1, 0.8), Urgent: rf(0.5, 3), High: rf(1, 12), Normal: rf(2, 36), Low: rf(8, 96) }[prio];
      const started = plusHours(req, respH);
      const repairH = grp === 'imaging' || grp === 'lab' ? rf(3, 60) : rf(0.5, 30);
      const completed = plusHours(started, repairH);
      const requester = pick(['Charge Nurse', 'Unit Manager', 'Staff RN', 'Lab Supervisor', 'Radiology Tech', 'OR Coordinator', 'Respiratory Therapist']);
      const fiSup = supervisorFor(a.fi);
      if (isOpen || Date.parse(completed) > Date.now()) {
        const status = pick(['Open', 'Assigned', 'Assigned', 'In Progress', 'In Progress', 'Awaiting Parts', 'On Hold']);
        const wo = woStmt({ wo_number: num('WO', req, 6), type: 'Corrective', asset_id: a.id, status, priority: prio, assigned_to: status === 'Open' ? null : tech.id,
          team_id: teamFor(a.fi, a.key), vendor_id: vendorJob ? vendorFor(a.key) : null, due_date: addDays(reqDate, { Emergency: 0, Urgent: 1, High: 3, Normal: 7, Low: 14 }[prio]),
          requested_by: requester, department_id: a.d.id, problem: text || `${fc} reported.`, requested_at: req, assigned_at: status === 'Open' ? null : plusHours(req, 0.3),
          started_at: ['In Progress', 'Awaiting Parts', 'On Hold'].includes(status) ? started : null, created_at: req, updated_at: req });
        openCm.push({ wo, a, status });
        if (status === 'Awaiting Parts' || status === 'In Progress') {
          const lab = laborRow(wo, tech, reqDate, round2(rf(0.5, 2)));
          setCosts(wo, lab, 0, 0);
          const hrs = db.prepare('SELECT SUM(hours) h FROM wo_labor WHERE work_order_id = ?').get(wo).h;
          db.prepare('UPDATE work_orders SET labor_hours = ? WHERE id = ?').run(hrs, wo);
        }
        if (['Out of Service', 'Awaiting Parts'].includes(status) || (status === 'Awaiting Parts')) db.prepare("UPDATE assets SET status = 'Awaiting Parts' WHERE id = ?").run(a.id);
        else if (prio === 'Emergency' || (prio === 'Urgent' && chance(0.5))) db.prepare("UPDATE assets SET status = 'Out of Service' WHERE id = ?").run(a.id);
        cmCount++;
        continue;
      }
      const closed = daysAgo > 7 || chance(0.5);
      const ext = vendorJob ? (a.m.id && contractFor(a.key) ? 0 : round2(rf(600, 6500))) : 0;
      const wo = woStmt({ wo_number: num('WO', req, 6), type: 'Corrective', asset_id: a.id, status: closed ? 'Closed' : 'Completed', priority: prio, assigned_to: tech.id,
        team_id: teamFor(a.fi, a.key), vendor_id: vendorJob ? vendorFor(a.key) : null, due_date: addDays(reqDate, { Emergency: 0, Urgent: 1, High: 3, Normal: 7, Low: 14 }[prio]),
        requested_by: requester, department_id: a.d.id, problem: text || `${fc} reported.`, requested_at: req, assigned_at: plusHours(req, 0.3), started_at: started, completed_at: completed,
        work_performed: vendorJob ? `Vendor field engineer on site. ${ac}. Service report on file.` : `${ac}. Functional and electrical safety checks passed.`,
        failure_code: fc, cause_code: cc, action_code: ac, downtime_hours: round2(repairH + respH), external_cost: ext, invoice_number: ext ? `INV-${ri(10000, 99999)}` : null,
        return_to_service: 1, tech_signature: `${sig(tech)} - Completed work and verified results`, tech_signed_at: completed,
        supervisor_signature: closed ? `${sig(fiSup)} - Reviewed and approved` : null, supervisor_signed_at: closed ? plusHours(completed, rf(2, 48)) : null, created_at: req, updated_at: completed });
      const hours = round2(vendorJob ? rf(0.5, 1.5) : Math.min(Math.max(repairH, 1), rf(1, 6)));
      let labor = laborRow(wo, tech, completed.slice(0, 10), hours, chance(0.08) ? 1 : 0);
      let pc = 0;
      if (ac === 'Replaced Part' || chance(0.35)) { const p = pick(partsFor(a.key)); if (p) pc = usePart(wo, p, chance(0.85) ? 1 : 2, completed.slice(0, 10)); }
      setCosts(wo, labor, pc, hours);
      cmCount++;
    }
  }

  // ---------------- service requests ----------------
  const allCm = db.prepare("SELECT w.id, w.asset_id, w.department_id, w.requested_at, w.status, w.problem, w.priority FROM work_orders w WHERE w.type = 'Corrective' ORDER BY w.id").all();
  const srRows = allCm.filter(() => chance(Math.min(1, 90 / Math.max(1, allCm.length))));
  let srCount = 0;
  for (const w of srRows) {
    const done = ['Completed', 'Closed'].includes(w.status);
    const created = new Date(Date.parse(w.requested_at) - 600e3).toISOString();
    const a = assets.find(x => x.id === w.asset_id);
    const id = ins('service_requests', { request_number: num('SR', created, 6), status: done ? 'Closed' : 'Converted to WO', urgency: { Emergency: 'Patient Care Impacted', Urgent: 'Patient Care Impacted', High: 'High', Normal: 'Normal', Low: 'Low' }[w.priority],
      asset_id: w.asset_id, asset_text: a?.tag, problem: w.problem, requester_name: pick(['A. Lopez RN', 'J. Kim RN', 'M. Patel', 'S. Johnson RN', 'R. Davis', 'T. Nguyen RN', 'K. Brown']),
      requester_phone: `x${ri(2000, 7999)}`, department_id: w.department_id, room: a?.room, work_order_id: w.id,
      response: done ? 'Repaired and returned to service. Thank you for reporting it.' : 'A technician has been assigned.', satisfaction: done && chance(0.7) ? pick([5, 5, 5, 4, 4, 4, 3, 2]) : null,
      feedback: done && chance(0.3) ? pick(['Quick turnaround, thanks!', 'Technician explained the fix.', 'Took longer than expected.', 'Great service.']) : null, created_at: created });
    db.prepare('UPDATE service_requests SET public_token = ? WHERE id = ?').run(require('node:crypto').randomBytes(9).toString('base64url'), id);
    db.prepare('UPDATE work_orders SET request_id = ? WHERE id = ?').run(id, w.id);
    srCount++;
  }
  const newProblems = ['Pump alarms "check IV set" repeatedly on bed 12.', 'Monitor screen goes black intermittently in room 4.', 'Bed will not lower, patient fall risk.',
    'Suction regulator not holding vacuum in trauma bay.', 'Thermometer reading 2 degrees low compared to backup.', 'Fetal monitor paper not advancing.'];
  for (const p of newProblems) {
    const a = pick(assets.filter(x => !TEST_EQUIP.includes(x.key) && x.d.kind !== 'CE'));
    const created = at(TODAY, ri(6, 11), ri(0, 59));
    const id = ins('service_requests', { request_number: num('SR', created, 6), status: chance(0.3) ? 'Triaged' : 'New', urgency: pick(['Normal', 'High', 'Patient Care Impacted']), asset_id: a.id, asset_text: a.tag,
      problem: p, requester_name: pick(['A. Lopez RN', 'C. Rivera RN', 'D. Moore', 'E. Wilson RN']), requester_phone: `x${ri(2000, 7999)}`, department_id: a.d.id, room: a.room, created_at: created });
    db.prepare('UPDATE service_requests SET public_token = ? WHERE id = ?').run(require('node:crypto').randomBytes(9).toString('base64url'), id);
    srCount++;
  }

  // ---------------- stock levels & purchase orders ----------------
  for (const p of Object.values(parts)) {
    const onHand = p.pn === 'BAT-MV300' || p.pn === 'O2-CELL' || p.pn === 'NIBP-CUFF' ? ri(0, p.min) : ri(p.min, p.min * 4);
    const received = onHand + p.used;
    ins('part_transactions', { part_id: p.id, txn_type: 'Receive', quantity: received, unit_cost: p.cost, note: 'Opening stock (demo)', user_name: 'demo', created_at: at(addDays(TODAY, -380), 10) });
    db.prepare('UPDATE parts SET quantity_on_hand = ? WHERE id = ?').run(onHand, p.id);
  }
  const PO_APPROVAL_LIMIT = 1000; // demo: POs of $1,000 or more need a supervisor's signature
  dbm.setSetting(db, 'po_approval_limit', String(PO_APPROVAL_LIMIT));
  const poDefs = [['Tri-County Biomedical Supply', 'Ordered', [['BAT-MV300', 12], ['CLMP-01', 6]]], ['Apex Medical Parts', 'Received', [['SPO2-SNS', 8], ['ECG-5LD', 6], ['NIBP-HOSE', 10]]],
    ['Tri-County Biomedical Supply', 'Draft', [['O2-CELL', 6], ['FLT-AV900', 10]]], ['Apex Medical Parts', 'Partially Received', [['CSTR-01', 20], ['HSET-HB900', 4]]]];
  for (const [vendor, status, lines] of poDefs) {
    const od = addDays(TODAY, -ri(3, 40));
    const po = ins('purchase_orders', { po_number: num('PO', od, 5), vendor_id: vendors[vendor], status, order_date: od, expected_date: addDays(od, 14), total: 0, notes: 'Demo purchase order' });
    let total = 0;
    for (const [pn, q] of lines) {
      ins('po_lines', { po_id: po, part_id: parts[pn].id, quantity: q, unit_cost: parts[pn].cost, received_qty: status === 'Received' ? q : status === 'Partially Received' ? Math.floor(q / 2) : 0 });
      total += q * parts[pn].cost;
    }
    db.prepare('UPDATE purchase_orders SET total = ? WHERE id = ?').run(round2(total), po);
    // POs at or above the approval limit that were ordered carry a supervisor's approval signature.
    if (status !== 'Draft' && total >= PO_APPROVAL_LIMIT) {
      db.prepare('UPDATE purchase_orders SET approval_signature = ?, approved_at = ?, approved_total = ? WHERE id = ?')
        .run(`Jordan Reyes - Approved purchase of $${round2(total).toFixed(2)}`, at(addDays(od, -1), 9), round2(total), po);
    }
  }

  // ---------------- documents ----------------
  for (const key of ['lvp', 'syringe', 'monitor', 'defib', 'vent', 'anesthesia', 'esu', 'incubator', 'dialysis', 'steam', 'dr', 'ct', 'chem', 'bed', 'fetal']) {
    const m = models[key];
    ins('documents', { title: `${m.mf} ${m.model} Service Manual`, doc_type: 'Service Manual', revision: pick(['C', 'D', 'E', '2.1', '3.0']), model_id: m.id, tags: `${m.type} service manual` });
    ins('documents', { title: `${m.mf} ${m.model} Operator Manual`, doc_type: 'Operator Manual', revision: pick(['B', 'C', '1.4']), model_id: m.id });
  }
  ins('documents', { title: 'Medivra MV-200 end-of-support notice', doc_type: 'End of Life / End of Support Letter', revision: addDays(TODAY, -560).slice(0, 7), model_id: models.lvp_old.id,
    body: 'Fictional demo notice: the manufacturer has ended parts and service support for the MV-200. Plan replacement with MV-300.' });
  ins('documents', { title: 'Vitalyn VX-8 end-of-life announcement', doc_type: 'End of Life / End of Support Letter', revision: addDays(TODAY, -300).slice(0, 7), model_id: models.monitor_old.id,
    body: 'Fictional demo notice: VX-8 support ends in four months. Software patches are no longer released.' });
  const articles = [
    ['MV-300 alarms within minutes on battery', 'lvp', 'battery alarm MV-300', 'Replace BAT-MV300 and run the 5-minute battery test. Batteries older than 3 years usually fail.'],
    ['VX-12 dropping off central station', 'monitor', 'network central VX-12', 'Check the wall jack and VLAN 220 port. Re-seat the network module; if persistent, request a switch-port check from IT.'],
    ['AV-900 O2 sensor alarm', 'vent', 'O2 sensor AV-900', 'O2 cells last about 12 months. Replace O2-CELL and run calibration from the service menu.'],
    ['SF-1200 cycle aborts on low temperature', 'steam', 'sterilizer gasket temperature', 'Inspect door gasket GSKT-SF1200 for flattening; check steam supply pressure before calling vendor.'],
    ['HB-900 bed will not lower', 'bed', 'bed actuator HB-900', 'Check the pendant cable first; if actuator hums but does not move, replace MTR-ACT.'],
  ];
  for (const [title, key, tags, body] of articles) ins('documents', { title, doc_type: 'Knowledge Article', model_id: models[key].id, tags, body });

  // ---------------- recalls (fictional manufacturer notices) ----------------
  const ctx = { db, user: { id: users.jreyes.id, username: 'jreyes', full_name: users.jreyes.full, role: 'supervisor' }, ip: 'demo' };
  const recallDefs = [
    { recall_number: 'MFSN-2026-014', title: 'MV-300 door latch may not detect an open door', source: 'Manufacturer Notice', classification: 'Class II', issued_date: addDays(TODAY, -48),
      manufacturer: 'Medivra', model_id: models.lvp.id, action_required: 'Install latch sensor kit LK-7 and verify door-open alarm per field notice.', due_date: addDays(TODAY, 40), complete: 0.6,
      // Only a production lot is affected: a realistic list of serial numbers.
      serials: () => assets.filter(x => x.key === 'lvp').filter(() => chance(0.11)).map(x => x.serial) },
    { recall_number: 'MFSN-2026-006', title: 'CW-5 battery may not deliver full charge cycles', source: 'Field Safety Corrective Action', classification: 'Class I', issued_date: addDays(TODAY, -150),
      manufacturer: 'Cardiowave', model_id: models.defib.id, action_required: 'Replace battery with revised part BAT-CW5 rev C; perform shock test.', due_date: addDays(TODAY, -60), complete: 1 },
    { recall_number: 'MFSN-2026-021', title: 'AV-900 software 4.2 may silence disconnect alarm after power cycle', source: 'Manufacturer Notice', classification: 'Class II', issued_date: addDays(TODAY, -9),
      manufacturer: 'Ventara', model_id: models.vent.id, action_required: 'Update software to 4.3 and verify disconnect alarm.', due_date: addDays(TODAY, 30), complete: 0.35 },
  ];
  for (const R of recallDefs) {
    const { complete, serials, ...data } = R;
    const rid = ins('recalls', { ...data, serial_numbers: serials ? serials().join(', ') : null, status: 'Open', description: `${R.title}. Fictional demo recall.` });
    logic.matchRecall(ctx, rid);
    logic.recallWorkOrders(ctx, rid);
    const ras = db.prepare('SELECT * FROM recall_assets WHERE recall_id = ?').all(rid);
    // Recall work is dispatched to the technician covering each facility.
    for (const ra of ras) {
      const a = assets.find(x => x.id === ra.asset_id);
      db.prepare("UPDATE work_orders SET assigned_to = ?, team_id = ?, assigned_at = ?, status = 'Assigned' WHERE id = ?").run(techFor(a).id, teamFor(a.fi, a.key), at(R.issued_date, 15), ra.work_order_id);
    }
    let n = 0;
    for (const ra of ras) {
      if (rnd() < complete) {
        const done = at(addDays(TODAY, -ri(2, Math.max(3, Math.round((Date.parse(TODAY) - Date.parse(R.issued_date)) / 864e5) - 2))), 11);
        const tech = techFor(assets.find(x => x.id === ra.asset_id));
        db.prepare(`UPDATE work_orders SET status = 'Closed', assigned_to = ?, started_at = ?, completed_at = ?, work_performed = ?, return_to_service = 1, tech_signature = ?, tech_signed_at = ?,
          supervisor_signature = ?, supervisor_signed_at = ?, labor_hours = 0.75, labor_cost = ? WHERE id = ?`).run(tech.id, done, plusHours(done, 0.75), `Recall action completed: ${R.action_required}`,
          `${sig(tech)} - Completed work and verified results`, plusHours(done, 0.75), `${sig(supervisorFor(tech.fi))} - Reviewed and approved`, plusHours(done, 20), round2(0.75 * tech.rate), ra.work_order_id);
        ins('wo_labor', { work_order_id: ra.work_order_id, user_id: tech.id, work_date: done.slice(0, 10), hours: 0.75, rate: tech.rate });
        db.prepare("UPDATE recall_assets SET status = 'Action Complete' WHERE id = ?").run(ra.id);
        n++;
      }
    }
    const status = complete >= 1 ? 'Closed - Complete' : n ? 'In Progress' : 'In Progress';
    db.prepare('UPDATE recalls SET status = ?, closure_notes = ? WHERE id = ?').run(status, complete >= 1 ? 'All affected units corrected and verified.' : null, rid);
  }

  // ---------------- incidents ----------------
  const incAssets = [assets.find(a => a.key === 'lvp' && a.fi === 0), assets.find(a => a.key === 'bed' && a.fi === 1), assets.find(a => a.key === 'monitor' && a.fi === 0)];
  const incDefs = [
    ['Infusion pump over-infusion suspected', 'Equipment Failure', 'Moderate', 'Nurse reported a 50 mL bag emptied early. Pump sequestered with tubing.', 'Pump tested within accuracy; administration set found mis-loaded. Staff in-service completed.', 1, 0, 'Closed'],
    ['Bed side rail collapsed during transfer', 'Patient Injury', 'Minor', 'Side rail latch released during transfer; minor bruise.', 'Latch spring fatigue; latch replaced on all HB-900 beds on the unit (6).', 1, 0, 'Closed'],
    ['Central station lost monitors for 4 minutes', 'Cybersecurity', 'None', 'Twelve monitors dropped from central station simultaneously.', 'Investigating with IT network team: switch firmware update suspected.', 0, 0, 'Investigating'],
  ];
  incDefs.forEach(([title, type, sev, desc, inv, seq, fda, status], i) => {
    const d = addDays(TODAY, -[95, 40, 6][i]);
    ins('incidents', { incident_number: num('INC', d, 5), title, incident_type: type, asset_id: incAssets[i]?.id, occurred_at: at(d, 14), severity: sev, description: desc,
      equipment_sequestered: seq, reported_to_fda: fda, investigation: inv, status });
  });

  // ---------------- inventories & Unable To Locate ----------------
  const invDepts = departments.filter(d => ['ED', 'ICU', 'MEDSURG', 'INFUSION', 'PACU', 'PREOP'].includes(d.kind)).slice(0, 6);
  const scanStmt = row => ins('inventory_scans', row);
  invDepts.forEach((d, i) => {
    const date = addDays(TODAY, -[150, 120, 85, 60, 33, 12][i]);
    const tech = techFor({ fi: facilities.indexOf(d.facility) });
    const invId = ins('inventories', { inventory_number: num('INV', date, 5), facility_id: d.facility.id, department_id: d.id, status: 'Completed', started_at: at(date, 8), started_by: tech.full,
      completed_at: at(date, 12), completed_by: tech.full, notes: 'Annual department inventory (demo).' });
    const list = assets.filter(a => a.d.id === d.id);
    const missing = new Set(list.filter(() => chance(0.03)).map(a => a.id));
    let red = 0; let yellow = 0; let found = 0;
    for (const a of list) {
      if (missing.has(a.id)) continue;
      const flags = inventory.assetFlags(db, db.prepare('SELECT * FROM assets WHERE id = ?').get(a.id), d.id).filter(f => f.code !== 'utl');
      const lvl = flags.some(f => f.level === 'red') ? 'Red' : flags.some(f => f.level === 'yellow') ? 'Yellow' : 'None';
      if (lvl === 'Red') red++; if (lvl === 'Yellow') yellow++;
      found++;
      scanStmt({ inventory_id: invId, scanned_at: at(date, ri(8, 11), ri(0, 59)), scanned_code: a.tag, asset_id: a.id, room: a.room, result: 'Found', flag_level: lvl,
        flag_text: flags.filter(f => f.level !== 'info').map(f => f.text).join('\n') || null, flags_json: JSON.stringify(flags), scanned_by: tech.full });
      db.prepare('UPDATE assets SET last_seen_at = ?, last_inventory_id = ? WHERE id = ?').run(at(date, 10), invId, a.id);
    }
    for (const aid of missing) {
      const a = assets.find(x => x.id === aid);
      const resolved = chance(0.5);
      ins('utl_events', { asset_id: aid, status: resolved ? 'Resolved' : 'Open', source: 'Inventory', facility_id: d.facility.id, department_id: d.id, inventory_id: invId,
        reported_at: at(date, 12), reported_by: tech.full, notes: `Not found during inventory of ${d.name}`,
        resolved_at: resolved ? at(addDays(date, ri(3, 25)), 10) : null, resolved_by: resolved ? tech.full : null, resolution: resolved ? pick(['Found in storage closet', 'Found on another unit', 'Found in biomed shop awaiting repair']) : null });
      if (!resolved) db.prepare('UPDATE assets SET utl_since = ? WHERE id = ?').run(date, aid);
      else db.prepare('UPDATE assets SET last_seen_at = ? WHERE id = ?').run(at(addDays(date, 10), 10), aid);
      red++;
    }
    db.prepare('UPDATE inventories SET expected_count = ?, found_count = ?, missing_count = ?, unexpected_count = 0, added_count = 0, red_count = ?, yellow_count = ? WHERE id = ?')
      .run(list.length, found, missing.size, red, yellow, invId);
  });
  // PM work orders that could not be located.
  const openPmCands = db.prepare("SELECT w.*, a.facility_id fac, a.department_id dep FROM work_orders w JOIN assets a ON a.id = w.asset_id WHERE w.pm_schedule_id IS NOT NULL AND w.status IN ('Assigned','Open') AND a.utl_since IS NULL ORDER BY w.id").all();
  const openPmForUtl = openPmCands.filter(() => chance(7 / Math.max(7, openPmCands.length))).slice(0, 7);
  for (const w of openPmForUtl) {
    const d = addDays(TODAY, -ri(1, 20));
    const tech = w.assigned_to ? allTechs.find(t => t.id === w.assigned_to) || allTechs[0] : allTechs[0];
    const notes = pick(['Checked unit, clean utility and equipment room. Charge nurse unaware of location.', 'Not on unit; checked biomed shop and loaner pool.', 'Room listed is now a storage room; asset not present.']);
    db.prepare(`UPDATE work_orders SET status = 'On Hold', unable_to_locate = 1, utl_reported_at = ?, work_performed = ? WHERE id = ?`).run(at(d, 13), `Unable to locate asset (${d}, ${tech.full}): ${notes}`, w.id);
    ins('utl_events', { asset_id: w.asset_id, status: 'Open', source: 'PM Work Order', facility_id: w.fac, department_id: w.dep, work_order_id: w.id, reported_at: at(d, 13), reported_by: tech.full, notes });
    db.prepare('UPDATE assets SET utl_since = COALESCE(utl_since, ?) WHERE id = ?').run(d, w.asset_id);
  }
  // An inventory in progress right now (Lakeside ED), using the real scanning engine.
  // Portal requests require an email address.
  db.prepare("UPDATE service_requests SET requester_email = lower(replace(replace(replace(requester_name, ' RN', ''), '. ', '.'), ' ', '.')) || '@demo.libre.invalid' WHERE requester_email IS NULL").run();
  const lchEd = departments.find(d => d.facility.code === 'LCH' && d.kind === 'ED');
  const tctx = { db, user: { id: users.tbrooks.id, username: 'tbrooks', full_name: users.tbrooks.full, role: 'technician' }, ip: 'demo' };
  const st = inventory.start(tctx, { facility_id: lchEd.facility.id, department_id: lchEd.id });
  for (const a of assets.filter(x => x.d.id === lchEd.id).slice(0, 34)) inventory.scan(tctx, st.id, { code: a.tag, room: a.room });
  inventory.scan(tctx, st.id, { code: 'LCH-ED-OLD-117', room: 'Trauma 2' });

  // A few loaners out and retired units for realism.
  for (const a of assets.filter(x => x.d.kind === 'CE' && !TEST_EQUIP.includes(x.key)).slice(0, 5)) db.prepare("UPDATE assets SET status = 'Loaned Out', current_department_id = ? WHERE id = ?").run(pick(departments.filter(d => d.facility.id === a.F.id && d.kind !== 'CE')).id, a.id);
  for (const a of assets.filter(x => x.key === 'lvp_old').slice(0, 3)) db.prepare("UPDATE assets SET status = 'Retired', notes = 'Retired: end of support. Replaced by MV-300. (Demo)' WHERE id = ?").run(a.id);

  summary = { assets: assets.length, pmCount, cmCount, srCount };
  }); // end transaction

  // ---------------- notifications, audit ----------------
  const { pmCount: pmC, cmCount: cmC, srCount: srC } = summary;
  const assetsLen = summary.assets;
  logic.runAlerts({ db, user: null, ip: 'demo' });
  crud.audit({ db, user: { id: db.prepare("SELECT id FROM users WHERE username = 'demo'").get().id, username: 'demo' }, ip: 'demo' }, 'import', null, null, `Demo database generated (seed ${SEED}): ${assetsLen} assets, ${pmC} PM and ${cmC} corrective work orders`);

  const count = t => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
  const perDept = db.prepare('SELECT MIN(n) mn, MAX(n) mx FROM (SELECT COUNT(*) n FROM assets GROUP BY department_id)').get();
  console.log(`Demo database built in ${((Date.now() - t0) / 1000).toFixed(1)}s at ${path.join(DATA_DIR, 'libre.db')}`);
  console.log(`  facilities ${count('facilities')}, departments ${count('departments')}, assets ${count('assets')} (${perDept.mn}-${perDept.mx} per department), models ${count('models')}`);
  console.log(`  PM schedules ${count('pm_schedules')}, work orders ${count('work_orders')} (PM ${pmC}, corrective ${cmC}), test records ${count('test_runs')}`);
  console.log(`  service requests ${srC}, recalls ${count('recalls')}, inventories ${count('inventories')}, UTL events ${count('utl_events')}, parts ${count('parts')}, users ${count('users')}`);
  db.close();
}

main();

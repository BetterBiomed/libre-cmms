// Libre CMMS - Copyright (C) 2026 CreativeMed LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// Built-in reference of typical maintenance practice by device type, used to
// suggest a PM interval, expected service life and criticality when a device is
// looked up. These are general starting points drawn from common clinical
// engineering practice. They are NOT manufacturer requirements. Always confirm
// against the OEM service manual and your organization's AEM / risk-based program
// (for example as described in AAMI EQ56 / EQ89 and CMS guidance).
//
// Each entry: keywords matched against the FDA device name, GMDN term, brand and
// description (lower-case, any keyword matches), plus suggested values.

const REFERENCE = [
  { type: 'Defibrillator / Monitor', kw: ['defibrillator', 'aed', 'cardioverter'], pm: 6, life: 8, crit: 'Life Support', tests: 'Energy output, charge time, sync, pacing, ECG, electrical safety' },
  { type: 'Ventilator', kw: ['ventilator', 'ventilatory'], pm: 6, life: 10, crit: 'Life Support', tests: 'Volume/pressure/flow accuracy, alarms, O2, electrical safety' },
  { type: 'Anesthesia Machine', kw: ['anesthesia', 'anaesthesia', 'gas machine'], pm: 6, life: 12, crit: 'Life Support', tests: 'Leak tests, flow, vaporizer, ventilator, alarms, electrical safety' },
  { type: 'Hemodialysis System', kw: ['dialysis', 'hemodialysis', 'haemodialysis'], pm: 6, life: 7, crit: 'Life Support', tests: 'Conductivity, temperature, pressure, alarms, electrical safety' },
  { type: 'Heart-Lung / Perfusion', kw: ['cardiopulmonary bypass', 'heart-lung', 'perfusion', 'ecmo', 'intra-aortic balloon'], pm: 6, life: 10, crit: 'Life Support', tests: 'OEM performance checks, alarms, electrical safety' },
  { type: 'External Pacemaker', kw: ['pacemaker, external', 'external pacemaker', 'pulse generator, external', 'temporary pacemaker'], pm: 6, life: 8, crit: 'Life Support', tests: 'Rate, output, sensitivity, battery' },
  { type: 'Infant Incubator', kw: ['incubator, neonatal', 'infant incubator', 'neonatal incubator'], pm: 6, life: 10, crit: 'High', tests: 'Temperature, humidity, alarms, electrical safety' },
  { type: 'Infant Warmer', kw: ['infant radiant warmer', 'radiant warmer'], pm: 6, life: 10, crit: 'High', tests: 'Heater output, skin probe, alarms, electrical safety' },
  { type: 'Electrosurgical Unit', kw: ['electrosurgical', 'electrosurgery', 'diathermy', 'cautery'], pm: 6, life: 10, crit: 'High', tests: 'Output power, leakage (RF), REM/CQM, electrical safety' },
  { type: 'Surgical Laser', kw: ['laser, surgical', 'surgical laser', 'laser instrument'], pm: 6, life: 8, crit: 'High', tests: 'Power output, aiming beam, interlocks, electrical safety' },
  { type: 'Syringe Pump', kw: ['syringe pump', 'syringe infusion'], pm: 12, life: 8, crit: 'High', tests: 'Flow accuracy, occlusion, alarms, battery' },
  { type: 'PCA Pump', kw: ['patient controlled analgesia', 'pca'], pm: 12, life: 8, crit: 'High', tests: 'Flow accuracy, lockout, occlusion, alarms' },
  { type: 'Enteral Feeding Pump', kw: ['enteral', 'feeding pump'], pm: 12, life: 7, crit: 'Medium', tests: 'Flow accuracy, occlusion, alarms' },
  { type: 'Infusion Pump', kw: ['infusion pump', 'pump, infusion', 'volumetric', 'large volume'], pm: 12, life: 8, crit: 'High', tests: 'Flow accuracy, occlusion pressure, air-in-line, alarms, battery, electrical safety' },
  { type: 'Patient Monitor', kw: ['patient monitor', 'physiological monitor', 'monitor, physiological', 'multiparameter', 'vital signs', 'bedside monitor', 'arrhythmia detector'], pm: 12, life: 8, crit: 'High', tests: 'ECG, NIBP, SpO2, temperature, IBP, alarms, electrical safety' },
  { type: 'Telemetry System', kw: ['telemetry', 'transmitters and receivers, physiological'], pm: 12, life: 8, crit: 'High', tests: 'Signal, alarms, battery' },
  { type: 'Fetal Monitor', kw: ['fetal', 'perinatal monitor'], pm: 12, life: 8, crit: 'High', tests: 'FHR, toco, ultrasound output, electrical safety' },
  { type: 'Apnea Monitor', kw: ['apnea', 'breathing frequency monitor'], pm: 12, life: 7, crit: 'High', tests: 'Apnea detection, alarms' },
  { type: 'CPAP / BiPAP', kw: ['cpap', 'bipap', 'positive airway pressure', 'noncontinuous ventilator'], pm: 12, life: 7, crit: 'High', tests: 'Pressure accuracy, alarms, filters' },
  { type: 'Blood / Fluid Warmer', kw: ['blood warmer', 'fluid warmer', 'warmer, thermal, infusion', 'blood and plasma warming'], pm: 12, life: 8, crit: 'High', tests: 'Temperature accuracy, over-temperature cut-off, electrical safety' },
  { type: 'Hypo/Hyperthermia Unit', kw: ['hypothermia', 'hyperthermia', 'thermal regulating', 'temperature regulating'], pm: 6, life: 8, crit: 'High', tests: 'Temperature control, over/under temperature, flow, electrical safety' },
  { type: 'Pneumatic Tourniquet', kw: ['tourniquet'], pm: 6, life: 8, crit: 'High', tests: 'Pressure accuracy, leak, alarms' },
  { type: 'Sterilizer', kw: ['sterilizer', 'autoclave'], pm: 3, life: 15, crit: 'High', tests: 'Cycle parameters, door seals, safety valves, biological/chemical indicators' },
  { type: 'X-ray / Radiographic', kw: ['x-ray', 'radiographic', 'fluoroscopic', 'c-arm', 'mammograph'], pm: 6, life: 10, crit: 'High', tests: 'kVp, mA/mAs, timer, HVL, collimation (plus physicist survey)' },
  { type: 'CT Scanner', kw: ['computed tomography', 'ct scanner', 'tomography x-ray'], pm: 3, life: 10, crit: 'High', tests: 'OEM service contract PM, QA phantoms' },
  { type: 'MRI', kw: ['magnetic resonance'], pm: 3, life: 10, crit: 'High', tests: 'OEM service contract PM, QA phantoms, cryogen' },
  { type: 'Ultrasound Scanner', kw: ['ultrasonic', 'ultrasound', 'sonograph', 'transducer, ultrasonic'], pm: 12, life: 7, crit: 'Medium', tests: 'Image quality, transducer leakage, electrical safety' },
  { type: 'Electrocardiograph', kw: ['electrocardiograph', 'ecg', 'ekg'], pm: 12, life: 8, crit: 'Medium', tests: 'Amplitude, frequency response, leads, electrical safety' },
  { type: 'EEG / Neurophysiology', kw: ['electroencephalograph', 'eeg', 'evoked response', 'electromyograph'], pm: 12, life: 8, crit: 'Medium', tests: 'Calibration, impedance, electrical safety' },
  { type: 'Pulse Oximeter', kw: ['oximeter'], pm: 12, life: 7, crit: 'Medium', tests: 'SpO2 and pulse rate accuracy with simulator, alarms' },
  { type: 'NIBP Monitor', kw: ['noninvasive blood pressure', 'blood pressure computer', 'sphygmomanometer'], pm: 12, life: 7, crit: 'Medium', tests: 'Static pressure accuracy, leak, overpressure' },
  { type: 'Suction / Aspirator', kw: ['aspirator', 'suction', 'apparatus, suction'], pm: 12, life: 8, crit: 'Medium', tests: 'Vacuum level, flow, overflow protection' },
  { type: 'Phototherapy Unit', kw: ['phototherapy', 'bilirubin'], pm: 12, life: 8, crit: 'Medium', tests: 'Irradiance, timer, electrical safety' },
  { type: 'Endoscopy Equipment', kw: ['endoscope', 'endoscopic', 'laparoscope', 'video processor', 'light source'], pm: 12, life: 7, crit: 'Medium', tests: 'Image, light output, leak test, electrical safety' },
  { type: 'Surgical Table', kw: ['operating table', 'surgical table', 'table, operating'], pm: 12, life: 15, crit: 'Medium', tests: 'Motion, brakes, hydraulics, battery' },
  { type: 'Surgical Light', kw: ['surgical lamp', 'surgical light', 'operating light', 'operating room light'], pm: 12, life: 15, crit: 'Medium', tests: 'Illuminance, mechanical arms, electrical safety' },
  { type: 'Oxygen Concentrator', kw: ['oxygen concentrator', 'generator, oxygen'], pm: 12, life: 5, crit: 'Medium', tests: 'O2 concentration, flow, filters, alarms' },
  { type: 'Laboratory Analyzer', kw: ['analyzer', 'chemistry', 'hematology', 'coagulation', 'blood gas'], pm: 6, life: 7, crit: 'Medium', tests: 'OEM maintenance and QC' },
  { type: 'Laboratory Centrifuge', kw: ['centrifuge'], pm: 12, life: 10, crit: 'Low', tests: 'Speed (RPM), timer, lid interlock, electrical safety' },
  { type: 'Medical Refrigerator / Freezer', kw: ['refrigerator', 'freezer', 'blood bank'], pm: 12, life: 10, crit: 'Medium', tests: 'Temperature accuracy, alarms, door seals' },
  { type: 'Sequential Compression Device', kw: ['compression', 'compressible limb', 'sleeve, limb'], pm: 12, life: 7, crit: 'Low', tests: 'Pressure, cycle timing' },
  { type: 'Hospital Bed / Stretcher', kw: ['hospital bed', 'bed, ac-powered', 'stretcher', 'bed, flotation'], pm: 12, life: 10, crit: 'Low', tests: 'Motion, brakes, rails, electrical safety' },
  { type: 'Thermometer', kw: ['thermometer'], pm: 12, life: 5, crit: 'Low', tests: 'Accuracy check against reference' },
  { type: 'Scale', kw: ['scale', 'weighing'], pm: 12, life: 10, crit: 'Low', tests: 'Calibration with test weights' },
  { type: 'Bladder Scanner', kw: ['bladder', 'urine volume'], pm: 12, life: 7, crit: 'Low', tests: 'Volume accuracy with phantom' },
  { type: 'Diagnostic Set / Otoscope', kw: ['otoscope', 'ophthalmoscope', 'diagnostic set'], pm: 24, life: 10, crit: 'Low', tests: 'Visual inspection, light output' },
  { type: 'Flowmeter / Regulator', kw: ['flowmeter', 'regulator', 'flow meter'], pm: 24, life: 10, crit: 'Low', tests: 'Flow accuracy, leak' },
];

// Criticality hint by FDA class when no device type matches. No PM interval is
// suggested in that case: unmatched items are often accessories, consumables or
// implants rather than maintainable equipment.
const CRIT_BY_CLASS = { 3: 'High', 2: 'Medium', 1: 'Low' };
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MATCHERS = REFERENCE.map(r => ({ r, re: new RegExp(`\\b(${r.kw.map(escapeRe).join('|')})`, 'i') }));

// texts: in priority order - GMDN term (describes the actual device), FDA product-code
// name (a regulatory category, occasionally mis-assigned by manufacturers), brand, description.
function suggest(texts, deviceClass, lifeSustaining, implant = false) {
  if (implant) return { device_type: null, equipment: false, criticality: null, basis: 'FDA lists this as an implant (no equipment maintenance)' };
  const [gmdn, ...rest] = texts;
  const order = [gmdn, ...rest];
  for (let i = 0; i < order.length; i++) {
    const t = order[i];
    if (!t) continue;
    const m = MATCHERS.find(x => x.re.test(t));
    if (m) {
      const ref = m.r;
      // If the GMDN term exists but did not match, the match is less certain.
      const low = i > 0 && gmdn;
      return {
        device_type: ref.type, equipment: true, confidence: low ? 'low' : 'high', pm_interval_months: ref.pm, expected_life_years: ref.life,
        criticality: lifeSustaining ? 'Life Support' : ref.crit, typical_tests: ref.tests,
        basis: `Libre reference for ${ref.type} (typical practice - confirm with OEM manual / AEM program)`,
        warning: low ? `The GMDN term "${gmdn}" does not look like a ${ref.type}. Verify the device type.` : null,
      };
    }
  }
  return { device_type: null, equipment: false, criticality: lifeSustaining ? 'Life Support' : CRIT_BY_CLASS[String(deviceClass)] || null,
    basis: 'No maintenance reference for this device type (may be an accessory or consumable)' };
}

module.exports = { REFERENCE, suggest };

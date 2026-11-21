// Libre CMMS - Copyright (C) 2026 CreativeMed LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// Device Lookup: from a model / model number (and optionally a manufacturer),
// research the device and suggest catalog data.
//
// Sources, in order:
//   1. This Libre server's own equipment-model catalog.
//   2. FDA Global Unique Device Identification Database (GUDID) via the public
//      openFDA API: manufacturer, brand / common name, model, GMDN term, UDI-DI,
//      FDA product code and device class.
//   3. FDA Product Classification via openFDA: FDA device name, regulation,
//      medical specialty, life-sustaining flag.
//   4. FDA recalls (enforcement reports) via openFDA, importable as Libre recalls.
//   5. Libre's built-in reference table (device-reference.js) for a suggested PM
//      interval, expected life and criticality by device type.
// ECRI, AAMI and OEM resources have no public API; Libre provides direct links.
//
// Only the model / manufacturer text typed by the user is sent to api.fda.gov.
// Responses are cached in the database for 30 days. Set "device_lookup_online"
// to 0 in Settings to disable all internet lookups.
const crud = require('./crud');
const logic = require('./logic');
const { getSetting } = require('../db');
const reference = require('./device-reference');
const { HttpError, getRaw, nowIso } = crud;

const OPENFDA = 'https://api.fda.gov';
const TTL_HIT = 30 * 864e5;
const TTL_MISS = 864e5;
let apiKey = process.env.OPENFDA_API_KEY || '';
function configure(cfg = {}) { if (cfg.openFdaApiKey) apiKey = cfg.openFdaApiKey; }

function ensureCache(db) {
  db.exec('CREATE TABLE IF NOT EXISTS lookup_cache (key TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at TEXT NOT NULL, expires_at TEXT NOT NULL)');
}

// openFDA field values are searched as quoted phrases; strip characters that
// would break the query syntax.
const clean = s => String(s || '').replace(/["\\()[\]{}:+^~*?!]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

class OfflineError extends Error {}

async function fda(db, path, search, extra = {}, refresh = false) {
  ensureCache(db);
  const params = new URLSearchParams({ search, ...extra });
  if (apiKey) params.set('api_key', apiKey);
  const url = `${OPENFDA}${path}?${params.toString().replace(/\+/g, '%20')}`;
  const key = `${path}?${search}&${JSON.stringify(extra)}`;
  if (!refresh) {
    const c = db.prepare('SELECT json, expires_at FROM lookup_cache WHERE key = ?').get(key);
    if (c && c.expires_at > nowIso()) return JSON.parse(c.json);
  }
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { 'User-Agent': 'Libre-CMMS (open-source CMMS)' } });
  } catch (e) {
    throw new OfflineError(`FDA database unreachable (${e.name === 'TimeoutError' ? 'timed out' : e.message}). Is this server connected to the internet?`);
  }
  let body;
  if (res.status === 404) body = { results: [], total: 0 }; // openFDA: no matches
  else if (res.status === 429) throw new OfflineError('FDA lookup rate limit reached. Try again in a minute, or add an openFDA API key in the server config.');
  else if (!res.ok) throw new OfflineError(`FDA database returned HTTP ${res.status}.`);
  else {
    const j = await res.json();
    body = { results: j.results || [], total: j.meta?.results?.total ?? (j.results || []).length };
  }
  const ttl = body.results.length ? TTL_HIT : TTL_MISS;
  db.prepare('INSERT INTO lookup_cache (key, json, fetched_at, expires_at) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at')
    .run(key, JSON.stringify(body), nowIso(), new Date(Date.now() + ttl).toISOString());
  return body;
}

// "CAREFUSION 303, INC." -> "CareFusion 303, Inc." is not knowable; use a readable title case
// that keeps short acronyms (GE, BD, LLC) upper-case.
function niceName(s) {
  if (!s) return s;
  if (s !== s.toUpperCase()) return s.trim();
  const lowerable = new Set(['INC', 'INC.', 'CO', 'CO.', 'CORP', 'CORP.', 'LTD', 'LTD.', 'AND', 'OF', 'THE', 'DBA']);
  return s.trim().split(/\s+/).map(w => {
    const bare = w.replace(/[^A-Z]/g, '');
    if (bare.length <= 3 && !lowerable.has(w.replace(/,$/, ''))) return w;
    return w.charAt(0) + w.slice(1).toLowerCase();
  }).join(' ');
}
// FDA names are "Pump, Infusion" -> "Infusion Pump".
function invertName(s) {
  if (!s) return s;
  const parts = s.split(',').map(x => x.trim()).filter(Boolean);
  const t = parts.length === 2 ? `${parts[1]} ${parts[0]}` : s;
  return t.replace(/\b\w/g, c => c.toUpperCase());
}
const CLASS_LABEL = { 1: 'Class I', 2: 'Class II', 3: 'Class III', U: 'Unclassified', N: 'Not classified', F: 'HDE' };
const stripVersion = s => String(s || '').replace(/\s+v\d+(\.\d+)*\b.*$/i, '').replace(/[™®"]/g, '').replace(/\s+/g, ' ').trim();

// "LIFEPAK12" -> also "LIFEPAK 12"; "LIFEPAK 12" -> also "LIFEPAK12".
function modelVariants(model) {
  const spaced = model.replace(/([a-z])(\d)/gi, '$1 $2').replace(/(\d)([a-z])/gi, '$1 $2').replace(/\s+/g, ' ');
  const compact = model.replace(/[\s-]+/g, '');
  return [...new Set([model, spaced, compact].filter(v => v.length >= 2))].slice(0, 3);
}
// Text of the model as it appears in a device name, e.g. "LIFEPAK 12".
function matchedText(name, vars) {
  for (const v of vars) {
    const i = String(name || '').toLowerCase().indexOf(v.toLowerCase());
    if (i >= 0) return name.slice(i, i + v.length);
  }
  return null;
}
const plain = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); // Dräger -> drager
const normCo = s => plain(s).replace(/[^a-z0-9]/g, '');
// Common parent companies / former names in clinical engineering, so a search for
// the current owner finds devices registered under the original manufacturer.
const COMPANY_ALIASES = {
  bd: ['carefusion', 'alaris', 'becton', 'bard'], beckton: ['becton'], becton: ['carefusion', 'alaris', 'bard'], carefusion: ['becton', 'alaris'],
  stryker: ['physio-control', 'physiocontrol'], physiocontrol: ['stryker'],
  medtronic: ['covidien', 'physio-control', 'nellcor', 'puritan bennett', 'valleylab'], covidien: ['medtronic', 'nellcor', 'puritan bennett', 'valleylab'],
  philips: ['respironics', 'koninklijke'], respironics: ['philips'],
  baxter: ['hill-rom', 'hillrom', 'welch allyn', 'gambro'], hillrom: ['welch allyn', 'baxter'], welchallyn: ['hill-rom', 'baxter'],
  ge: ['datex', 'ohmeda', 'marquette', 'general electric'], gehealthcare: ['datex', 'ohmeda', 'marquette', 'general electric'], datexohmeda: ['ge healthcare'],
  icumedical: ['smiths medical', 'hospira'], smithsmedical: ['icu medical'], hospira: ['icu medical', 'pfizer'],
  getinge: ['maquet', 'datascope'], maquet: ['getinge', 'datascope'], mindray: ['datascope'],
  steris: ['cantel'], draeger: ['drager'], drager: ['draeger'], zoll: ['asahi kasei'], cardinalhealth: ['cardinal'],
  fresenius: ['fresenius kabi', 'fresenius medical'], olympus: ['gyrus'], arjo: ['arjohuntleigh', 'huntleigh'],
};
// Does what the user typed as manufacturer plausibly refer to any of these texts?
function mfMatch(user, ...texts) {
  const u = normCo(user);
  if (!u) return true;
  const names = [user, ...(COMPANY_ALIASES[u] || [])];
  return names.some(name => {
    const v = normCo(name);
    return texts.filter(Boolean).some(t => {
      if (v.length <= 3) return plain(t).split(/[^a-z0-9]+/).includes(v); // "BD", "GE": whole word only
      const n = normCo(t);
      return n.includes(v) || v.includes(n.slice(0, 8)) || (v.length >= 6 && n.includes(v.slice(0, 6)));
    });
  });
}
// Names that indicate an accessory / part rather than the device itself.
const ACCESSORY_RE = /\b(adapters?|cables?|batter(y|ies)|chargers?|kits?|leads?|lead ?wires?|pads?|electrodes?|sensors?|probes?|cuffs?|mounts?|brackets?|cases?|bags?|paper|tubing|filters?|clamps?|holders?|power supply|options?|accessor(y|ies)|software|upgrade)\b/i;
function fmt510k(list) {
  if (!list || !list.length) return null;
  return list.slice(0, 6).map(c => `${c.k} (${String(c.date || '').slice(0, 10)})`).join(', ') + (list.length > 6 ? ` +${list.length - 6} more` : '');
}

function links(model, manufacturer, productCode) {
  const q = encodeURIComponent([manufacturer, model].filter(Boolean).join(' '));
  return [
    { name: 'FDA AccessGUDID (device identifiers)', url: `https://accessgudid.nlm.nih.gov/devices/search?query=${encodeURIComponent(model)}` },
    productCode ? { name: `FDA Product Classification (${productCode})`, url: `https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfPCD/classification.cfm?id=${encodeURIComponent(productCode)}` } : null,
    { name: 'FDA Medical Device Recalls database', url: 'https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfRES/res.cfm' },
    { name: 'ECRI Device Evaluations & UMDNS (membership)', url: 'https://www.ecri.org/solutions/device-evaluations' },
    { name: 'AAMI standards (EQ56 / EQ89 maintenance programs)', url: 'https://www.aami.org/standards' },
    { name: 'OEM service manual / PM interval (web search)', url: `https://duckduckgo.com/?q=${q}%20service%20manual%20preventive%20maintenance%20interval` },
    { name: 'OEM product page (web search)', url: `https://duckduckgo.com/?q=${q}%20medical%20device` },
  ].filter(Boolean);
}

function localMatches(db, model, manufacturer) {
  const w = ['(model LIKE ? OR description LIKE ? OR common_name LIKE ?)']; const p = [`%${model}%`, `%${model}%`, `%${model}%`];
  if (manufacturer) { w.push('manufacturer LIKE ?'); p.push(`%${manufacturer}%`); }
  return db.prepare(`SELECT m.*, (SELECT COUNT(*) FROM assets a WHERE a.model_id = m.id) asset_count FROM models m WHERE ${w.join(' AND ')} ORDER BY manufacturer, model LIMIT 10`).all(...p);
}

async function lookup(ctx, q = {}) {
  const db = ctx.db;
  const model = clean(q.model);
  const manufacturer = clean(q.manufacturer);
  if (!model) throw new HttpError(400, 'Enter a model or model number.');
  const out = { query: { model, manufacturer }, local: localMatches(db, model, manufacturer), candidates: [], online: false, message: null,
    links: links(model, manufacturer), sources: [] };
  if (getSetting(db, 'device_lookup_online', '1') === '0') {
    out.message = 'Internet lookups are turned off in Settings. Showing your catalog and reference links only.';
    return out;
  }
  try {
    // Search on the model as typed plus spacing variants ("LIFEPAK12" / "LIFEPAK 12").
    // The manufacturer is NOT sent to the FDA: company names vary (Physio-Control,
    // Medtronic Physio-Control Corp., ...), so results are matched loosely below.
    const vars = modelVariants(model);
    const anyOf = fields => `(${fields.flatMap(f => vars.map(v => `${f}:"${v}"`)).join(' ')})`;
    const udi = await fda(db, '/device/udi.json', anyOf(['version_or_model_number', 'catalog_number', 'brand_name']), { limit: '100' }, !!q.refresh);
    const rows = udi.results;
    // FDA 510(k) clearances cover older and discontinued models that never received
    // UDI records (UDI labeling was phased in from 2014).
    const k510 = await fda(db, '/device/510k.json', anyOf(['device_name']), { limit: '100' }, !!q.refresh);
    out.online = true;
    out.sources.push({ name: 'FDA GUDID via openFDA', records: rows.length }, { name: 'FDA 510(k) clearances via openFDA', records: k510.results.length });

    // Group package / software-version variants of the same model.
    const groups = new Map();
    for (const r of rows) {
      const mdl = (r.version_or_model_number || r.catalog_number || '').trim();
      const key = `${(r.company_name || '').toUpperCase()}|${mdl.toUpperCase()}`;
      const g = groups.get(key) || { company: r.company_name, model: mdl, brands: new Set(), descs: new Set(), gmdn: new Set(), codes: new Map(), dis: [], variants: 0, mri: new Set() };
      g.variants++;
      if (r.brand_name) g.brands.add(stripVersion(r.brand_name));
      if (r.device_description) g.descs.add(stripVersion(r.device_description));
      for (const t of r.gmdn_terms || []) if (t.name) g.gmdn.add(t.name);
      for (const pc of r.product_codes || []) if (pc.code && !g.codes.has(pc.code)) g.codes.set(pc.code, { code: pc.code, name: pc.name, device_class: pc.openfda?.device_class });
      const di = (r.identifiers || []).find(i => i.type === 'Primary') || (r.identifiers || [])[0];
      if (di?.id && g.dis.length < 3) g.dis.push(di.id);
      if (r.mri_safety) g.mri.add(r.mri_safety);
      groups.set(key, g);
    }
    const ml = model.toLowerCase();
    const list = [...groups.values()].sort((a, b) => (b.model.toLowerCase() === ml) - (a.model.toLowerCase() === ml) || b.variants - a.variants).slice(0, 12);

    // 510(k) clearances, grouped by product code. Attach them to a matching UDI result,
    // otherwise they become their own candidate (typical for older devices).
    const kGroups = new Map();
    for (const r of k510.results) {
      const code = r.product_code || '?';
      const g = kGroups.get(code) || { code, names: [], clearances: [], device_class: r.openfda?.device_class, fda_name: r.openfda?.device_name };
      g.names.push(r.device_name);
      g.clearances.push({ k: r.k_number, date: r.decision_date, name: r.device_name, applicant: r.applicant });
      kGroups.set(code, g);
    }
    const kOnly = [];
    for (const g of kGroups.values()) {
      g.clearances.sort((a, b) => String(b.date).localeCompare(String(a.date)));
      // Same product code and either the same company (any spelling) or the exact model
      // number - e.g. Alaris 8015 was cleared under "Cardinal Health 303", now CareFusion 303.
      const udiMatch = list.find(u => u.codes.has(g.code) && (u.model.toLowerCase() === ml || mfMatch(g.clearances[0].applicant, u.company, [...u.brands].join(' '))));
      if (udiMatch) { udiMatch.clearances = g.clearances; continue; }
      kOnly.push(g);
    }

    // FDA product classification for all product codes involved (one request).
    const codes = [...new Set([...list.flatMap(g => [...g.codes.keys()]), ...kOnly.map(g => g.code)])].filter(c => c !== '?').slice(0, 20);
    const cls = new Map();
    if (codes.length) {
      const c = await fda(db, '/device/classification.json', codes.map(x => `product_code:"${clean(x)}"`).join(' '), { limit: '50' }, !!q.refresh);
      for (const r of c.results) cls.set(r.product_code, r);
      out.sources.push({ name: 'FDA Product Classification via openFDA', records: c.results.length });
    }

    out.candidates = list.map(g => {
      const pcs = [...g.codes.values()];
      const primary = pcs[0];
      const c = primary ? cls.get(primary.code) : null;
      const devClass = c?.device_class || primary?.device_class;
      const lifeSustaining = c?.life_sustain_support_flag === 'Y';
      const brand = [...g.brands].sort((a, b) => a.length - b.length)[0] || null;
      const desc = [...g.descs].sort((a, b) => a.length - b.length)[0] || null;
      const gmdn = [...g.gmdn][0] || null;
      const fdaName = c?.device_name || primary?.name || null;
      const implant = c?.implant_flag === 'Y';
      // A brand like "LIFEPAK 15 AC Power Adapter" is a part, not the device itself.
      const accessory = ACCESSORY_RE.test(brand || desc || '');
      const sug = accessory ? { equipment: false, criticality: null, basis: `Appears to be an accessory or part (${brand || desc})` }
        : reference.suggest([gmdn, fdaName, brand, desc], devClass, lifeSustaining, implant);
      const manufacturerName = niceName(g.company);
      return {
        manufacturer: manufacturerName, model: g.model, common_name: brand, description: desc, gmdn_term: gmdn,
        fda_product_code: primary?.code || null, other_product_codes: pcs.slice(1).map(p => p.code),
        fda_device_name: fdaName, risk_class: CLASS_LABEL[devClass] || null, regulation_number: c?.regulation_number || null,
        medical_specialty: c?.medical_specialty_description || null, life_sustaining: lifeSustaining,
        udi_di: g.dis[0] || null, variants: g.variants, equipment: !!sug.equipment, confidence: sug.confidence || null, warning: sug.warning || null, implant, mri_safety: [...g.mri][0] || null,
        category: sug.device_type || invertName(fdaName) || null,
        criticality: sug.criticality || null, pm_interval_months: sug.pm_interval_months || null,
        expected_life_years: sug.expected_life_years || null, typical_tests: sug.typical_tests || null,
        basis: {
          manufacturer: 'FDA GUDID', model: 'FDA GUDID', common_name: 'FDA GUDID brand name', gmdn_term: 'FDA GUDID (GMDN)',
          risk_class: c ? 'FDA Product Classification' : 'FDA GUDID', category: sug.device_type ? sug.basis : 'FDA device name',
          criticality: lifeSustaining ? 'FDA life-sustaining flag' : sug.device_type ? sug.basis : sug.criticality ? `FDA ${CLASS_LABEL[devClass]}` : null,
          pm_interval_months: sug.basis, expected_life_years: sug.basis,
        },
        links: links(g.model, manufacturerName, primary?.code),
        source: 'udi', fda_510k: fmt510k(g.clearances), accessory,
        note: accessory ? 'This record looks like an accessory or part; pick the device itself if it is listed.' : null,
        // Every brand / description seen, for manufacturer matching (not displayed).
        match_text: [...g.brands, ...g.descs].join(' | ').slice(0, 1000),
      };
    });

    // Candidates known only from 510(k) clearances.
    for (const g of kOnly) {
      const c = cls.get(g.code);
      const latest = g.clearances[0];
      const devClass = c?.device_class || g.device_class;
      const lifeSustaining = c?.life_sustain_support_flag === 'Y';
      const implant = c?.implant_flag === 'Y';
      const fdaName = c?.device_name || g.fda_name || null;
      // Prefer clearance names that start with the model ("LIFEPAK 12 ...") over add-on
      // clearances that merely mention it ("NIBP OPTIONS FOR THE ... LIFEPAK 12").
      const startsWithModel = n => vars.some(v => String(n).toLowerCase().startsWith(v.toLowerCase()));
      const own = g.names.filter(startsWithModel);
      // Only an accessory if no clearance is for the device itself and the names say so.
      const accessory = !own.length && g.names.every(n => ACCESSORY_RE.test(n));
      const names = (own.length ? own : g.names).slice().sort((a, b) => a.length - b.length);
      const modelText = matchedText(names[0], vars) || model;
      const longest = names[names.length - 1];
      const sug = accessory ? { equipment: false, criticality: null, basis: `Appears to be an option or accessory for ${modelText}` }
        : reference.suggest([fdaName, longest, names[0]], devClass, lifeSustaining, implant);
      const manufacturerName = niceName(latest.applicant);
      out.candidates.push({
        manufacturer: manufacturerName, model: modelText, common_name: names[0], description: longest !== names[0] ? longest : null, gmdn_term: null,
        fda_product_code: g.code !== '?' ? g.code : null, other_product_codes: [], fda_device_name: fdaName, risk_class: CLASS_LABEL[devClass] || null,
        regulation_number: c?.regulation_number || null, medical_specialty: c?.medical_specialty_description || null, life_sustaining: lifeSustaining,
        udi_di: null, variants: g.clearances.length, equipment: !!sug.equipment, confidence: sug.confidence || null, warning: sug.warning || null, implant,
        category: sug.device_type || invertName(fdaName) || null, criticality: sug.criticality || null, pm_interval_months: sug.pm_interval_months || null,
        expected_life_years: sug.expected_life_years || null, typical_tests: sug.typical_tests || null,
        source: '510k', fda_510k: fmt510k(g.clearances), accessory, match_text: g.clearances.map(x => x.applicant).join(' | '), first_cleared: g.clearances[g.clearances.length - 1].date, last_cleared: latest.date,
        note: accessory ? `This clearance covers an option or accessory that mentions ${modelText}, not the device itself.`
          : `Not in the FDA UDI database: ${modelText} predates UDI labeling or is discontinued. Details come from ${g.clearances.length} FDA 510(k) clearance(s), ${g.clearances[g.clearances.length - 1].date?.slice(0, 4)}-${latest.date?.slice(0, 4)}. Check the manufacturer's current support / end-of-life status.`,
        basis: {
          manufacturer: `FDA 510(k) ${latest.k} (latest clearance holder)`, model: 'FDA 510(k) device name', common_name: 'FDA 510(k) device name',
          risk_class: c ? 'FDA Product Classification' : 'FDA 510(k)', category: sug.device_type ? sug.basis : 'FDA device name',
          criticality: lifeSustaining ? 'FDA life-sustaining flag' : sug.device_type ? sug.basis : sug.criticality ? `FDA ${CLASS_LABEL[devClass]}` : null,
          pm_interval_months: sug.basis, expected_life_years: sug.basis, fda_510k: 'FDA 510(k) database',
        },
        links: links(modelText, manufacturerName, g.code !== '?' ? g.code : null),
      });
    }

    // Manufacturer: match loosely (punctuation, spacing, parent companies, brand names).
    let hidden = 0;
    if (manufacturer) {
      const hit = out.candidates.filter(c => mfMatch(manufacturer, c.manufacturer, c.common_name, c.description, c.match_text));
      if (hit.length) { hidden = out.candidates.length - hit.length; out.candidates = hit; }
      else if (out.candidates.length) out.message = `No results list "${manufacturer}" as the manufacturer; showing all matches for ${model}.`;
    }
    // Maintainable equipment first, then the original order (exact model match, most records).
    out.candidates = out.candidates.map((c, i) => ({ c, i })).sort((a, b) => ((b.c.equipment && b.c.confidence === 'high') - (a.c.equipment && a.c.confidence === 'high')) || (b.c.equipment - a.c.equipment) || a.i - b.i).map(x => x.c);
    if (hidden) out.hidden = hidden;
    if (out.candidates[0]) out.links = out.candidates[0].links;
    if (!out.candidates.length) out.message = 'No match in the FDA device databases (UDI and 510(k)). Check the model number, try the catalog/REF number on the device label, or enter details manually.';
  } catch (e) {
    if (!(e instanceof OfflineError)) throw e;
    out.message = e.message;
  }
  return out;
}

// Recent FDA recalls (enforcement reports) for a model.
async function recalls(ctx, q = {}) {
  const db = ctx.db;
  const model = clean(q.model);
  const manufacturer = clean(q.manufacturer);
  if (!model) throw new HttpError(400, 'Model required');
  if (getSetting(db, 'device_lookup_online', '1') === '0') return { online: false, rows: [] };
  const firm = manufacturer.split(' ')[0];
  const search = `product_description:"${model}"${firm ? ` AND recalling_firm:"${firm}"` : ''}`;
  try {
    const r = await fda(db, '/device/enforcement.json', search, { limit: '25', sort: 'recall_initiation_date:desc' }, !!q.refresh);
    const fmt = d => (d && d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : d);
    const rows = r.results.map(x => ({
      recall_number: x.recall_number, classification: x.classification, status: x.status, initiated: fmt(x.recall_initiation_date),
      firm: x.recalling_firm, product_description: x.product_description, reason: x.reason_for_recall, code_info: x.code_info,
      already_imported: !!db.prepare('SELECT 1 FROM recalls WHERE recall_number = ?').get(x.recall_number),
    }));
    return { online: true, total: r.total, rows };
  } catch (e) {
    if (e instanceof OfflineError) return { online: false, rows: [], message: e.message };
    throw e;
  }
}

const MODEL_FIELDS = ['manufacturer', 'model', 'description', 'category', 'risk_class', 'criticality', 'pm_interval_months', 'expected_life_years', 'fda_510k',
  'common_name', 'fda_product_code', 'fda_device_name', 'regulation_number', 'medical_specialty', 'gmdn_term', 'udi_di', 'life_sustaining', 'umdns_code'];

// Save lookup results as an equipment model (create, or fill in an existing one).
function apply(ctx, body = {}) {
  if (!['admin', 'supervisor', 'technician'].includes(ctx.user?.role)) throw new HttpError(403, 'Not permitted');
  const db = ctx.db;
  const data = {};
  for (const k of MODEL_FIELDS) if (body[k] !== undefined && body[k] !== '') data[k] = body[k];
  if (data.life_sustaining !== undefined) data.life_sustaining = data.life_sustaining ? 1 : 0;
  if (!data.manufacturer || !data.model) throw new HttpError(400, 'Manufacturer and model are required.');
  const sctx = logic.sys(ctx);
  const existing = body.model_id ? getRaw(db, 'models', Number(body.model_id))
    : db.prepare('SELECT * FROM models WHERE manufacturer = ? COLLATE NOCASE AND model = ? COLLATE NOCASE').get(data.manufacturer, data.model);
  const stamp = { lookup_source: String(body.lookup_source || 'Libre Device Lookup').slice(0, 200), lookup_at: nowIso() };
  if (existing) {
    // Never overwrite what the user already entered unless asked to.
    const upd = {};
    for (const [k, v] of Object.entries(data)) if (body.overwrite || existing[k] == null || existing[k] === '') upd[k] = v;
    const row = crud.update(sctx, 'models', existing.id, { ...upd, ...stamp });
    return { row: crud.get(ctx, 'models', row.id), created: false, updated_fields: Object.keys(upd) };
  }
  const row = crud.create(sctx, 'models', { ...data, ...stamp });
  return { row: crud.get(ctx, 'models', row.id), created: true };
}

// Import an FDA recall into Libre's recall module.
function importRecall(ctx, body = {}) {
  if (!['admin', 'supervisor', 'technician'].includes(ctx.user?.role)) throw new HttpError(403, 'Not permitted');
  const db = ctx.db;
  if (!body.recall_number) throw new HttpError(400, 'Recall number required');
  const dup = db.prepare('SELECT id FROM recalls WHERE recall_number = ?').get(body.recall_number);
  if (dup) return { row: getRaw(db, 'recalls', dup.id), created: false };
  const cls = ['Class I', 'Class II', 'Class III'].includes(body.classification) ? body.classification : 'Advisory';
  const row = crud.create(logic.sys(ctx), 'recalls', {
    recall_number: body.recall_number, source: 'FDA Recall', classification: cls,
    title: String(body.reason || body.product_description || body.recall_number).split(/[.;\n]/)[0].slice(0, 200),
    issued_date: /^\d{4}-\d{2}-\d{2}$/.test(body.initiated || '') ? body.initiated : null,
    manufacturer: body.firm || null, model_id: body.model_id ? Number(body.model_id) : null, model_text: body.model || null,
    description: [body.product_description, body.code_info ? `Affected codes / lots: ${body.code_info}` : null].filter(Boolean).join('\n\n').slice(0, 20000),
    action_required: body.reason || null, status: 'Open',
  });
  crud.audit(ctx, 'import', 'recalls', row.id, `Imported FDA recall ${body.recall_number}`);
  return { row, created: true };
}

module.exports = { lookup, recalls, apply, importRecall, configure, niceName, invertName, clean };

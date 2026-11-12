// Libre CMMS - Copyright (C) 2026 CreativeMed LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// Inventory Mode: scan a department's equipment, flag problems, update each
// asset's CURRENT location (never its owning department), and record
// Unable To Locate (UTL) for anything not found.
const crud = require('./crud');
const logic = require('./logic');
const { tx } = require('../db');
const { HttpError, getRaw, today, nowIso } = crud;

const WRITER = u => u && ['admin', 'supervisor', 'technician'].includes(u.role);
const OPEN_WO = "('Completed','Closed','Cancelled')";

function monthBounds(t = today()) {
  const start = t.slice(0, 8) + '01';
  const end = logic.addDays(logic.addMonths(start, 1), -1);
  return { start, end };
}

// Flag rules. Red: previously UTL, open recall, open repair, out of service,
// retired/disposed, not in inventory. Yellow: end-of-life letter / end of support,
// PM due this month (or overdue). Info: belongs to another department.
function assetFlags(db, a, deptId) {
  const flags = [];
  const t = today();
  const { start, end } = monthBounds(t);
  if (a.utl_since) flags.push({ level: 'red', code: 'utl', text: `Previously Unable To Locate (since ${a.utl_since})` });
  const recalls = db.prepare(`SELECT r.id, r.recall_number, r.title, r.classification, r.action_required FROM recall_assets ra
    JOIN recalls r ON r.id = ra.recall_id WHERE ra.asset_id = ? AND ra.status = 'Affected' AND r.status IN ('Open','In Progress')`).all(a.id);
  for (const r of recalls) {
    flags.push({ level: 'red', code: 'recall', alert: true, link: `#/recalls/${r.id}`,
      text: `OPEN RECALL ${r.recall_number || ''} ${r.classification ? '(' + r.classification + ')' : ''}: ${r.title}${r.action_required ? ' - Action: ' + r.action_required : ''}`.replace(/\s+/g, ' ').trim() });
  }
  for (const w of db.prepare(`SELECT id, wo_number, problem FROM work_orders WHERE asset_id = ? AND type = 'Corrective' AND status NOT IN ${OPEN_WO}`).all(a.id)) {
    flags.push({ level: 'red', code: 'repair', link: `#/work_orders/${w.id}`, text: `Open repair ${w.wo_number}: ${String(w.problem || '').split('\n')[0].slice(0, 100)}` });
  }
  if (a.status === 'Out of Service') flags.push({ level: 'red', code: 'oos', text: 'Marked OUT OF SERVICE' });
  if (['Retired', 'Disposed'].includes(a.status)) flags.push({ level: 'red', code: 'retired', text: `Asset is ${a.status.toLowerCase()} but was found in use` });
  // End-of-life: an end-of-support date on the asset or model, or an EOL letter on file.
  const m = a.model_id ? getRaw(db, 'models', a.model_id) : null;
  const eos = a.end_of_support || m?.end_of_support;
  const letter = db.prepare(`SELECT title FROM documents WHERE doc_type = 'End of Life / End of Support Letter' AND (asset_id = ? OR (model_id IS NOT NULL AND model_id = ?)) LIMIT 1`).get(a.id, a.model_id ?? -1);
  if (eos || letter) flags.push({ level: 'yellow', code: 'eol', text: `End-of-life notice${eos ? `: end of support ${eos}${eos < t ? ' (passed)' : ''}` : ''}${letter ? ` - letter "${letter.title}"` : ''}` });
  const pm = db.prepare(`SELECT MIN(next_due) d FROM pm_schedules WHERE asset_id = ? AND active = 1 AND next_due <= ?`).get(a.id, end).d;
  const pmWo = db.prepare(`SELECT MIN(due_date) d FROM work_orders WHERE asset_id = ? AND pm_schedule_id IS NOT NULL AND status NOT IN ${OPEN_WO} AND due_date <= ?`).get(a.id, end).d;
  const due = [pm, pmWo].filter(Boolean).sort()[0];
  if (due) flags.push({ level: 'yellow', code: 'pm', text: due < start ? `PM overdue (was due ${due})` : `PM due this month (${due})` });
  if (deptId && a.department_id !== deptId) {
    const d = a.department_id ? getRaw(db, 'departments', a.department_id) : null;
    flags.push({ level: 'info', code: 'other_dept', text: `Owned by ${d ? d.name : 'no department'} - current location will be updated` });
  }
  return flags;
}
const levelOf = flags => (flags.some(f => f.level === 'red') ? 'Red' : flags.some(f => f.level === 'yellow') ? 'Yellow' : 'None');

function assetBrief(db, a) {
  const m = a.model_id ? getRaw(db, 'models', a.model_id) : null;
  return { id: a.id, asset_tag: a.asset_tag, serial_number: a.serial_number, description: a.description || (m ? `${m.manufacturer} ${m.model}` : ''),
    model: m ? `${m.manufacturer} ${m.model}` : '', category: m?.category || '', status: a.status, room: a.room, current_room: a.current_room,
    department_id: a.department_id, current_department_id: a.current_department_id, last_seen_at: a.last_seen_at, utl_since: a.utl_since };
}

function expectedAssets(db, deptId) {
  return db.prepare(`SELECT * FROM assets WHERE status NOT IN ('Retired','Disposed') AND (department_id = ? OR current_department_id = ?) ORDER BY asset_tag`).all(deptId, deptId);
}

function start(ctx, body) {
  if (!WRITER(ctx.user)) throw new HttpError(403, 'Not permitted');
  const db = ctx.db;
  const dept = getRaw(db, 'departments', Number(body.department_id));
  if (!dept) throw new HttpError(400, 'Choose a department.');
  const facilityId = Number(body.facility_id) || dept.facility_id;
  if (dept.facility_id && facilityId && dept.facility_id !== facilityId) throw new HttpError(400, 'That department belongs to a different facility.');
  const open = db.prepare("SELECT id FROM inventories WHERE department_id = ? AND status = 'In Progress'").get(dept.id);
  if (open) return { id: open.id, resumed: true };
  return tx(db, () => {
    const inv = crud.create(logic.sys(ctx), 'inventories', {
      facility_id: facilityId || null, department_id: dept.id, status: 'In Progress', started_at: nowIso(), started_by: ctx.user.full_name,
      expected_count: expectedAssets(db, dept.id).length, notes: body.notes || null,
    });
    return { id: inv.id, resumed: false };
  });
}

function session(ctx, id) {
  const db = ctx.db;
  const inv = crud.get(ctx, 'inventories', id);
  const scans = db.prepare(`SELECT s.*, a.asset_tag, COALESCE(a.description, m.manufacturer || ' ' || m.model) description, a.serial_number
    FROM inventory_scans s LEFT JOIN assets a ON a.id = s.asset_id LEFT JOIN models m ON m.id = a.model_id
    WHERE s.inventory_id = ? ORDER BY s.id DESC`).all(id);
  const scannedIds = new Set(scans.filter(s => s.asset_id).map(s => s.asset_id));
  const expected = expectedAssets(db, inv.department_id).map(a => {
    const flags = assetFlags(db, a, inv.department_id);
    return { ...assetBrief(db, a), scanned: scannedIds.has(a.id), flag_level: levelOf(flags), flags };
  });
  for (const s of scans) s.flags = s.flags_json ? JSON.parse(s.flags_json) : [];
  return { inventory: inv, expected, scans };
}

function scan(ctx, id, body) {
  if (!WRITER(ctx.user)) throw new HttpError(403, 'Not permitted');
  const db = ctx.db;
  const inv = getRaw(db, 'inventories', id);
  if (!inv) throw new HttpError(404, 'Inventory not found');
  if (inv.status !== 'In Progress') throw new HttpError(409, 'This inventory is no longer in progress.');
  let code = String(body.code || '').trim();
  const urlTag = code.match(/[?&]asset=([^&#]+)/); // label QR codes contain the portal link
  if (urlTag) code = decodeURIComponent(urlTag[1]);
  if (!code) throw new HttpError(400, 'Scan or type an asset tag.');
  const room = String(body.room || '').trim().slice(0, 100) || null;
  const a = logic.findAssetByText(db, code);
  if (a) {
    const dup = db.prepare('SELECT * FROM inventory_scans WHERE inventory_id = ? AND asset_id = ?').get(id, a.id);
    if (dup) {
      if (room && room !== dup.room) db.prepare('UPDATE inventory_scans SET room = ? WHERE id = ?').run(room, dup.id);
      return { duplicate: true, scan: { ...dup, room: room || dup.room, flags: JSON.parse(dup.flags_json || '[]') }, asset: assetBrief(db, a) };
    }
  } else {
    const dup = db.prepare("SELECT * FROM inventory_scans WHERE inventory_id = ? AND asset_id IS NULL AND scanned_code = ? COLLATE NOCASE").get(id, code);
    if (dup) return { duplicate: true, notFound: true, scan: { ...dup, flags: JSON.parse(dup.flags_json || '[]') } };
  }
  const flags = a ? assetFlags(db, a, inv.department_id) : [{ level: 'red', code: 'not_found', text: `"${code}" is not in the equipment inventory` }];
  const result = !a ? 'Not In Inventory' : a.department_id === inv.department_id || a.current_department_id === inv.department_id ? 'Found' : 'Found - Other Department';
  const scanId = crud.insertRow(db, 'inventory_scans', {
    inventory_id: id, scanned_at: nowIso(), scanned_code: code, asset_id: a ? a.id : null, room, result,
    flag_level: levelOf(flags), flag_text: flags.filter(f => f.level !== 'info').map(f => f.text).join('\n') || null,
    flags_json: JSON.stringify(flags), scanned_by: ctx.user.full_name, created_at: nowIso(), created_by: ctx.user.username,
  });
  return { scan: { ...getRaw(db, 'inventory_scans', scanId), flags }, asset: a ? assetBrief(db, a) : null, notFound: !a };
}

// After a "not in inventory" scan, the user adds the asset; link it to the scan.
function linkScan(ctx, id, scanId, body) {
  if (!WRITER(ctx.user)) throw new HttpError(403, 'Not permitted');
  const db = ctx.db;
  const s = db.prepare('SELECT * FROM inventory_scans WHERE id = ? AND inventory_id = ?').get(scanId, id);
  if (!s) throw new HttpError(404, 'Scan not found');
  const a = getRaw(db, 'assets', Number(body.asset_id));
  if (!a) throw new HttpError(400, 'Asset not found');
  const inv = getRaw(db, 'inventories', id);
  const flags = [{ level: 'red', code: 'not_found', text: `"${s.scanned_code}" was not in the equipment inventory - added as ${a.asset_tag}` },
    ...assetFlags(db, a, inv.department_id).filter(f => f.code !== 'other_dept')];
  db.prepare('UPDATE inventory_scans SET asset_id = ?, result = ?, flag_level = ?, flag_text = ?, flags_json = ? WHERE id = ?')
    .run(a.id, 'Added To Inventory', 'Red', flags.map(f => f.text).join('\n'), JSON.stringify(flags), scanId);
  crud.audit(ctx, 'inventory', 'inventories', id, `Added ${a.asset_tag} from scan "${s.scanned_code}"`);
  return { scan: { ...getRaw(db, 'inventory_scans', scanId), flags }, asset: assetBrief(db, a) };
}

function removeScan(ctx, id, scanId) {
  if (!WRITER(ctx.user)) throw new HttpError(403, 'Not permitted');
  const inv = getRaw(ctx.db, 'inventories', id);
  if (!inv || inv.status !== 'In Progress') throw new HttpError(409, 'Inventory is not in progress.');
  const n = ctx.db.prepare('DELETE FROM inventory_scans WHERE id = ? AND inventory_id = ?').run(scanId, id).changes;
  if (!n) throw new HttpError(404, 'Scan not found');
  return { ok: true };
}

// Completing updates every scanned asset's current location, resolves previous
// UTLs, and marks the chosen unscanned assets Unable To Locate.
function complete(ctx, id, body = {}) {
  if (!WRITER(ctx.user)) throw new HttpError(403, 'Not permitted');
  const db = ctx.db;
  const inv = getRaw(db, 'inventories', id);
  if (!inv) throw new HttpError(404, 'Inventory not found');
  if (inv.status !== 'In Progress') throw new HttpError(409, 'Inventory is already finished.');
  const dept = getRaw(db, 'departments', inv.department_id);
  const sctx = logic.sys(ctx);
  return tx(db, () => {
    const scans = db.prepare('SELECT * FROM inventory_scans WHERE inventory_id = ? AND asset_id IS NOT NULL').all(id);
    const seen = new Set();
    const stamp = nowIso();
    for (const s of scans) {
      if (seen.has(s.asset_id)) continue;
      seen.add(s.asset_id);
      const a = getRaw(db, 'assets', s.asset_id);
      const from = [a.current_department_id ? getRaw(db, 'departments', a.current_department_id)?.name : null, a.current_room].filter(Boolean).join(' / ') || '(unknown)';
      const to = [dept.name, s.room].filter(Boolean).join(' / ');
      const upd = { current_facility_id: inv.facility_id || dept.facility_id || null, current_department_id: dept.id, last_seen_at: s.scanned_at || stamp, last_inventory_id: id };
      if (s.room) upd.current_room = s.room;
      else if (a.current_department_id !== dept.id) upd.current_room = null;
      crud.update(sctx, 'assets', a.id, upd);
      if (from !== to) {
        crud.insertRow(db, 'asset_moves', { asset_id: a.id, moved_at: stamp, from_text: `Current: ${from}`, to_text: `Current: ${to} (${inv.inventory_number})`, moved_by: ctx.user.username, created_at: stamp });
      }
      if (a.utl_since) logic.resolveUtl(ctx, a.id, `Found in inventory ${inv.inventory_number} (${dept.name}${s.room ? ', ' + s.room : ''})`);
    }
    // Unscanned expected assets the user chose to mark Unable To Locate.
    const expected = new Map(expectedAssets(db, dept.id).map(a => [a.id, a]));
    const utlIds = [].concat(body.utl_asset_ids || []).map(Number).filter(x => expected.has(x) && !seen.has(x));
    for (const aid of utlIds) logic.markUtl(ctx, aid, { source: 'Inventory', inventory_id: id, notes: `Not found during inventory ${inv.inventory_number} of ${dept.name}` });

    const all = db.prepare('SELECT * FROM inventory_scans WHERE inventory_id = ?').all(id);
    // Assets added during this inventory are reported separately, so expected = found + not located.
    const added = new Set(all.filter(s => s.result === 'Added To Inventory').map(s => s.asset_id));
    const counts = {
      expected_count: [...expected.keys()].filter(x => !added.has(x)).length,
      found_count: [...seen].filter(x => expected.has(x) && !added.has(x)).length,
      missing_count: utlIds.length,
      unexpected_count: all.filter(s => s.result === 'Found - Other Department').length,
      added_count: all.filter(s => s.result === 'Added To Inventory').length,
      red_count: all.filter(s => s.flag_level === 'Red').length + utlIds.length,
      yellow_count: all.filter(s => s.flag_level === 'Yellow').length,
    };
    crud.update(sctx, 'inventories', id, { status: 'Completed', completed_at: nowIso(), completed_by: ctx.user.full_name, notes: body.notes ?? inv.notes, ...counts });
    crud.audit(ctx, 'inventory', 'inventories', id, `Completed ${inv.inventory_number}: ${counts.found_count} found, ${counts.missing_count} unable to locate, ${counts.red_count} red, ${counts.yellow_count} yellow`);
    return getRaw(db, 'inventories', id);
  });
}

function cancel(ctx, id) {
  if (!WRITER(ctx.user)) throw new HttpError(403, 'Not permitted');
  const inv = getRaw(ctx.db, 'inventories', id);
  if (!inv || inv.status !== 'In Progress') throw new HttpError(409, 'Inventory is not in progress.');
  crud.update(logic.sys(ctx), 'inventories', id, { status: 'Cancelled', completed_at: nowIso(), completed_by: ctx.user.full_name });
  return getRaw(ctx.db, 'inventories', id);
}

module.exports = { assetFlags, start, session, scan, linkScan, removeScan, complete, cancel, monthBounds };

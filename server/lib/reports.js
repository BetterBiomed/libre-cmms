// Libre CMMS - Copyright (C) 2026 CreativeMed LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// Dashboard KPIs and the report library. Every report returns
// { title, columns: [{key, label, type}], rows } and can be exported to CSV.
const { today } = require('./crud');
const { addMonths, addDays } = require('./logic');

const DONE = "('Completed','Closed')";
const OPEN = "('Completed','Closed','Cancelled')";
const PM_TYPES = "('Preventive','Inspection','Calibration','Safety Inspection')";

function assetFilter(q, alias = 'a') {
  const w = []; const p = [];
  if (q.facility_id) { w.push(`${alias}.facility_id = ?`); p.push(Number(q.facility_id)); }
  if (q.department_id) { w.push(`${alias}.department_id = ?`); p.push(Number(q.department_id)); }
  if (q.model_id) { w.push(`${alias}.model_id = ?`); p.push(Number(q.model_id)); }
  if (q.category) { w.push(`${alias}.model_id IN (SELECT id FROM models WHERE category = ?)`); p.push(q.category); }
  if (q.manufacturer) { w.push(`${alias}.model_id IN (SELECT id FROM models WHERE manufacturer = ?)`); p.push(q.manufacturer); }
  return { w, p };
}
const range = q => ({ from: q.from || addDays(today(), -365), to: q.to || today() });
const r2 = x => (x == null ? null : Math.round(x * 100) / 100);

function dashboard(db, user) {
  const t = today();
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const monthStart = t.slice(0, 8) + '01';
  const series = [];
  for (let i = 5; i >= 0; i--) {
    const start = addMonths(monthStart, -i);
    const end = addMonths(start, 1);
    const r = one(`SELECT COUNT(*) total, SUM(CASE WHEN status IN ${DONE} THEN 1 ELSE 0 END) done,
      SUM(CASE WHEN status IN ${DONE} AND substr(completed_at,1,10) <= date(due_date, '+' || COALESCE((SELECT grace_days FROM pm_schedules s WHERE s.id = pm_schedule_id), 30) || ' days') THEN 1 ELSE 0 END) ontime
      FROM work_orders WHERE pm_schedule_id IS NOT NULL AND status <> 'Cancelled' AND due_date >= ? AND due_date < ?`, start, end);
    series.push({ month: start.slice(0, 7), total: r.total, done: r.done || 0, ontime: r.ontime || 0, pct: r.total ? r2(100 * (r.done || 0) / r.total) : null });
  }
  const mttr = one(`SELECT AVG((julianday(completed_at) - julianday(COALESCE(started_at, requested_at))) * 24) h, COUNT(*) n
    FROM work_orders WHERE type = 'Corrective' AND status IN ${DONE} AND completed_at >= ?`, addDays(t, -90) + 'T');
  const byPriority = db.prepare(`SELECT priority, COUNT(*) n FROM work_orders WHERE status NOT IN ${OPEN} GROUP BY priority`).all();
  const byType = db.prepare(`SELECT type, COUNT(*) n FROM work_orders WHERE status NOT IN ${OPEN} GROUP BY type ORDER BY n DESC`).all();
  const kpi = {
    active_assets: one("SELECT COUNT(*) n FROM assets WHERE status NOT IN ('Retired','Disposed')").n,
    down_assets: one("SELECT COUNT(*) n FROM assets WHERE status IN ('Out of Service','Awaiting Parts')").n,
    open_wos: one(`SELECT COUNT(*) n FROM work_orders WHERE status NOT IN ${OPEN}`).n,
    overdue_wos: one(`SELECT COUNT(*) n FROM work_orders WHERE status NOT IN ${OPEN} AND due_date < ?`, t).n,
    unassigned_wos: one(`SELECT COUNT(*) n FROM work_orders WHERE status NOT IN ${OPEN} AND assigned_to IS NULL`).n,
    pm_completion_pct: series[series.length - 1].pct,
    pm_completion_prev_pct: series[series.length - 2].pct,
    overdue_pms: one('SELECT COUNT(*) n FROM pm_schedules WHERE active = 1 AND next_due < ? AND (deferred_until IS NULL OR deferred_until < ?)', t, t).n,
    mttr_hours: r2(mttr.h), mttr_count: mttr.n,
    new_requests: one("SELECT COUNT(*) n FROM service_requests WHERE status IN ('New','Triaged')").n,
    low_stock: one('SELECT COUNT(*) n FROM parts WHERE min_qty IS NOT NULL AND quantity_on_hand <= min_qty').n,
    open_recalls: one("SELECT COUNT(*) n FROM recalls WHERE status IN ('Open','In Progress')").n,
    recall_assets_open: one("SELECT COUNT(*) n FROM recall_assets ra JOIN recalls r ON r.id = ra.recall_id WHERE ra.status = 'Affected' AND r.status IN ('Open','In Progress')").n,
    contracts_expiring: one("SELECT COUNT(*) n FROM contracts WHERE end_date BETWEEN ? AND date(?, '+90 days')", t, t).n,
    cal_due: one("SELECT COUNT(*) n FROM assets WHERE is_test_equipment = 1 AND cal_due_date <= date(?, '+30 days')", t).n,
    certs_expiring: one("SELECT COUNT(*) n FROM certifications WHERE expires_date <= date(?, '+60 days')", t).n,
    awaiting_signoff: one("SELECT COUNT(*) n FROM work_orders WHERE status = 'Completed' AND supervisor_signature IS NULL").n,
    utl_assets: one("SELECT COUNT(*) n FROM assets WHERE utl_since IS NOT NULL AND status NOT IN ('Retired','Disposed')").n,
    inventories_open: one("SELECT COUNT(*) n FROM inventories WHERE status = 'In Progress'").n,
    failed_tests_30d: one("SELECT COUNT(*) n FROM test_runs WHERE result = 'Fail' AND completed_at >= ?", addDays(t, -30)).n,
  };
  // My work = assigned to me, plus unassigned work in my teams' queues.
  const mine = db.prepare(`SELECT id, wo_number, type, priority, status, due_date, asset_id, assigned_to,
      (SELECT asset_tag || ' ' || COALESCE(description,'') FROM assets WHERE id = asset_id) asset,
      (SELECT name FROM teams WHERE id = team_id) team
    FROM work_orders WHERE status NOT IN ${OPEN}
      AND (assigned_to = ? OR (assigned_to IS NULL AND team_id IN (SELECT team_id FROM team_members WHERE user_id = ?)))
    ORDER BY CASE priority WHEN 'Emergency' THEN 0 WHEN 'Urgent' THEN 1 WHEN 'High' THEN 2 WHEN 'Normal' THEN 3 ELSE 4 END, due_date LIMIT 25`).all(user.id, user.id);
  return { kpi, pm_series: series, by_priority: byPriority, by_type: byType, my_work: mine };
}

const REPORTS = {
  unable_to_locate: {
    title: 'Unable To Locate (UTL) Assets', filters: ['facility_id', 'department_id', 'utl_status', 'source', 'from', 'to'],
    run(db, q) {
      const w = []; const p = [];
      if (q.from) { w.push('substr(u.reported_at,1,10) >= ?'); p.push(q.from); }
      if (q.to) { w.push('substr(u.reported_at,1,10) <= ?'); p.push(q.to); }
      if (q.facility_id) { w.push('u.facility_id = ?'); p.push(Number(q.facility_id)); }
      if (q.department_id) { w.push('u.department_id = ?'); p.push(Number(q.department_id)); }
      if (q.utl_status) { w.push('u.status = ?'); p.push(q.utl_status); }
      if (q.source) { w.push('u.source = ?'); p.push(q.source); }
      const rows = db.prepare(`SELECT a.asset_tag, m.manufacturer, m.model, m.category, a.serial_number, d.name department, f.name facility,
          cd.name last_dept, a.current_room last_room, substr(a.last_seen_at,1,10) last_seen,
          u.source, i.inventory_number, w.wo_number, substr(u.reported_at,1,10) reported, u.reported_by, u.status,
          substr(u.resolved_at,1,10) located, u.resolution, u.notes,
          CAST(julianday(COALESCE(u.resolved_at, 'now')) - julianday(u.reported_at) AS INTEGER) days_missing
        FROM utl_events u JOIN assets a ON a.id = u.asset_id LEFT JOIN models m ON m.id = a.model_id
        LEFT JOIN departments d ON d.id = u.department_id LEFT JOIN facilities f ON f.id = u.facility_id
        LEFT JOIN departments cd ON cd.id = a.current_department_id
        LEFT JOIN inventories i ON i.id = u.inventory_id LEFT JOIN work_orders w ON w.id = u.work_order_id
        ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY u.status = 'Open' DESC, u.reported_at DESC`).all(...p);
      return { columns: cols('status:Status,asset_tag:Asset,manufacturer:Manufacturer,model:Model,category:Device Type,serial_number:Serial,facility:Owning Facility,department:Owning Department,last_dept:Last Seen In,last_room:Last Room,last_seen:Last Seen:date,source:Source,inventory_number:Inventory,wo_number:Work Order,reported:Reported:date,reported_by:Reported By,days_missing:Days Missing:int,located:Located:date,resolution:Resolution,notes:Notes'), rows };
    },
  },
  utl_by_department: {
    title: 'Unable To Locate Metrics by Department', filters: ['facility_id', 'from', 'to'],
    run(db, q) {
      const { from, to } = range(q);
      const p = []; let fw = '';
      if (q.facility_id) { fw = 'WHERE d.facility_id = ?'; p.push(Number(q.facility_id)); }
      const rows = db.prepare(`SELECT f.name facility, d.name department, d.cost_center,
          (SELECT COUNT(*) FROM assets a WHERE a.department_id = d.id AND a.status NOT IN ('Retired','Disposed')) assets,
          (SELECT COUNT(*) FROM assets a WHERE a.department_id = d.id AND a.utl_since IS NOT NULL AND a.status NOT IN ('Retired','Disposed')) utl_now,
          (SELECT COUNT(*) FROM utl_events u WHERE u.department_id = d.id AND substr(u.reported_at,1,10) BETWEEN ? AND ?) utl_period,
          (SELECT COUNT(*) FROM utl_events u WHERE u.department_id = d.id AND u.source = 'Inventory' AND substr(u.reported_at,1,10) BETWEEN ? AND ?) utl_inventory,
          (SELECT COUNT(*) FROM utl_events u WHERE u.department_id = d.id AND u.source IN ('PM Work Order','Work Order') AND substr(u.reported_at,1,10) BETWEEN ? AND ?) utl_wo,
          (SELECT COUNT(*) FROM utl_events u WHERE u.department_id = d.id AND u.status = 'Resolved' AND substr(u.resolved_at,1,10) BETWEEN ? AND ?) located_period,
          (SELECT AVG(julianday(u.resolved_at) - julianday(u.reported_at)) FROM utl_events u WHERE u.department_id = d.id AND u.status = 'Resolved' AND substr(u.resolved_at,1,10) BETWEEN ? AND ?) avg_days,
          (SELECT substr(MAX(i.completed_at),1,10) FROM inventories i WHERE i.department_id = d.id AND i.status = 'Completed') last_inventory
        FROM departments d LEFT JOIN facilities f ON f.id = d.facility_id ${fw} ORDER BY f.name, d.name`)
        .all(from, to, from, to, from, to, from, to, from, to, ...p);
      for (const r of rows) { r.utl_rate = r.assets ? r2(100 * r.utl_now / r.assets) : null; r.avg_days = r2(r.avg_days); }
      return { columns: cols('facility:Facility,department:Department,cost_center:Cost Center,assets:Assets Owned:int,utl_now:Currently UTL:int,utl_rate:UTL Rate %:pct,utl_period:UTL Reported (period):int,utl_inventory:From Inventory:int,utl_wo:From Work Orders:int,located_period:Located (period):int,avg_days:Avg Days to Locate:number,last_inventory:Last Inventory:date'), rows: rows.filter(r => r.assets || r.utl_period) };
    },
  },
  inventory_flags: {
    title: 'Inventory Red & Yellow Flags', filters: ['inventory_id', 'facility_id', 'department_id', 'flag', 'from', 'to'],
    run(db, q) {
      const w = ["i.status = 'Completed'"]; const p = [];
      if (q.inventory_id) { w.push('i.id = ?'); p.push(Number(q.inventory_id)); } else {
        const { from, to } = range(q);
        w.push('substr(i.completed_at,1,10) BETWEEN ? AND ?'); p.push(from, to);
      }
      if (q.facility_id) { w.push('i.facility_id = ?'); p.push(Number(q.facility_id)); }
      if (q.department_id) { w.push('i.department_id = ?'); p.push(Number(q.department_id)); }
      const scans = db.prepare(`SELECT i.inventory_number, substr(i.completed_at,1,10) date, d.name department, s.room, a.asset_tag, s.scanned_code,
          m.manufacturer, m.model, a.serial_number, s.flag_level flag, s.flag_text reasons, s.result
        FROM inventory_scans s JOIN inventories i ON i.id = s.inventory_id LEFT JOIN departments d ON d.id = i.department_id
        LEFT JOIN assets a ON a.id = s.asset_id LEFT JOIN models m ON m.id = a.model_id
        WHERE ${w.join(' AND ')} AND s.flag_level IN ('Red','Yellow')`).all(...p);
      const missing = db.prepare(`SELECT i.inventory_number, substr(i.completed_at,1,10) date, d.name department, a.current_room room, a.asset_tag, a.asset_tag scanned_code,
          m.manufacturer, m.model, a.serial_number, 'Red' flag,
          'NOT LOCATED during inventory' || CASE WHEN u.status = 'Resolved' THEN ' (since located ' || substr(u.resolved_at,1,10) || ')' ELSE '' END reasons, 'Unable To Locate' result
        FROM utl_events u JOIN inventories i ON i.id = u.inventory_id LEFT JOIN departments d ON d.id = i.department_id
        JOIN assets a ON a.id = u.asset_id LEFT JOIN models m ON m.id = a.model_id WHERE ${w.join(' AND ')}`).all(...p);
      let rows = [...missing, ...scans];
      if (q.flag) rows = rows.filter(r => r.flag === q.flag);
      rows.sort((x, y) => (x.inventory_number < y.inventory_number ? 1 : x.inventory_number > y.inventory_number ? -1 : 0) || (x.flag === y.flag ? 0 : x.flag === 'Red' ? -1 : 1));
      for (const r of rows) if (!r.asset_tag) r.asset_tag = `${r.scanned_code} (not in inventory)`;
      return { columns: cols('inventory_number:Inventory,date:Date:date,department:Department,room:Room,flag:Flag,asset_tag:Asset,manufacturer:Manufacturer,model:Model,serial_number:Serial,reasons:Reason(s),result:Result'), rows };
    },
  },
  asset_inventory: {
    title: 'Asset Inventory', filters: ['facility_id', 'department_id', 'category', 'manufacturer', 'status'],
    run(db, q) {
      const { w, p } = assetFilter(q);
      if (q.status) { w.push('a.status = ?'); p.push(q.status); }
      const rows = db.prepare(`SELECT a.asset_tag, a.control_number, m.manufacturer, m.model, m.category, a.serial_number, a.status, a.criticality,
          f.name facility, d.name department, a.room, a.install_date, a.purchase_price, a.warranty_expires, a.replacement_date
        FROM assets a LEFT JOIN models m ON m.id = a.model_id LEFT JOIN facilities f ON f.id = a.facility_id LEFT JOIN departments d ON d.id = a.department_id
        ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY a.asset_tag`).all(...p);
      return { columns: cols('asset_tag:Asset Tag,control_number:Control #,manufacturer:Manufacturer,model:Model,category:Category,serial_number:Serial,status:Status,criticality:Criticality,facility:Facility,department:Department,room:Room,install_date:Installed:date,purchase_price:Price:money,warranty_expires:Warranty:date,replacement_date:Replace By:date'), rows };
    },
  },
  pm_compliance: {
    title: 'PM Compliance by Department', filters: ['facility_id', 'from', 'to'],
    run(db, q) {
      const { from, to } = range(q);
      const p = [from, to]; let fw = '';
      if (q.facility_id) { fw = 'AND a.facility_id = ?'; p.push(Number(q.facility_id)); }
      const rows = db.prepare(`SELECT COALESCE(f.name,'(none)') facility, COALESCE(d.name,'(none)') department, COUNT(*) scheduled,
          SUM(CASE WHEN w.status IN ${DONE} THEN 1 ELSE 0 END) completed,
          SUM(CASE WHEN w.status IN ${DONE} AND substr(w.completed_at,1,10) <= date(w.due_date, '+' || COALESCE(s.grace_days,30) || ' days') THEN 1 ELSE 0 END) on_time,
          SUM(CASE WHEN w.status NOT IN ${OPEN} AND w.due_date < date('now') THEN 1 ELSE 0 END) overdue,
          SUM(CASE WHEN a.criticality = 'Life Support' THEN 1 ELSE 0 END) life_support,
          SUM(CASE WHEN a.criticality = 'Life Support' AND w.status IN ${DONE} THEN 1 ELSE 0 END) life_support_done,
          SUM(CASE WHEN w.unable_to_locate = 1 OR EXISTS (SELECT 1 FROM utl_events u WHERE u.work_order_id = w.id) THEN 1 ELSE 0 END) utl
        FROM work_orders w JOIN pm_schedules s ON s.id = w.pm_schedule_id LEFT JOIN assets a ON a.id = w.asset_id
        LEFT JOIN facilities f ON f.id = a.facility_id LEFT JOIN departments d ON d.id = a.department_id
        WHERE w.status <> 'Cancelled' AND w.due_date BETWEEN ? AND ? ${fw}
        GROUP BY f.name, d.name ORDER BY f.name, d.name`).all(...p);
      for (const r of rows) {
        r.completion_pct = r.scheduled ? r2(100 * r.completed / r.scheduled) : null;
        r.on_time_pct = r.scheduled ? r2(100 * r.on_time / r.scheduled) : null;
        r.life_support_pct = r.life_support ? r2(100 * r.life_support_done / r.life_support) : null;
      }
      return { columns: cols('facility:Facility,department:Department,scheduled:Scheduled:int,completed:Completed:int,completion_pct:Completion %:pct,on_time:On Time:int,on_time_pct:On Time %:pct,overdue:Overdue Open:int,utl:Unable To Locate:int,life_support_pct:Life Support %:pct'), rows };
    },
  },
  overdue_pm: {
    title: 'Overdue & Upcoming PM', filters: ['facility_id', 'department_id'],
    run(db, q) {
      const { w, p } = assetFilter(q);
      const rows = db.prepare(`SELECT a.asset_tag, m.manufacturer, m.model, d.name department, a.room, a.criticality, s.program, s.interval_months, s.next_due,
          CAST(julianday('now') - julianday(s.next_due) AS INTEGER) days_overdue, s.deferred_until, u.full_name technician
        FROM pm_schedules s JOIN assets a ON a.id = s.asset_id LEFT JOIN models m ON m.id = a.model_id LEFT JOIN departments d ON d.id = a.department_id
        LEFT JOIN users u ON u.id = s.assigned_to
        WHERE s.active = 1 AND s.next_due <= date('now', '+30 days') ${w.length ? 'AND ' + w.join(' AND ') : ''} ORDER BY s.next_due`).all(...p);
      return { columns: cols('asset_tag:Asset,manufacturer:Manufacturer,model:Model,department:Department,room:Room,criticality:Criticality,program:Program,interval_months:Interval (mo):int,next_due:Due:date,days_overdue:Days Overdue:int,deferred_until:Deferred Until:date,technician:Technician'), rows };
    },
  },
  wo_history: {
    title: 'Work Order History', filters: ['facility_id', 'department_id', 'from', 'to', 'type', 'technician_id'],
    run(db, q) {
      const { from, to } = range(q);
      const { w, p } = assetFilter(q);
      w.push('substr(wo.requested_at,1,10) BETWEEN ? AND ?'); p.push(from, to);
      if (q.type) { w.push('wo.type = ?'); p.push(q.type); }
      if (q.technician_id) { w.push('wo.assigned_to = ?'); p.push(Number(q.technician_id)); }
      const rows = db.prepare(`SELECT wo.wo_number, wo.type, wo.status, wo.priority, a.asset_tag, m.manufacturer, m.model, d.name department,
          u.full_name technician, substr(wo.requested_at,1,10) requested, substr(wo.completed_at,1,10) completed, wo.problem, wo.work_performed,
          wo.failure_code, wo.cause_code, wo.action_code, wo.labor_hours, wo.downtime_hours,
          COALESCE(wo.labor_cost,0) + COALESCE(wo.parts_cost,0) + COALESCE(wo.external_cost,0) total_cost
        FROM work_orders wo LEFT JOIN assets a ON a.id = wo.asset_id LEFT JOIN models m ON m.id = a.model_id
        LEFT JOIN departments d ON d.id = COALESCE(wo.department_id, a.department_id) LEFT JOIN users u ON u.id = wo.assigned_to
        WHERE ${w.join(' AND ')} ORDER BY wo.id DESC`).all(...p);
      return { columns: cols('wo_number:WO #,type:Type,status:Status,priority:Priority,asset_tag:Asset,manufacturer:Manufacturer,model:Model,department:Department,technician:Technician,requested:Requested:date,completed:Completed:date,problem:Problem,work_performed:Work Performed,failure_code:Failure,cause_code:Cause,action_code:Action,labor_hours:Labor Hrs:number,downtime_hours:Downtime Hrs:number,total_cost:Total Cost:money'), rows };
    },
  },
  cost_by_asset: {
    title: 'Maintenance Cost by Asset', filters: ['facility_id', 'department_id', 'category', 'from', 'to'],
    run(db, q) {
      const { from, to } = range(q);
      const { w, p } = assetFilter(q);
      const rows = db.prepare(`SELECT a.asset_tag, m.manufacturer, m.model, d.name department, a.purchase_price,
          COUNT(wo.id) work_orders, SUM(CASE WHEN wo.type = 'Corrective' THEN 1 ELSE 0 END) repairs,
          COALESCE(SUM(wo.labor_cost),0) labor, COALESCE(SUM(wo.parts_cost),0) parts, COALESCE(SUM(wo.external_cost),0) external,
          (SELECT COALESCE(c.annual_cost,0) FROM contracts c WHERE c.id = a.contract_id) contract_annual
        FROM assets a LEFT JOIN models m ON m.id = a.model_id LEFT JOIN departments d ON d.id = a.department_id
        LEFT JOIN work_orders wo ON wo.asset_id = a.id AND wo.status IN ${DONE} AND substr(wo.completed_at,1,10) BETWEEN ? AND ?
        ${w.length ? 'WHERE ' + w.join(' AND ') : ''} GROUP BY a.id HAVING work_orders > 0 OR contract_annual > 0 ORDER BY (labor + parts + external) DESC`).all(from, to, ...p);
      for (const r of rows) {
        r.total = r2(r.labor + r.parts + r.external);
        r.cost_ratio_pct = r.purchase_price ? r2(100 * r.total / r.purchase_price) : null;
      }
      return { columns: cols('asset_tag:Asset,manufacturer:Manufacturer,model:Model,department:Department,purchase_price:Acquisition:money,work_orders:WOs:int,repairs:Repairs:int,labor:Labor:money,parts:Parts:money,external:External:money,total:Total:money,cost_ratio_pct:% of Acquisition:pct,contract_annual:Contract/yr:money'), rows };
    },
  },
  cost_by_department: {
    title: 'Maintenance Cost by Department / Cost Center', filters: ['facility_id', 'from', 'to'],
    run(db, q) {
      const { from, to } = range(q);
      const p = [from, to]; let fw = '';
      if (q.facility_id) { fw = 'AND a.facility_id = ?'; p.push(Number(q.facility_id)); }
      const rows = db.prepare(`SELECT COALESCE(f.name,'(none)') facility, COALESCE(d.name,'(none)') department, d.cost_center,
          COUNT(DISTINCT a.id) assets, COUNT(wo.id) work_orders,
          COALESCE(SUM(wo.labor_hours),0) labor_hours, COALESCE(SUM(wo.labor_cost),0) labor, COALESCE(SUM(wo.parts_cost),0) parts, COALESCE(SUM(wo.external_cost),0) external
        FROM work_orders wo JOIN assets a ON a.id = wo.asset_id LEFT JOIN departments d ON d.id = a.department_id LEFT JOIN facilities f ON f.id = a.facility_id
        WHERE wo.status IN ${DONE} AND substr(wo.completed_at,1,10) BETWEEN ? AND ? ${fw}
        GROUP BY f.name, d.id ORDER BY f.name, d.name`).all(...p);
      for (const r of rows) { r.total = r2(r.labor + r.parts + r.external); r.per_asset = r.assets ? r2(r.total / r.assets) : null; }
      return { columns: cols('facility:Facility,department:Department,cost_center:Cost Center,assets:Assets Serviced:int,work_orders:WOs:int,labor_hours:Labor Hrs:number,labor:Labor:money,parts:Parts:money,external:External:money,total:Total:money,per_asset:Per Asset:money'), rows };
    },
  },
  reliability: {
    title: 'Reliability by Model (MTBF / MTTR)', filters: ['facility_id', 'category', 'from', 'to'],
    run(db, q) {
      const { from, to } = range(q);
      const days = Math.max(1, (Date.parse(to) - Date.parse(from)) / 864e5);
      const p = [from, to]; let fw = '';
      if (q.facility_id) { fw += ' AND a.facility_id = ?'; p.push(Number(q.facility_id)); }
      if (q.category) { fw += ' AND m.category = ?'; p.push(q.category); }
      const rows = db.prepare(`SELECT m.manufacturer, m.model, m.category, COUNT(DISTINCT a.id) assets,
          COUNT(wo.id) failures,
          AVG((julianday(wo.completed_at) - julianday(COALESCE(wo.started_at, wo.requested_at))) * 24) mttr_hours,
          COALESCE(SUM(wo.downtime_hours),0) downtime_hours,
          SUM(CASE WHEN wo.failure_code = 'No Problem Found' THEN 1 ELSE 0 END) npf
        FROM models m JOIN assets a ON a.model_id = m.id AND a.status NOT IN ('Retired','Disposed')
        LEFT JOIN work_orders wo ON wo.asset_id = a.id AND wo.type = 'Corrective' AND wo.status IN ${DONE} AND substr(wo.completed_at,1,10) BETWEEN ? AND ?
        WHERE 1=1 ${fw} GROUP BY m.id ORDER BY failures DESC`).all(...p);
      for (const r of rows) {
        r.mtbf_days = r.failures ? r2((r.assets * days) / r.failures) : null;
        r.failures_per_asset_year = r2(r.failures / r.assets / (days / 365));
        r.availability_pct = r2(100 * (1 - r.downtime_hours / (r.assets * days * 24)));
        r.mttr_hours = r2(r.mttr_hours);
      }
      return { columns: cols('manufacturer:Manufacturer,model:Model,category:Category,assets:Assets:int,failures:Repairs:int,failures_per_asset_year:Repairs/Asset/Yr:number,mtbf_days:MTBF (days):number,mttr_hours:MTTR (hrs):number,downtime_hours:Downtime (hrs):number,availability_pct:Availability %:pct,npf:No Problem Found:int'), rows };
    },
  },
  repeat_repairs: {
    title: 'Repeat Repairs (same asset within 30 days)', filters: ['facility_id', 'from', 'to'],
    run(db, q) {
      const { from, to } = range(q);
      const rows = db.prepare(`SELECT a.asset_tag, m.manufacturer, m.model, w1.wo_number first_wo, substr(w1.completed_at,1,10) first_completed,
          w2.wo_number repeat_wo, substr(w2.requested_at,1,10) repeat_requested, w2.problem
        FROM work_orders w1 JOIN work_orders w2 ON w2.asset_id = w1.asset_id AND w2.id <> w1.id AND w2.type = 'Corrective'
          AND w2.requested_at > w1.completed_at AND julianday(w2.requested_at) - julianday(w1.completed_at) <= 30
        JOIN assets a ON a.id = w1.asset_id LEFT JOIN models m ON m.id = a.model_id
        WHERE w1.type = 'Corrective' AND w1.status IN ${DONE} AND substr(w1.completed_at,1,10) BETWEEN ? AND ? ${q.facility_id ? 'AND a.facility_id = ?' : ''}
        ORDER BY w2.requested_at DESC`).all(from, to, ...(q.facility_id ? [Number(q.facility_id)] : []));
      return { columns: cols('asset_tag:Asset,manufacturer:Manufacturer,model:Model,first_wo:Original WO,first_completed:Completed:date,repeat_wo:Repeat WO,repeat_requested:Repeat Requested:date,problem:Problem'), rows };
    },
  },
  replacement_planning: {
    title: 'Equipment Replacement Priority', filters: ['facility_id', 'department_id', 'category'],
    run(db, q) {
      const { w, p } = assetFilter(q);
      const t = today();
      const rows = db.prepare(`SELECT a.id, a.asset_tag, m.manufacturer, m.model, m.category, d.name department, a.criticality, a.install_date,
          COALESCE(a.expected_life_years, m.expected_life_years) life, a.purchase_price, COALESCE(a.end_of_support, m.end_of_support) eos,
          (SELECT COALESCE(SUM(COALESCE(labor_cost,0)+COALESCE(parts_cost,0)+COALESCE(external_cost,0)),0) FROM work_orders WHERE asset_id = a.id AND status IN ${DONE}) lifetime_cost,
          (SELECT COUNT(*) FROM work_orders WHERE asset_id = a.id AND type = 'Corrective' AND requested_at >= date('now','-365 days')) failures_12m
        FROM assets a LEFT JOIN models m ON m.id = a.model_id LEFT JOIN departments d ON d.id = a.department_id
        WHERE a.status NOT IN ('Retired','Disposed') ${w.length ? 'AND ' + w.join(' AND ') : ''}`).all(...p);
      for (const r of rows) {
        const age = r.install_date ? (Date.parse(t) - Date.parse(r.install_date)) / (365.25 * 864e5) : null;
        r.age_years = age == null ? null : r2(age);
        const ageScore = age != null && r.life ? Math.min(age / r.life, 1.5) / 1.5 * 30 : 0;
        const costScore = r.purchase_price ? Math.min(r.lifetime_cost / r.purchase_price, 1) * 25 : 0;
        const failScore = Math.min(r.failures_12m, 5) / 5 * 15;
        const critScore = { 'Life Support': 15, High: 10, Medium: 5 }[r.criticality] || 0;
        const eosScore = r.eos && r.eos <= t ? 15 : 0;
        r.score = Math.round(ageScore + costScore + failScore + critScore + eosScore);
        r.recommendation = r.score >= 60 ? 'Replace (plan this FY)' : r.score >= 40 ? 'Budget next 1-2 yrs' : 'Maintain';
        r.lifetime_cost = r2(r.lifetime_cost);
      }
      rows.sort((a, b) => b.score - a.score);
      return { columns: cols('score:Score:int,recommendation:Recommendation,asset_tag:Asset,manufacturer:Manufacturer,model:Model,category:Category,department:Department,criticality:Criticality,age_years:Age (yrs):number,life:Exp. Life:number,eos:End of Support:date,failures_12m:Repairs 12mo:int,lifetime_cost:Lifetime Maint. Cost:money,purchase_price:Acquisition:money'), rows };
    },
  },
  technician_productivity: {
    title: 'Technician Productivity', filters: ['from', 'to'],
    run(db, q) {
      const { from, to } = range(q);
      const rows = db.prepare(`SELECT u.full_name technician, u.role,
          (SELECT COUNT(*) FROM work_orders w WHERE w.assigned_to = u.id AND w.status IN ${DONE} AND substr(w.completed_at,1,10) BETWEEN ? AND ?) completed,
          (SELECT COUNT(*) FROM work_orders w WHERE w.assigned_to = u.id AND w.status IN ${DONE} AND w.pm_schedule_id IS NOT NULL AND substr(w.completed_at,1,10) BETWEEN ? AND ?) pms,
          (SELECT COUNT(*) FROM work_orders w WHERE w.assigned_to = u.id AND w.status NOT IN ${OPEN}) open_now,
          (SELECT COALESCE(SUM(hours),0) FROM wo_labor l WHERE l.user_id = u.id AND l.work_date BETWEEN ? AND ?) hours,
          (SELECT COALESCE(SUM(hours),0) FROM wo_labor l WHERE l.user_id = u.id AND l.overtime = 1 AND l.work_date BETWEEN ? AND ?) overtime,
          (SELECT AVG((julianday(completed_at) - julianday(COALESCE(started_at, requested_at))) * 24) FROM work_orders w WHERE w.assigned_to = u.id AND w.type = 'Corrective' AND w.status IN ${DONE} AND substr(w.completed_at,1,10) BETWEEN ? AND ?) mttr
        FROM users u WHERE u.role IN ('technician','supervisor','admin') AND u.active = 1 ORDER BY completed DESC`).all(from, to, from, to, from, to, from, to, from, to);
      for (const r of rows) r.mttr = r2(r.mttr);
      return { columns: cols('technician:Technician,role:Role,completed:WOs Completed:int,pms:PMs Completed:int,open_now:Open Now:int,hours:Labor Hrs:number,overtime:Overtime Hrs:number,mttr:Avg Repair Time (hrs):number'), rows };
    },
  },
  cybersecurity: {
    title: 'Networked Device / Cybersecurity Inventory', filters: ['facility_id', 'department_id'],
    run(db, q) {
      const { w, p } = assetFilter(q);
      const rows = db.prepare(`SELECT a.asset_tag, m.manufacturer, m.model, d.name department, a.hostname, a.ip_address, a.mac_address, a.network_segment,
          a.os_version, a.software_version, a.firmware_version, a.patch_status, a.cyber_risk, COALESCE(a.end_of_support, m.end_of_support) end_of_support, a.sbom_reference
        FROM assets a LEFT JOIN models m ON m.id = a.model_id LEFT JOIN departments d ON d.id = a.department_id
        WHERE ((a.ip_address IS NOT NULL AND a.ip_address <> '') OR (a.mac_address IS NOT NULL AND a.mac_address <> '')) AND a.status NOT IN ('Disposed')
        ${w.length ? 'AND ' + w.join(' AND ') : ''}
        ORDER BY CASE a.cyber_risk WHEN 'Critical' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 WHEN 'Low' THEN 3 ELSE 4 END, a.asset_tag`).all(...p);
      return { columns: cols('asset_tag:Asset,manufacturer:Manufacturer,model:Model,department:Department,hostname:Hostname,ip_address:IP,mac_address:MAC,network_segment:Segment,os_version:OS,software_version:Software,firmware_version:Firmware,patch_status:Patch Status,cyber_risk:Risk,end_of_support:End of Support:date,sbom_reference:SBOM'), rows };
    },
  },
  recall_compliance: {
    title: 'Recall & Alert Compliance', filters: [],
    run(db) {
      const rows = db.prepare(`SELECT r.recall_number, r.title, r.source, r.classification, r.issued_date, r.due_date, r.status,
          COUNT(ra.id) affected, SUM(CASE WHEN ra.status IN ('Action Complete','Not Affected','Removed from Service') THEN 1 ELSE 0 END) resolved
        FROM recalls r LEFT JOIN recall_assets ra ON ra.recall_id = r.id GROUP BY r.id ORDER BY r.issued_date DESC`).all();
      for (const r of rows) r.pct = r.affected ? r2(100 * r.resolved / r.affected) : null;
      return { columns: cols('recall_number:Recall #,title:Title,source:Source,classification:Class,issued_date:Issued:date,due_date:Due:date,status:Status,affected:Affected:int,resolved:Resolved:int,pct:Complete %:pct'), rows };
    },
  },
  test_results: {
    title: 'Test & Calibration Records', filters: ['from', 'to', 'result'],
    run(db, q) {
      const { from, to } = range(q);
      const p = [from, to]; let rw = '';
      if (q.result) { rw = 'AND t.result = ?'; p.push(q.result); }
      const rows = db.prepare(`SELECT t.run_number, substr(t.completed_at,1,10) completed, t.result, a.asset_tag, m.manufacturer, m.model,
          pr.code || ' ' || pr.name procedure, t.procedure_version, u.full_name technician, w.wo_number,
          (SELECT COUNT(*) FROM test_results x WHERE x.run_id = t.id AND x.result = 'Fail') failed_steps, t.test_equipment
        FROM test_runs t LEFT JOIN assets a ON a.id = t.asset_id LEFT JOIN models m ON m.id = a.model_id
        LEFT JOIN procedures pr ON pr.id = t.procedure_id LEFT JOIN users u ON u.id = t.technician_id LEFT JOIN work_orders w ON w.id = t.work_order_id
        WHERE t.status = 'Completed' AND substr(t.completed_at,1,10) BETWEEN ? AND ? ${rw} ORDER BY t.completed_at DESC`).all(...p);
      return { columns: cols('run_number:Record #,completed:Date:date,result:Result,asset_tag:Asset,manufacturer:Manufacturer,model:Model,procedure:Procedure,procedure_version:Ver:int,technician:Technician,wo_number:WO,failed_steps:Failed Steps:int,test_equipment:Test Equipment'), rows };
    },
  },
  contract_utilization: {
    title: 'Contract Utilization & Cost Comparison', filters: [],
    run(db) {
      const rows = db.prepare(`SELECT c.name, c.contract_number, v.name vendor, c.contract_type, c.start_date, c.end_date, c.annual_cost,
          (SELECT COUNT(*) FROM assets a WHERE a.contract_id = c.id) assets,
          (SELECT COUNT(*) FROM work_orders w JOIN assets a ON a.id = w.asset_id WHERE a.contract_id = c.id AND w.completed_at >= date('now','-365 days')) wos_12m,
          (SELECT COALESCE(SUM(COALESCE(w.labor_cost,0)+COALESCE(w.parts_cost,0)),0) FROM work_orders w JOIN assets a ON a.id = w.asset_id WHERE a.contract_id = c.id AND w.completed_at >= date('now','-365 days')) inhouse_cost_12m,
          (SELECT COALESCE(SUM(w.external_cost),0) FROM work_orders w JOIN assets a ON a.id = w.asset_id WHERE a.contract_id = c.id AND w.completed_at >= date('now','-365 days')) vendor_billed_12m
        FROM contracts c LEFT JOIN vendors v ON v.id = c.vendor_id ORDER BY c.end_date`).all();
      return { columns: cols('name:Contract,contract_number:#,vendor:Vendor,contract_type:Type,start_date:Start:date,end_date:End:date,annual_cost:Annual Cost:money,assets:Assets:int,wos_12m:WOs 12mo:int,inhouse_cost_12m:In-house Cost 12mo:money,vendor_billed_12m:Extra Vendor Billing 12mo:money'), rows };
    },
  },
  parts_usage: {
    title: 'Parts Usage & Inventory Valuation', filters: ['from', 'to'],
    run(db, q) {
      const { from, to } = range(q);
      const rows = db.prepare(`SELECT p.part_number, p.name, p.storeroom, p.quantity_on_hand, p.min_qty, p.max_qty, p.unit_cost,
          COALESCE(p.quantity_on_hand,0) * COALESCE(p.unit_cost,0) value,
          (SELECT COALESCE(-SUM(quantity),0) FROM part_transactions t WHERE t.part_id = p.id AND t.txn_type IN ('Issue','Return') AND substr(t.created_at,1,10) BETWEEN ? AND ?) used
        FROM parts p ORDER BY used DESC, p.part_number`).all(from, to);
      for (const r of rows) { r.value = r2(r.value); r.reorder = r.min_qty != null && r.quantity_on_hand <= r.min_qty ? 'REORDER' : ''; }
      return { columns: cols('part_number:Part #,name:Description,storeroom:Storeroom,quantity_on_hand:On Hand:number,min_qty:Min:number,max_qty:Max:number,unit_cost:Unit Cost:money,value:Value:money,used:Used in Period:number,reorder:Reorder'), rows };
    },
  },
  service_requests: {
    title: 'Service Request Response & Satisfaction', filters: ['from', 'to'],
    run(db, q) {
      const { from, to } = range(q);
      const rows = db.prepare(`SELECT COALESCE(d.name,'(none)') department, COUNT(*) requests,
          AVG(CASE WHEN w.started_at IS NOT NULL THEN (julianday(w.started_at) - julianday(r.created_at)) * 24 END) response_hours,
          AVG(r.satisfaction) satisfaction, SUM(CASE WHEN r.satisfaction IS NOT NULL THEN 1 ELSE 0 END) rated
        FROM service_requests r LEFT JOIN departments d ON d.id = r.department_id LEFT JOIN work_orders w ON w.id = r.work_order_id
        WHERE substr(r.created_at,1,10) BETWEEN ? AND ? GROUP BY d.id ORDER BY requests DESC`).all(from, to);
      for (const r of rows) { r.response_hours = r2(r.response_hours); r.satisfaction = r2(r.satisfaction); }
      return { columns: cols('department:Department,requests:Requests:int,response_hours:Avg Response (hrs):number,satisfaction:Avg Satisfaction (1-5):number,rated:Ratings:int'), rows };
    },
  },
};

function cols(spec) {
  return spec.split(',').map(s => { const [key, label, type] = s.split(':'); return { key, label, type: type || 'text' }; });
}

function runReport(db, name, q) {
  const r = REPORTS[name];
  if (!r) return null;
  const out = r.run(db, q || {});
  return { name, title: r.title, filters: r.filters, ...out };
}

function toCsv(columns, rows) {
  const esc = v => {
    if (v == null) return '';
    let s = String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s; // prevent spreadsheet formula injection
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [columns.map(c => esc(c.label)).join(','), ...rows.map(r => columns.map(c => esc(r[c.key])).join(','))].join('\r\n');
}

module.exports = { dashboard, REPORTS, runReport, toCsv };

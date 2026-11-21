// Libre CMMS - Copyright (C) 2026 CreativeMed LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
// Single-page web client. No build step, no external dependencies.
'use strict';

// ======================================================================
// Utilities
// ======================================================================
// Let replaceChildren accept the same child forms as h(): nested arrays, null and false (skipped).
const nativeReplaceChildren = Element.prototype.replaceChildren;
Element.prototype.replaceChildren = function (...kids) {
  return nativeReplaceChildren.apply(this, kids.flat(Infinity).filter(k => k != null && k !== false));
};
const nativeAppend = Element.prototype.append;
Element.prototype.append = function (...kids) {
  return nativeAppend.apply(this, kids.flat(Infinity).filter(k => k != null && k !== false));
};
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}
const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const today = () => new Date().toISOString().slice(0, 10);
const money = v => v == null || v === '' ? '' : Number(v).toLocaleString(undefined, { style: 'currency', currency: 'USD' });
const num = v => v == null || v === '' ? '' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 3 });
const dt = v => v ? new Date(v).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
const qs = o => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== '')).toString();

const S = { meta: null, user: null };

class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
async function api(method, url, body, opts = {}) {
  const init = { method, headers: { 'X-Libre': '1' }, credentials: 'same-origin' };
  if (body !== undefined) {
    if (opts.raw) { init.body = body; init.headers['Content-Type'] = opts.type || 'application/octet-stream'; }
    else { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
  if (res.status === 401 && !opts.noRedirect) { S.user = null; showLogin(); throw new ApiError(401, data.error || 'Please sign in'); }
  if (res.status === 428) { showChangePassword(true); throw new ApiError(428, data.error); }
  if (!res.ok) throw new ApiError(res.status, data.error || `Error ${res.status}`);
  return data;
}

function toast(msg, err = false) {
  const t = h('div', { class: 'toast' + (err ? ' err' : '') }, msg);
  $('#toast-root').append(t);
  setTimeout(() => t.remove(), err ? 6000 : 3000);
}
const fail = e => { if (e.status !== 401 && e.status !== 428) toast(e.message, true); };

function modal(title, body, buttons = [], opts = {}) {
  return new Promise(resolve => {
    const close = v => { bg.remove(); resolve(v); };
    const footer = h('footer', {}, ...buttons.map(b => h('button', {
      class: 'btn ' + (b.cls || ''), onclick: async () => {
        if (!b.action) return close(b.value);
        try { const r = await b.action(); if (r !== false) close(r === undefined ? b.value : r); } catch (e) { fail(e); }
      },
    }, b.label)));
    const m = h('div', { class: 'modal' + (opts.wide ? ' wide' : '') + (opts.cls ? ' ' + opts.cls : '') }, h('header', {}, title), h('div', { class: 'body' }, body), footer);
    const bg = h('div', { class: 'modal-bg', onclick: e => { if (e.target === bg && !opts.sticky) close(null); } }, m);
    $('#modal-root').append(bg);
    const first = $('input, select, textarea', m); if (first) first.focus();
    if (opts.onOpen) opts.onOpen(close);
    m.addEventListener('keydown', e => { if (e.key === 'Escape') close(null); });
  });
}
const confirmBox = (title, text, label = 'Confirm', cls = 'primary') =>
  modal(title, h('p', {}, text), [{ label: 'Cancel', value: false }, { label, cls, value: true }]);

async function promptBox(title, fields) {
  const inputs = {};
  const body = h('div', { class: 'form stack' }, ...fields.map(f => {
    const inp = f.type === 'textarea' ? h('textarea', { required: f.required }) :
      f.type === 'select' ? h('select', {}, ...f.options.map(o => h('option', { value: o.value ?? o }, o.label ?? o))) :
      h('input', { type: f.type || 'text', value: f.value ?? '', autocomplete: f.type === 'password' ? 'current-password' : 'off' });
    if (f.value != null && f.type === 'select') inp.value = f.value;
    inputs[f.name] = inp;
    return h('div', {}, h('label', {}, f.label), inp, f.hint ? h('div', { class: 'hint' }, f.hint) : null);
  }));
  return modal(title, body, [{ label: 'Cancel', value: null }, {
    label: 'OK', cls: 'primary', action: () => {
      const out = {};
      for (const f of fields) {
        out[f.name] = f.type === 'checkbox' ? inputs[f.name].checked : inputs[f.name].value;
        if (f.required && !out[f.name]) { toast(`${f.label} is required`, true); return false; }
      }
      return out;
    },
  }]);
}

const SIGN_TEXT = 'Entering your password applies your electronic signature to this record. It is legally binding and equivalent to your handwritten signature, and is recorded with the date, time and meaning in the audit trail.';
async function signature(title, extraFields = []) {
  return promptBox(title, [...extraFields, { name: 'password', label: `Password for ${S.user.full_name}`, type: 'password', required: true, hint: SIGN_TEXT }]);
}

const STATUS_CLASS = {
  ok: ['Active', 'Resolved', 'Found', 'Added To Inventory', 'Completed', 'Closed', 'Pass', 'Approved', 'Action Complete', 'Received', 'Current', 'Closed - Complete', 'Converted to WO', 'Done', 'Recorded'],
  bad: ['Out of Service', 'Red', 'Unable To Locate', 'Not In Inventory', 'Fail', 'Emergency', 'Urgent', 'Class I', 'Critical', 'Rejected', 'Unsupported', 'Life Support', 'Death', 'Serious', 'Patient Care Impacted', 'Affected'],
  warn: ['Awaiting Parts', 'Yellow', 'Found - Other Department', 'In Progress', 'High', 'Draft', 'On Hold', 'Patch Available', 'Patch Pending', 'Class II', 'Investigating', 'Partially Received', 'Incomplete', 'New'],
  info: ['Open', 'Assigned', 'Triaged', 'Ordered', 'Loaned Out'],
};
function pill(v) {
  if (v == null || v === '') return '';
  const cls = Object.entries(STATUS_CLASS).find(([, list]) => list.includes(v))?.[0] || '';
  return h('span', { class: 'pill ' + cls }, v);
}

// Display a field value (returns Node or string)
function show(f, row) {
  const v = row[f.name];
  if (v == null || v === '') return '';
  switch (f.type) {
    case 'ref': return h('a', { href: `#/${f.ref}/${v}` }, row._labels?.[f.name] || `#${v}`);
    case 'bool': return v ? 'Yes' : 'No';
    case 'money': return money(v);
    case 'number': return num(v);
    case 'datetime': return dt(v);
    case 'date': {
      const overdue = /due|expires|end_date|cal_due|replacement/.test(f.name) && v < today();
      return overdue ? h('span', { class: 'pill bad' }, v) : v;
    }
    case 'select': return ['status', 'priority', 'result', 'urgency', 'classification', 'criticality', 'cyber_risk', 'patch_status', 'severity', 'flag_level'].includes(f.name) ? pill(v) : v;
    case 'textarea': return h('div', { class: 'pre' }, v);
    case 'email': return h('a', { href: `mailto:${v}` }, v);
    default: return /^https?:\/\//.test(v) ? h('a', { href: v, target: '_blank', rel: 'noopener' }, v) : String(v);
  }
}

const ent = name => S.meta.entities[name];
const go = hash => { location.hash = hash; };

// ======================================================================
// Auth screens
// ======================================================================
async function boot() {
  try {
    const st = await api('GET', '/api/setup/status');
    if (st.needsSetup) return showSetup(st);
    const me = await api('GET', '/api/auth/me', undefined, { noRedirect: true }).catch(e => { if (e.status === 401) return null; throw e; });
    if (!me) return showLogin(st.org_name);
    S.user = me.user;
    if (S.user.must_change_password) return showChangePassword(true);
    await startApp();
  } catch (e) {
    if (e.status !== 428) $('#app').innerHTML = `<div class="boot">Cannot reach the Libre server: ${esc(e.message)}</div>`;
  }
}

function authShell(title, ...kids) {
  $('#app').replaceChildren(h('div', { class: 'auth' }, h('div', { class: 'card stack' },
    h('div', { class: 'logo' }, h('img', { src: '/icon.svg', alt: '' }), h('div', {}, h('h1', {}, 'Libre CMMS'), h('div', { class: 'muted small' }, title))),
    ...kids,
    h('div', { class: 'muted small' }, 'Libre - open-source CMMS. Copyright © 2026 CreativeMed LLC.'))));
}

function showLogin(org) {
  const u = h('input', { type: 'text', autocomplete: 'username', autofocus: true });
  const p = h('input', { type: 'password', autocomplete: 'current-password' });
  const err = h('div', { class: 'banner bad', style: 'display:none' });
  const submit = async e => {
    e.preventDefault();
    try {
      const r = await api('POST', '/api/auth/login', { username: u.value, password: p.value }, { noRedirect: true });
      const me = await api('GET', '/api/auth/me');
      S.user = me.user;
      if (r.must_change_password) return showChangePassword(true);
      await startApp();
    } catch (ex) { err.textContent = ex.message; err.style.display = ''; }
  };
  authShell(org || 'Sign in', h('form', { class: 'form stack', onsubmit: submit }, err,
    h('div', {}, h('label', {}, 'Username'), u), h('div', {}, h('label', {}, 'Password'), p),
    h('button', { class: 'btn primary', type: 'submit' }, 'Sign in'),
    h('div', { class: 'small' }, h('a', { href: '/portal' }, 'Request equipment service without an account →'))));
}

function showSetup() {
  const f = { org: h('input', { type: 'text', placeholder: 'e.g. Riverside General Hospital' }), name: h('input', { type: 'text' }),
    user: h('input', { type: 'text', value: 'admin' }), email: h('input', { type: 'email' }), pw: h('input', { type: 'password', autocomplete: 'new-password' }),
    pw2: h('input', { type: 'password', autocomplete: 'new-password' }), sample: h('input', { type: 'checkbox' }) };
  const err = h('div', { class: 'banner bad', style: 'display:none' });
  const submit = async e => {
    e.preventDefault();
    if (f.pw.value !== f.pw2.value) { err.textContent = 'Passwords do not match'; err.style.display = ''; return; }
    try {
      await api('POST', '/api/setup', { org_name: f.org.value, full_name: f.name.value, username: f.user.value, email: f.email.value, password: f.pw.value, sample_data: f.sample.checked });
      await api('POST', '/api/auth/login', { username: f.user.value, password: f.pw.value });
      location.hash = '#/dashboard';
      boot();
    } catch (ex) { err.textContent = ex.message; err.style.display = ''; }
  };
  authShell('First-time setup', h('p', { class: 'muted' }, 'Create the administrator account for this Libre server.'),
    h('form', { class: 'form stack', onsubmit: submit }, err,
      h('div', {}, h('label', {}, 'Organization name'), f.org),
      h('div', {}, h('label', { class: 'req' }, 'Your full name'), f.name),
      h('div', {}, h('label', { class: 'req' }, 'Administrator username'), f.user),
      h('div', {}, h('label', {}, 'Email'), f.email),
      h('div', {}, h('label', { class: 'req' }, 'Password'), f.pw, h('div', { class: 'hint' }, 'At least 10 characters with letters and numbers.')),
      h('div', {}, h('label', { class: 'req' }, 'Confirm password'), f.pw2),
      h('label', { class: 'check', style: 'padding-top:0' }, f.sample, 'Load demonstration data (fictional hospital, equipment and procedures)'),
      h('button', { class: 'btn primary', type: 'submit' }, 'Create administrator')));
}

function showChangePassword(forced) {
  const cur = h('input', { type: 'password', autocomplete: 'current-password' });
  const p1 = h('input', { type: 'password', autocomplete: 'new-password' });
  const p2 = h('input', { type: 'password', autocomplete: 'new-password' });
  const body = h('div', { class: 'form stack' },
    forced ? h('div', { class: 'banner warn' }, 'You must set a new password before continuing.') : null,
    h('div', {}, h('label', {}, 'Current password'), cur), h('div', {}, h('label', {}, 'New password'), p1, h('div', { class: 'hint' }, 'At least 10 characters with letters and numbers.')),
    h('div', {}, h('label', {}, 'Confirm new password'), p2));
  const buttons = [{ label: 'Change password', cls: 'primary', action: async () => {
    if (p1.value !== p2.value) { toast('Passwords do not match', true); return false; }
    await api('POST', '/api/auth/password', { current: cur.value, password: p1.value });
    toast('Password changed');
    if (forced) { S.user.must_change_password = 0; startApp(); }
  } }];
  if (!forced) buttons.unshift({ label: 'Cancel', value: null });
  else buttons.unshift({ label: 'Sign out', action: logout });
  if ($('.modal-bg')) return;
  modal('Change password', body, buttons, { sticky: forced });
}

async function logout() {
  await api('POST', '/api/auth/logout', {}).catch(() => {});
  S.user = null; location.hash = '';
  boot();
}

// ======================================================================
// App shell
// ======================================================================
async function startApp() {
  S.meta = await api('GET', '/api/meta');
  document.title = `${S.meta.org_name} - Libre CMMS`;
  const groups = {};
  for (const e of Object.values(S.meta.entities)) if (e.group) (groups[e.group] = groups[e.group] || []).push(e);
  const order = ['Maintenance', 'Equipment', 'Help Desk', 'Inventory', 'Vendors & Contracts', 'Compliance', 'Knowledge', 'People', 'Organization'];
  const isMgr = ['admin', 'supervisor'].includes(S.user.role);
  const side = h('nav', { class: 'side' },
    h('div', { class: 'brand' }, h('img', { src: '/icon.svg', alt: '' }), h('div', {}, 'Libre', h('small', {}, S.meta.org_name))),
    S.user.role !== 'requester' ? h('a', { href: '#/dashboard' }, 'Dashboard') : null,
    S.user.role !== 'requester' ? h('a', { href: '#/scan' }, 'Scan / Find Asset') : null,
    S.user.role !== 'requester' ? h('a', { href: '#/inventory' }, 'Inventory Mode') : null,
    S.user.role !== 'requester' ? h('a', { href: '#/lookup' }, 'Device Lookup') : null,
    ...order.filter(g => groups[g]).flatMap(g => [h('div', { class: 'grp' }, g), ...groups[g].map(e => h('a', { href: `#/list/${e.name}` }, e.plural))]),
    S.user.role !== 'requester' ? [h('div', { class: 'grp' }, 'Analysis'), h('a', { href: '#/reports' }, 'Reports & KPIs')] : null,
    isMgr ? h('a', { href: '#/audit' }, 'Audit Trail') : null,
    S.user.role === 'admin' ? [h('div', { class: 'grp' }, 'Administration'), h('a', { href: '#/settings' }, 'Settings & Backups')] : null,
    h('div', { class: 'grp' }, 'Help'), h('a', { href: '/portal', target: '_blank' }, 'Service Request Portal'), h('a', { href: '#/about' }, 'About Libre'));
  const searchBox = h('input', { type: 'search', placeholder: 'Search assets, work orders, models, documents…' });
  const results = h('div', { class: 'dropdown', style: 'display:none; left:0; right:auto; width:100%' });
  searchBox.addEventListener('input', debounce(async () => {
    const q = searchBox.value.trim();
    if (q.length < 2) { results.style.display = 'none'; return; }
    const r = await api('GET', '/api/search?' + qs({ q })).catch(() => ({ results: [] }));
    results.replaceChildren(...(r.results.length ? r.results.map(x => h('a', { class: 'item', href: `#/${x.entity}/${x.id}` }, h('span', { class: 'muted small' }, x.label + ': '), x.text))
      : [h('div', { class: 'item muted' }, 'No matches')]));
    results.style.display = '';
  }));
  searchBox.addEventListener('keydown', e => { if (e.key === 'Enter') { const a = $('a', results); if (a) { location.hash = a.getAttribute('href'); results.style.display = 'none'; } } });
  document.addEventListener('click', e => { if (!results.contains(e.target) && e.target !== searchBox) results.style.display = 'none'; });
  results.addEventListener('click', () => { results.style.display = 'none'; searchBox.value = ''; });

  const bell = h('button', { class: 'icon-btn', title: 'Notifications', onclick: e => { e.stopPropagation(); toggleNotifications(bell); } }, '\u{1F514}');
  const userBtn = h('button', { class: 'btn', onclick: async e => {
    e.stopPropagation();
    const r = await modal(S.user.full_name, h('div', { class: 'muted' }, `Signed in as ${S.user.username} (${S.user.role})`),
      [{ label: 'Change password', value: 'pw' }, { label: 'Sign out', cls: 'danger', value: 'out' }]);
    if (r === 'pw') showChangePassword(false);
    if (r === 'out') logout();
  } }, S.user.full_name);
  const menuBtn = h('button', { class: 'icon-btn menu-btn', onclick: () => side.classList.toggle('open') }, '☰');
  const top = h('header', { class: 'top' }, menuBtn, h('div', { class: 'search' }, searchBox, results), h('div', { class: 'spacer' }), bell, userBtn);
  const content = h('main', { class: 'content', id: 'content' });
  $('#app').replaceChildren(h('div', { class: 'shell' }, side, h('div', { class: 'main' }, top, content)));
  side.addEventListener('click', e => { if (e.target.tagName === 'A') side.classList.remove('open'); });
  window.onhashchange = route;
  pollNotifications(bell);
  setInterval(() => pollNotifications(bell), 60000);
  if (!location.hash || location.hash === '#/') location.hash = S.user.role === 'requester' ? '#/list/service_requests' : '#/dashboard';
  route();
}

async function pollNotifications(bell) {
  const r = await api('GET', '/api/notifications').catch(() => null);
  if (!r) return;
  $('.badge-dot', bell)?.remove();
  if (r.unread) bell.append(h('span', { class: 'badge-dot' }, r.unread));
  bell._rows = r.rows;
}
function toggleNotifications(bell) {
  const existing = $('.dropdown.notif');
  if (existing) { existing.remove(); return; }
  const rows = bell._rows || [];
  const dd = h('div', { class: 'dropdown notif' }, rows.length ? rows.map(n => h('a', { class: 'item' + (n.read_at ? '' : ' unread'), href: n.link || '#/dashboard' },
    h('div', {}, n.message), h('div', { class: 'muted small' }, dt(n.created_at)))) : h('div', { class: 'item muted' }, 'No notifications'));
  bell.parentElement.style.position = 'relative';
  bell.after(dd);
  const close = e => { if (!dd.contains(e.target)) { dd.remove(); document.removeEventListener('click', close); } };
  setTimeout(() => document.addEventListener('click', close));
  api('POST', '/api/notifications/read', {}).then(() => pollNotifications(bell)).catch(() => {});
}

// ======================================================================
// Router
// ======================================================================
async function route() {
  const content = $('#content');
  if (!content) return;
  const [path, query] = location.hash.slice(1).split('?');
  const parts = path.split('/').filter(Boolean);
  const params = Object.fromEntries(new URLSearchParams(query || ''));
  $$('.side a').forEach(a => a.classList.toggle('active', a.getAttribute('href') === '#' + path || (parts[0] !== 'list' && a.getAttribute('href') === `#/list/${parts[0]}`)));
  content.replaceChildren(h('div', { class: 'muted' }, 'Loading…'));
  window.scrollTo(0, 0);
  try {
    if (!parts.length || parts[0] === 'dashboard') return await viewDashboard(content);
    if (parts[0] === 'list') return await viewList(content, parts[1], params);
    if (parts[0] === 'reports') return await viewReports(content, parts[1], params);
    if (parts[0] === 'audit') return await viewAudit(content, params);
    if (parts[0] === 'settings') return await viewSettings(content);
    if (parts[0] === 'scan') return viewScan(content);
    if (parts[0] === 'lookup') return viewDeviceLookup(content, params);
    if (parts[0] === 'inventory') return parts[1] ? await viewInventory(content, Number(parts[1])) : await viewInventoryStart(content);
    if (parts[0] === 'run') return await viewRun(content, Number(parts[1]));
    if (parts[0] === 'labels') return await viewLabels(content, params);
    if (parts[0] === 'about') return viewAbout(content);
    if (parts[0] && ent(parts[0])) {
      if (parts[1] === 'new') return viewForm(content, parts[0], null, params);
      if (parts[2] === 'edit') return await viewForm(content, parts[0], Number(parts[1]));
      return await viewDetail(content, parts[0], Number(parts[1]));
    }
    content.replaceChildren(h('div', { class: 'card' }, 'Page not found.'));
  } catch (e) {
    if (e.status !== 401 && e.status !== 428) content.replaceChildren(h('div', { class: 'banner bad' }, e.message));
  }
}

// ======================================================================
// Dashboard
// ======================================================================
async function viewDashboard(el) {
  const d = await api('GET', '/api/dashboard');
  const k = d.kpi;
  const tile = (v, l, href, cls = '') => h('a', { class: `kpi ${cls}`, href }, h('div', { class: 'v' }, v ?? '–'), h('div', { class: 'l' }, l));
  const pct = k.pm_completion_pct;
  const max = 100;
  const bars = h('div', { class: 'bars' }, d.pm_series.map(s => h('div', { class: 'bar', title: `${s.done}/${s.total} completed, ${s.ontime} on time` },
    h('div', { class: 'val' }, s.pct == null ? '–' : `${Math.round(s.pct)}%`), h('div', { class: 'fill', style: `height:${s.pct == null ? 0 : (s.pct / max) * 100}%` }))));
  const months = h('div', { class: 'bars-x' }, d.pm_series.map(s => h('span', {}, new Date(s.month + '-15').toLocaleString(undefined, { month: 'short' }))));
  const mine = d.my_work.length ? h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, ['WO #', 'Type', 'Asset', 'Priority', 'Status', 'Due'].map(x => h('th', {}, x)))),
    h('tbody', {}, d.my_work.map(w => h('tr', { class: 'click', onclick: () => go(`#/work_orders/${w.id}`) },
      h('td', {}, w.wo_number), h('td', {}, w.type), h('td', {}, w.asset || ''), h('td', {}, pill(w.priority)),
      h('td', {}, pill(w.status), w.assigned_to ? '' : h('div', { class: 'small muted' }, `Team queue: ${w.team || ''}`)),
      h('td', {}, w.due_date && w.due_date < today() ? h('span', { class: 'pill bad' }, w.due_date) : w.due_date || '')))))) : h('p', { class: 'muted' }, 'Nothing assigned to you. ');
  el.replaceChildren(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Dashboard'), h('div', { class: 'muted' }, `${S.meta.org_name} · ${new Date().toLocaleDateString(undefined, { dateStyle: 'full' })}`)),
      h('div', { class: 'actions' }, h('a', { class: 'btn primary', href: '#/work_orders/new' }, '+ Work Order'), h('a', { class: 'btn', href: '#/scan' }, 'Scan Asset'), h('a', { class: 'btn', href: '#/inventory' }, 'Inventory Mode'))),
    h('div', { class: 'kpis' },
      tile(k.active_assets.toLocaleString(), 'Active assets', '#/list/assets?view=active'),
      tile(pct == null ? '–' : `${pct}%`, 'PM completion (this month)', '#/reports/pm_compliance', pct == null ? '' : pct >= 95 ? 'ok' : pct >= 85 ? 'warn' : 'bad'),
      tile(k.open_wos, 'Open work orders', '#/list/work_orders?view=open'),
      tile(k.overdue_wos, 'Overdue work orders', '#/list/work_orders?view=overdue', k.overdue_wos ? 'bad' : 'ok'),
      tile(k.overdue_pms, 'Overdue PM schedules', '#/list/pm_schedules?view=overdue', k.overdue_pms ? 'bad' : 'ok'),
      tile(k.mttr_hours == null ? '–' : `${k.mttr_hours} h`, `Mean time to repair (90d, n=${k.mttr_count})`, '#/reports/reliability'),
      tile(k.down_assets, 'Equipment out of service', '#/list/assets?view=down', k.down_assets ? 'warn' : ''),
      tile(k.unassigned_wos, 'Unassigned work', '#/list/work_orders?view=unassigned', k.unassigned_wos ? 'warn' : ''),
      tile(k.new_requests, 'New service requests', '#/list/service_requests?view=new', k.new_requests ? 'warn' : ''),
      tile(k.awaiting_signoff, 'Awaiting supervisor sign-off', '#/list/work_orders?view=awaiting_signoff'),
      tile(k.open_recalls, `Open recalls (${k.recall_assets_open} assets)`, '#/list/recalls?view=open', k.recall_assets_open ? 'bad' : ''),
      tile(k.failed_tests_30d, 'Failed tests (30d)', '#/reports/test_results?result=Fail', k.failed_tests_30d ? 'warn' : ''),
      tile(k.low_stock, 'Parts at reorder point', '#/list/parts?view=low', k.low_stock ? 'warn' : ''),
      tile(k.cal_due, 'Test equipment cal due (30d)', '#/list/assets?view=cal_due', k.cal_due ? 'warn' : ''),
      tile(k.contracts_expiring, 'Contracts expiring (90d)', '#/list/contracts?view=expiring', k.contracts_expiring ? 'warn' : ''),
      tile(k.certs_expiring, 'Certifications expiring (60d)', '#/list/certifications?view=expiring', k.certs_expiring ? 'warn' : ''),
      tile(k.utl_assets, 'Unable To Locate assets', '#/reports/unable_to_locate?utl_status=Open', k.utl_assets ? 'bad' : 'ok'),
      k.inventories_open ? tile(k.inventories_open, 'Inventories in progress', '#/inventory', 'warn') : null),
    h('div', { class: 'grid g2' },
      h('div', { class: 'card' }, h('h2', {}, 'My open work'), mine),
      h('div', { class: 'card' }, h('h2', {}, 'Scheduled PM completion by month'), bars, months,
        h('p', { class: 'muted small' }, 'Percent of PM work orders due in each month that are completed. Hover a bar for on-time counts.'),
        h('h3', {}, 'Open work by priority'),
        h('div', {}, d.by_priority.length ? d.by_priority.map(p => h('span', { style: 'margin-right:.75rem' }, pill(p.priority), ' ', p.n)) : h('span', { class: 'muted' }, 'None')),
        h('h3', {}, 'Open work by type'),
        h('div', {}, d.by_type.length ? d.by_type.map(p => h('span', { style: 'margin-right:.75rem' }, h('span', { class: 'pill' }, p.type), ' ', p.n)) : h('span', { class: 'muted' }, 'None')))));
}

// ======================================================================
// Generic list
// ======================================================================
function listColumns(e) { return e.fields.filter(f => f.name && f.list); }

async function viewList(el, name, params) {
  const e = ent(name);
  if (!e) throw new Error('Unknown list');
  if (name === 'work_orders') return viewWorkOrders(el, params);
  const state = { q: params.q || '', view: params.view || '', sort: '', dir: 'asc', offset: 0, limit: 50 };
  const tableHost = h('div');
  const searchInp = h('input', { type: 'search', placeholder: `Search ${e.plural.toLowerCase()}…`, value: state.q });
  const viewSel = e.views.length ? h('select', {}, h('option', { value: '' }, 'All records'), e.views.map(v => h('option', { value: v.key }, v.label))) : null;
  if (viewSel) viewSel.value = state.view;
  const load = async () => {
    const r = await api('GET', `/api/e/${name}?` + qs({ q: state.q, view: state.view, sort: state.sort, dir: state.dir, offset: state.offset, limit: state.limit }));
    tableHost.replaceChildren(renderTable(e, r.rows, {
      onSort: f => { state.dir = state.sort === f && state.dir === 'asc' ? 'desc' : 'asc'; state.sort = f; load(); }, sort: state.sort, dir: state.dir,
    }), h('div', { class: 'pager' }, h('span', { class: 'muted' }, `${r.total ? state.offset + 1 : 0}–${Math.min(state.offset + state.limit, r.total)} of ${r.total}`),
      h('button', { class: 'btn small', disabled: state.offset === 0, onclick: () => { state.offset = Math.max(0, state.offset - state.limit); load(); } }, '‹ Prev'),
      h('button', { class: 'btn small', disabled: state.offset + state.limit >= r.total, onclick: () => { state.offset += state.limit; load(); } }, 'Next ›')));
  };
  searchInp.addEventListener('input', debounce(() => { state.q = searchInp.value; state.offset = 0; load(); }));
  viewSel?.addEventListener('change', () => { state.view = viewSel.value; state.offset = 0; load(); });
  const isMgr = ['admin', 'supervisor'].includes(S.user.role);
  const extra = [];
  if (name === 'work_orders' && isMgr) extra.push(h('button', { class: 'btn', onclick: async () => {
    const r = await api('POST', '/api/pm/generate', {}).catch(fail); if (r) { toast(`${r.created.length} PM work order(s) generated`); load(); }
  } }, 'Generate due PMs'));
  if (name === 'assets') extra.push(h('a', { class: 'btn', href: `#/labels?view=${state.view}` }, 'Print labels'));
  if (name === 'assets' || name === 'models') extra.push(h('a', { class: 'btn', href: '#/lookup' }, '\u{1F50D} Device Lookup'));
  el.replaceChildren(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, e.plural), e.note ? h('div', { class: 'muted small' }, e.note) : null),
      h('div', { class: 'actions' }, ...extra,
        h('button', { class: 'btn', onclick: () => { location.href = `/api/e/${name}?` + qs({ q: state.q, view: state.view, format: 'csv', export: 1 }); } }, 'Export CSV'),
        isMgr && e.canWrite ? h('button', { class: 'btn', onclick: () => importDialog(name, load) }, 'Import CSV') : null,
        e.canWrite ? h('a', { class: 'btn primary', href: `#/${name}/new` }, `+ New ${e.label}`) : null)),
    h('div', { class: 'toolbar' }, searchInp, viewSel), tableHost);
  await load();
}

function renderTable(e, rows, opts = {}) {
  const cols = opts.columns || listColumns(e);
  if (!rows.length) return h('div', { class: 'card muted' }, 'No records.');
  const sel = opts.selected; // optional Set of selected ids -> checkbox column
  const boxes = [];
  const headBox = sel ? h('input', { type: 'checkbox', title: 'Select all on this page', checked: rows.every(r => sel.has(r.id)),
    onchange: ev => { rows.forEach(r => (ev.target.checked ? sel.add(r.id) : sel.delete(r.id))); boxes.forEach(b => { b.checked = ev.target.checked; }); opts.onSelect?.(); } }) : null;
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, sel ? h('th', { class: 'sel' }, headBox) : null, cols.map(f => h('th', { class: opts.onSort ? 'sortable' : '', onclick: opts.onSort ? () => opts.onSort(f.name) : null },
      f.label, opts.sort === f.name ? (opts.dir === 'asc' ? ' ▲' : ' ▼') : '')), opts.rowActions ? h('th') : null)),
    h('tbody', {}, rows.map(r => {
      let box = null;
      if (sel) {
        box = h('input', { type: 'checkbox', checked: sel.has(r.id), onchange: ev => {
          if (ev.target.checked) sel.add(r.id); else sel.delete(r.id);
          headBox.checked = rows.every(x => sel.has(x.id));
          tr.classList.toggle('selected', ev.target.checked);
          opts.onSelect?.();
        } });
        boxes.push(box);
      }
      const tr = h('tr', { class: 'click' + (sel?.has(r.id) ? ' selected' : ''), onclick: ev => { if (ev.target.closest('a,button,input,td.sel')) return; (opts.onRow || (() => go(`#/${e.name}/${r.id}`)))(r); } },
        sel ? h('td', { class: 'sel' }, box) : null,
        cols.map(f => { const v = show(f, r); return h('td', { class: ['money', 'number', 'int'].includes(f.type) ? 'num' : '' }, f.type === 'textarea' ? String(r[f.name] ?? '').slice(0, 120) : v); }),
        opts.rowActions ? h('td', { class: 'nowrap' }, opts.rowActions(r)) : null);
      return tr;
    }))));
}

// ======================================================================
// Work order list: filters, multi-select and bulk assignment
// ======================================================================
const WO_FILTER_DEFAULT = { status: 'view:open', type: '', priority: '', assigned: '', unassigned: false, team: '', facility: '', department: '', category: '', model: '', due_from: '', due_to: '', q: '', labels: {} };

async function viewWorkOrders(el, params) {
  const e = ent('work_orders');
  const F = { ...WO_FILTER_DEFAULT, ...JSON.parse(sessionStorage.getItem('libre.woFilter') || '{}') };
  F.labels = F.labels || {};
  if (params.view !== undefined) { Object.assign(F, WO_FILTER_DEFAULT, { labels: {} }); F.status = 'view:' + params.view; }
  const state = { sort: '', dir: 'asc', offset: 0, limit: 50, total: 0, rows: [], selected: new Set(), allMatching: false };
  const writer = e.canWrite;
  const isMgr = ['admin', 'supervisor'].includes(S.user.role);

  const query = () => {
    const o = { q: F.q };
    if (F.status.startsWith('view:')) o.view = F.status.slice(5);
    else if (F.status.startsWith('status:')) o.f_status = F.status.slice(7);
    Object.assign(o, { f_type: F.type, f_priority: F.priority, f_assigned_to: F.unassigned ? 'null' : F.assigned, f_team_id: F.team,
      asset_facility: F.facility, asset_department: F.department, asset_category: F.category, asset_model: F.model, from_due_date: F.due_from, to_due_date: F.due_to });
    return o;
  };
  const persist = () => sessionStorage.setItem('libre.woFilter', JSON.stringify(F));
  const changed = () => { persist(); state.offset = 0; state.selected.clear(); state.allMatching = false; load(); };

  // ---- filter controls ----
  const select = (key, options, all = 'Any') => {
    const s = h('select', {}, all !== null ? h('option', { value: '' }, all) : null, options.map(o => (Array.isArray(o) ? h('option', { value: o[0] }, o[1]) : h('option', { value: o }, o))));
    s.value = F[key];
    s.addEventListener('change', () => { F[key] = s.value; changed(); });
    return s;
  };
  const picker = (key, ref, extra = {}) => {
    const p = refPicker({ ref }, F[key] || null, F.labels[key] || '', extra);
    p.addEventListener('change', () => { F[key] = p.value || ''; F.labels[key] = $('input', p).value; changed(); });
    return p;
  };
  const dateInp = key => { const i = h('input', { type: 'date', value: F[key] }); i.addEventListener('change', () => { F[key] = i.value; changed(); }); return i; };
  const woStatus = e.fields.find(f => f.name === 'status').options;
  const statusSel = select('status', [['view:open', 'Current (not completed)'], ['view:overdue', 'Overdue'], ['view:unassigned', 'Unassigned'],
    ['view:mine', 'My open work'], ['view:my_teams', "My teams' queue"], ['view:pm', 'Open PMs'], ['view:awaiting_signoff', 'Awaiting sign-off'],
    ...woStatus.map(s => [`status:${s}`, `Status: ${s}`]), ['view:', 'All work orders']], null);
  const categories = (await api('GET', '/api/distinct/models/category').catch(() => ({ values: [] }))).values;
  const unassigned = h('input', { type: 'checkbox', checked: F.unassigned, onchange: () => { F.unassigned = unassigned.checked; changed(); } });
  const search = h('input', { type: 'search', placeholder: 'WO #, asset tag, problem…', value: F.q });
  search.addEventListener('input', debounce(() => { F.q = search.value; changed(); }));
  const fld = (label, input) => h('div', { class: 'ff' }, h('label', {}, label), input);
  const filters = h('div', { class: 'card filters' },
    fld('Status', statusSel), fld('Search', search),
    fld('Type', select('type', e.fields.find(f => f.name === 'type').options)),
    fld('Priority', select('priority', e.fields.find(f => f.name === 'priority').options)),
    fld('Technician', picker('assigned', 'users', { filter: { view: 'techs' } })),
    fld('Team', picker('team', 'teams')),
    fld('Facility', picker('facility', 'facilities')), fld('Department', picker('department', 'departments')),
    fld('Device Type', select('category', categories)), fld('Model', picker('model', 'models')),
    fld('Due from', dateInp('due_from')), fld('Due to', dateInp('due_to')),
    h('div', { class: 'ff' }, h('label', { class: 'check', style: 'padding-top:1.2rem' }, unassigned, 'No technician assigned')),
    h('div', { class: 'ff', style: 'align-self:end' }, h('button', { class: 'btn small', onclick: () => {
      sessionStorage.removeItem('libre.woFilter');
      if (location.hash === '#/list/work_orders?view=open') route(); else location.hash = '#/list/work_orders?view=open';
    } }, 'Reset filters')));

  // ---- bulk action bar ----
  const bar = h('div', { class: 'bulkbar', style: 'display:none' });
  const count = () => (state.allMatching ? state.total : state.selected.size);
  const target = () => (state.allMatching ? { filter: query() } : { ids: [...state.selected] });
  const renderBar = () => {
    const n = count();
    const pageAll = state.rows.length && state.rows.every(r => state.selected.has(r.id));
    bar.style.display = n ? '' : 'none';
    bar.replaceChildren(
      h('strong', {}, `${n} work order${n === 1 ? '' : 's'} selected`),
      !state.allMatching && pageAll && state.total > state.rows.length
        ? h('a', { href: '#', onclick: ev => { ev.preventDefault(); state.allMatching = true; renderBar(); } }, `Select all ${state.total} matching this filter`) : null,
      state.allMatching ? h('span', { class: 'muted' }, '(every work order matching the current filter)') : null,
      h('span', { class: 'spacer' }),
      writer ? [
        h('button', { class: 'btn small primary', onclick: assignTech }, 'Assign technician'),
        h('button', { class: 'btn small primary', onclick: assignTeam }, 'Assign team'),
        h('button', { class: 'btn small', onclick: () => simple('Set priority', { name: 'priority', label: 'Priority', type: 'select', options: e.fields.find(f => f.name === 'priority').options }) }, 'Priority'),
        h('button', { class: 'btn small', onclick: () => simple('Set due date', { name: 'due_date', label: 'Due date (blank to clear)', type: 'date' }) }, 'Due date'),
        h('button', { class: 'btn small', onclick: () => simple('Set status', { name: 'status', label: 'Status', type: 'select', options: ['Open', 'Assigned', 'In Progress', 'Awaiting Parts', 'On Hold'], hint: 'Completing and closing require individual signatures.' }) }, 'Status'),
        isMgr ? h('button', { class: 'btn small danger', onclick: cancelSel }, 'Cancel WOs') : null,
      ] : null,
      h('button', { class: 'btn small', onclick: () => { state.selected.clear(); state.allMatching = false; load(); } }, 'Clear'));
  };

  async function runBulk(body, what) {
    const n = count();
    const r = await api('POST', '/api/wo/bulk', { ...target(), ...body });
    state.selected.clear(); state.allMatching = false;
    await load();
    if (r.skipped.length) {
      await modal('Bulk update results', h('div', { class: 'stack' }, h('p', {}, `${r.updated} of ${n} work order(s) updated (${what}). ${r.skipped.length} skipped:`),
        h('div', { class: 'pre small', style: 'max-height:260px;overflow:auto' }, r.skipped.map(s => `${s.wo_number || '#' + s.id}: ${s.reason}`).join('\n'))), [{ label: 'OK', cls: 'primary' }]);
    } else toast(`${r.updated} work order(s) updated: ${what}`);
  }

  async function assignTech() {
    const w = await api('GET', '/api/workload');
    let chosen;
    const rows = w.techs.map(t => {
      const radio = h('input', { type: 'radio', name: 'tech', value: t.id, onchange: () => { chosen = t.id; } });
      return h('tr', { class: 'click', onclick: ev => { if (ev.target !== radio) { radio.checked = true; chosen = t.id; } } },
        h('td', {}, radio), h('td', {}, t.full_name, t.available ? '' : h('span', { class: 'pill warn', style: 'margin-left:.4rem' }, 'unavailable')),
        h('td', { class: 'small muted' }, t.teams || ''), h('td', { class: 'num' }, t.open), h('td', { class: 'num' }, t.overdue ? h('span', { class: 'pill bad' }, t.overdue) : 0),
        h('td', { class: 'num' }, t.urgent ? h('span', { class: 'pill warn' }, t.urgent) : 0));
    });
    const unassignRadio = h('input', { type: 'radio', name: 'tech', value: '', onchange: () => { chosen = null; } });
    const body = h('div', { class: 'stack' }, h('p', {}, `Assign ${count()} work order(s) to:`),
      h('div', { class: 'table-wrap', style: 'max-height:340px;overflow:auto' }, h('table', {},
        h('thead', {}, h('tr', {}, ['', 'Technician', 'Teams', 'Open', 'Overdue', 'Urgent'].map(x => h('th', {}, x)))), h('tbody', {}, rows))),
      h('label', { class: 'check', style: 'padding:0' }, unassignRadio, 'Remove the technician (leave unassigned / in team queue)'),
      h('p', { class: 'small muted' }, 'Open, Overdue and Urgent show each person\'s current workload. Assigned technicians receive one summary notification.'));
    const ok = await modal('Assign technician', body, [{ label: 'Cancel' }, { label: 'Assign', cls: 'primary', action: () => {
      if (chosen === undefined) { toast('Choose a technician', true); return false; }
      return true;
    } }], { wide: true });
    if (!ok) return;
    const name = chosen ? w.techs.find(t => t.id === chosen).full_name : 'unassigned';
    await runBulk({ changes: { assigned_to: chosen } }, `technician → ${name}`).catch(fail);
  }

  async function assignTeam() {
    const w = await api('GET', '/api/workload');
    if (!w.teams.length) {
      const go2 = await modal('No teams yet', h('p', {}, 'Create teams under People → Teams and add members first.'), [{ label: 'Cancel' }, { label: 'Create a team', cls: 'primary', value: true }]);
      if (go2) go('#/teams/new');
      return;
    }
    let chosen;
    const clear = h('input', { type: 'checkbox', checked: true });
    const rows = w.teams.map(t => {
      const radio = h('input', { type: 'radio', name: 'team', value: t.id, onchange: () => { chosen = t.id; } });
      return h('tr', { class: 'click', onclick: ev => { if (ev.target !== radio) { radio.checked = true; chosen = t.id; } } },
        h('td', {}, radio), h('td', {}, t.name), h('td', { class: 'small muted' }, t.specialty || ''), h('td', { class: 'num' }, t.members), h('td', { class: 'num' }, t.open), h('td', { class: 'num' }, t.queue));
    });
    const removeRadio = h('input', { type: 'radio', name: 'team', value: '', onchange: () => { chosen = null; } });
    const body = h('div', { class: 'stack' }, h('p', {}, `Assign ${count()} work order(s) to team:`),
      h('div', { class: 'table-wrap', style: 'max-height:300px;overflow:auto' }, h('table', {},
        h('thead', {}, h('tr', {}, ['', 'Team', 'Specialty', 'Members', 'Open', 'Unclaimed'].map(x => h('th', {}, x)))), h('tbody', {}, rows))),
      h('label', { class: 'check', style: 'padding:0' }, removeRadio, 'Remove from any team'),
      h('label', { class: 'check', style: 'padding:0' }, clear, 'Remove the individual technician so any team member can pick it up'),
      h('p', { class: 'small muted' }, 'Team members see these in "My teams\' queue" and on their dashboard, and get one summary notification.'));
    const ok = await modal('Assign team', body, [{ label: 'Cancel' }, { label: 'Assign', cls: 'primary', action: () => {
      if (chosen === undefined) { toast('Choose a team', true); return false; }
      return true;
    } }], { wide: true });
    if (!ok) return;
    const name = chosen ? w.teams.find(t => t.id === chosen).name : 'no team';
    await runBulk({ changes: { team_id: chosen }, clear_technician: chosen ? clear.checked : false }, `team → ${name}`).catch(fail);
  }

  async function simple(title, field) {
    const r = await promptBox(`${title} for ${count()} work order(s)`, [field]);
    if (!r) return;
    await runBulk({ changes: { [field.name]: r[field.name] || null } }, `${field.label.split(' (')[0].toLowerCase()} → ${r[field.name] || 'cleared'}`).catch(fail);
  }
  async function cancelSel() {
    const r = await promptBox(`Cancel ${count()} work order(s)`, [{ name: 'reason', label: 'Reason (recorded on every work order)', type: 'textarea', required: true }]);
    if (!r) return;
    await runBulk({ cancel_reason: r.reason }, 'cancelled').catch(fail);
  }

  // ---- table ----
  const tableHost = h('div');
  const summary = h('span', { class: 'muted small' });
  async function load() {
    const r = await api('GET', '/api/e/work_orders?' + qs({ ...query(), sort: state.sort, dir: state.dir, offset: state.offset, limit: state.limit }));
    state.total = r.total; state.rows = r.rows;
    summary.textContent = `${r.total} matching work order(s)`;
    tableHost.replaceChildren(renderTable(e, r.rows, {
      selected: writer ? state.selected : null, onSelect: () => { state.allMatching = false; renderBar(); },
      onSort: f => { state.dir = state.sort === f && state.dir === 'asc' ? 'desc' : 'asc'; state.sort = f; load(); }, sort: state.sort, dir: state.dir,
    }), h('div', { class: 'pager' }, h('span', { class: 'muted' }, `${r.total ? state.offset + 1 : 0}–${Math.min(state.offset + state.limit, r.total)} of ${r.total}`),
      h('button', { class: 'btn small', disabled: state.offset === 0, onclick: () => { state.offset = Math.max(0, state.offset - state.limit); load(); } }, '‹ Prev'),
      h('button', { class: 'btn small', disabled: state.offset + state.limit >= r.total, onclick: () => { state.offset += state.limit; load(); } }, 'Next ›')));
    renderBar();
  }

  el.replaceChildren(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Work Orders'), summary),
      h('div', { class: 'actions' },
        isMgr ? h('button', { class: 'btn', onclick: async () => { const r = await api('POST', '/api/pm/generate', {}).catch(fail); if (r) { toast(`${r.created.length} PM work order(s) generated`); load(); } } }, 'Generate due PMs') : null,
        h('button', { class: 'btn', onclick: () => { location.href = '/api/e/work_orders?' + qs({ ...query(), format: 'csv', export: 1 }); } }, 'Export CSV'),
        writer ? h('a', { class: 'btn primary', href: '#/work_orders/new' }, '+ New Work Order') : null)),
    filters, bar, tableHost);
  await load();
}

async function importDialog(name, done) {
  const e = ent(name);
  const file = h('input', { type: 'file', accept: '.csv,text/csv' });
  const cols = e.fields.filter(f => f.name && !f.readonly).map(f => f.name);
  const body = h('div', { class: 'stack' },
    h('p', {}, `Upload a CSV file. The first row must contain column names (field names or labels). Rows whose ${e.fields.find(f => f.unique)?.label || 'unique key'} already exists are updated.`),
    h('p', { class: 'small muted' }, 'Columns: ', cols.join(', ')),
    name === 'assets' ? h('p', { class: 'small muted' }, 'For the Model column you may use "Manufacturer|Model" - missing models are created automatically. Rows matching an existing model + serial number are reported as duplicates.') : null,
    h('a', { class: 'small', href: '#', onclick: ev => { ev.preventDefault(); const blob = new Blob([cols.join(',') + '\r\n'], { type: 'text/csv' }); const a = h('a', { href: URL.createObjectURL(blob), download: `${name}-template.csv` }); a.click(); } }, 'Download template'),
    file);
  await modal(`Import ${e.plural}`, body, [{ label: 'Cancel' }, { label: 'Import', cls: 'primary', action: async () => {
    if (!file.files[0]) { toast('Choose a file', true); return false; }
    const r = await api('POST', `/api/import/${name}`, await file.files[0].text(), { raw: true, type: 'text/csv' });
    await modal('Import results', h('div', { class: 'stack' }, h('p', {}, `${r.created} created, ${r.updated} updated, ${r.errors.length} problems.`),
      r.errors.length ? h('div', { class: 'pre small', style: 'max-height:300px;overflow:auto' }, r.errors.join('\n')) : null), [{ label: 'OK', cls: 'primary' }]);
    done && done();
  } }]);
}

// ======================================================================
// Reference picker
// ======================================================================
function refPicker(f, value, label, opts = {}) {
  const wrap = h('div', { class: 'picker' });
  const inp = h('input', { type: 'text', value: label || '', placeholder: 'Type to search…', autocomplete: 'off' });
  const list = h('div', { class: 'opts', style: 'display:none' });
  const clear = h('button', { type: 'button', class: 'clear', title: 'Clear', onclick: () => { wrap.value = null; inp.value = ''; wrap.dispatchEvent(new Event('change')); } }, '×');
  wrap.value = value ?? null;
  let hl = -1; let items = [];
  const search = debounce(async () => {
    const r = await api('GET', `/api/e/${f.ref}?` + qs({ q: inp.value, limit: 20, ...(opts.filter || {}) })).catch(() => ({ rows: [] }));
    items = r.rows; hl = -1;
    list.replaceChildren(...(items.length ? items.map((row, i) => h('div', { onmousedown: ev => { ev.preventDefault(); pick(i); } }, row._label)) : [h('div', { class: 'muted' }, 'No matches')]));
    list.style.display = '';
  }, 200);
  const pick = i => { const row = items[i]; if (!row) return; wrap.value = row.id; inp.value = row._label; list.style.display = 'none'; wrap.dispatchEvent(new Event('change')); };
  inp.addEventListener('input', () => { wrap.value = null; search(); });
  inp.addEventListener('focus', search);
  inp.addEventListener('blur', () => setTimeout(() => { list.style.display = 'none'; if (!wrap.value) inp.value = ''; }, 150));
  inp.addEventListener('keydown', ev => {
    const divs = $$('div', list);
    if (ev.key === 'ArrowDown') { hl = Math.min(hl + 1, divs.length - 1); } else if (ev.key === 'ArrowUp') { hl = Math.max(hl - 1, 0); } else if (ev.key === 'Enter') { ev.preventDefault(); pick(Math.max(hl, 0)); return; } else return;
    divs.forEach((d, i) => d.classList.toggle('hl', i === hl));
  });
  wrap.append(inp, clear, list);
  return wrap;
}

// ======================================================================
// Forms
// ======================================================================
function buildForm(e, row = {}, opts = {}) {
  const inputs = {};
  const hide = new Set(opts.hide || []);
  const nodes = [];
  for (const f of e.fields) {
    if (f.section) { nodes.push(h('div', { class: 'section-title' }, f.section)); continue; }
    if (hide.has(f.name) || f.computed) continue;
    const isNew = !row.id;
    if (f.readonly && (isNew || row[f.name] == null)) continue;
    let v = row[f.name];
    if (isNew && v == null && f.default !== undefined) v = f.default;
    if (isNew && v == null && f.defaultToday) v = today();
    let inp;
    if (f.readonly) inp = h('div', { class: 'v' }, show(f, row));
    else if (f.type === 'ref') inp = refPicker(f, v, row._labels?.[f.name] || (v != null ? `#${v}` : ''), { filter: f.ref === 'assets' && f.name === 'test_equipment' ? { view: 'test_equipment' } : {} });
    else if (f.type === 'bool') inp = h('input', { type: 'checkbox', checked: !!v });
    else if (f.type === 'select') {
      const options = f.options || S.meta.lookups[f.lookup] || [];
      inp = h('select', {}, h('option', { value: '' }, ''), [...options, ...(v && !options.includes(v) ? [v] : [])].map(o => h('option', { value: o }, o)));
      inp.value = v ?? '';
    } else if (f.type === 'textarea') inp = h('textarea', { rows: f.rows || 4 }, v ?? '');
    else if (f.type === 'datetime') inp = h('input', { type: 'datetime-local', value: v ? new Date(new Date(v).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '' });
    else inp = h('input', { type: { date: 'date', int: 'number', number: 'number', money: 'number', email: 'email' }[f.type] || 'text', step: f.type === 'int' ? '1' : 'any', value: v ?? '' });
    if (!f.readonly) inputs[f.name] = { f, inp };
    const wide = f.type === 'textarea';
    nodes.push(f.type === 'bool'
      ? h('div', { class: 'field' }, h('label', { class: 'check' }, inp, f.label))
      : h('div', { class: 'field' + (wide ? ' wide' : '') }, h('label', { class: f.required ? 'req' : '' }, f.label), inp, f.hint ? h('div', { class: 'hint' }, f.hint) : null));
  }
  const form = h('div', { class: 'form' }, h('div', { class: 'fields' }, nodes));
  form.values = () => {
    const out = {};
    for (const [k, { f, inp }] of Object.entries(inputs)) {
      if (f.type === 'ref') out[k] = inp.value;
      else if (f.type === 'bool') out[k] = inp.checked ? 1 : 0;
      else if (f.type === 'datetime') out[k] = inp.value ? new Date(inp.value).toISOString() : null;
      else out[k] = inp.value === '' ? null : inp.value;
    }
    return out;
  };
  form.inputs = inputs;
  return form;
}

async function viewForm(el, name, id, params = {}) {
  const e = ent(name);
  let row = {};
  let similarOf = null;
  if (id) row = (await api('GET', `/api/e/${name}/${id}`)).row;
  else {
    if (name === 'assets' && params.similar) {
      // "Add similar": copy model, device class, lifecycle and purchase details; the
      // tag, serial number and location-specific fields are left for the user.
      similarOf = (await api('GET', `/api/e/assets/${Number(params.similar)}`)).row;
      for (const k of SIMILAR_FIELDS) if (similarOf[k] != null && similarOf[k] !== '') row[k] = similarOf[k];
      row._labels = { ...similarOf._labels };
    }
    for (const [k, v] of Object.entries(params)) {
      const f = e.fields.find(x => x.name === k);
      if (f) { row[k] = f.type === 'ref' ? Number(v) : v; }
    }
    // Pre-load labels for prefilled refs
    for (const f of e.fields.filter(x => x.type === 'ref' && row[x.name])) {
      const r = await api('GET', `/api/e/${f.ref}/${row[f.name]}`).catch(() => null);
      if (r) (row._labels = row._labels || {})[f.name] = r.row._label;
      // New asset from a known model: show the values the model provides.
      if (r && name === 'assets' && f.name === 'model_id' && !similarOf) {
        const m = r.row;
        row.description = row.description || [m.manufacturer, m.model, m.category ? `(${m.category})` : ''].filter(Boolean).join(' ');
        row.criticality = row.criticality || m.criticality || undefined;
        row.expected_life_years = row.expected_life_years ?? m.expected_life_years ?? undefined;
      }
    }
  }
  const form = buildForm(e, row);
  const save = async () => {
    try {
      const data = form.values();
      const r = id ? await api('PUT', `/api/e/${name}/${id}`, data) : await api('POST', `/api/e/${name}`, data);
      toast(`${e.label} saved`);
      if (name === 'assets' && !id) return afterAssetCreated(r.row);
      go(`#/${name}/${r.row.id}`);
    } catch (ex) { fail(ex); }
  };
  const headActions = [h('button', { class: 'btn', onclick: () => history.back() }, 'Cancel'), h('button', { class: 'btn primary', onclick: save }, 'Save')];
  if (name === 'assets' || name === 'models') {
    headActions.unshift(h('button', { class: 'btn', onclick: () => lookupIntoForm(name, form, row) }, '\u{1F50D} Look up device'));
  }
  const top = [];
  if (similarOf) {
    top.push(h('div', { class: 'banner info' }, h('strong', {}, `Adding another ${similarOf._labels?.model_id || similarOf.description || 'asset'} `),
      `(copied from ${similarOf.asset_tag}). Model, manufacturer, device class and lifecycle details are filled in. Enter the asset tag and serial number, and choose the owning account for this unit.`));
  }
  el.replaceChildren(
    h('div', { class: 'page-head' }, h('h1', {}, id ? `Edit ${e.label}: ${row._label}` : similarOf ? 'Add Similar Asset' : `New ${e.label}`),
      h('div', { class: 'actions' }, headActions)),
    ...top,
    h('div', { class: 'card' }, form),
    h('div', { class: 'actions', style: 'display:flex;gap:.5rem;justify-content:flex-end' }, h('button', { class: 'btn', onclick: () => history.back() }, 'Cancel'), h('button', { class: 'btn primary', onclick: save }, 'Save')));
  if (similarOf) {
    // Draw attention to the per-unit fields: identity and owning account.
    for (const k of ['asset_tag', 'serial_number', 'facility_id', 'department_id']) form.inputs[k]?.inp.closest('.field')?.classList.add('attention');
    setTimeout(() => (form.inputs.asset_tag?.inp)?.focus(), 50);
  }
  if (name === 'work_orders' && !id) {
    // Show warranty/contract coverage as soon as an asset is picked.
    const assetInp = form.inputs.asset_id?.inp;
    const banner = h('div');
    form.prepend(banner);
    const check = async () => {
      banner.replaceChildren();
      if (!assetInp.value) return;
      const r = await api('GET', `/api/e/assets/${assetInp.value}`).catch(() => null);
      if (r) banner.replaceChildren(coverageBanner(r.coverage));
    };
    assetInp?.addEventListener('change', check);
    if (assetInp?.value) check();
  }
}

// ======================================================================
// Add similar asset + PM schedule prompt
// ======================================================================
const SIMILAR_FIELDS = ['model_id', 'description', 'criticality', 'risk_score', 'facility_id', 'department_id', 'owner', 'parent_asset_id',
  'purchase_date', 'install_date', 'purchase_price', 'po_reference', 'warranty_expires', 'contract_id', 'expected_life_years', 'replacement_date',
  'end_of_support', 'is_loaner', 'is_test_equipment', 'network_segment', 'os_version', 'software_version', 'firmware_version', 'cyber_risk', 'patch_status', 'sbom_reference'];

const addMonthsLocal = (d, m) => { const x = new Date(d + 'T12:00:00'); x.setMonth(x.getMonth() + Number(m)); return x.toISOString().slice(0, 10); };

async function afterAssetCreated(asset) {
  const model = asset.model_id ? (await api('GET', `/api/e/models/${asset.model_id}`).catch(() => null))?.row : null;
  const interval = model?.pm_interval_months;
  const pmBox = h('input', { type: 'checkbox', checked: !!interval });
  const due = h('input', { type: 'date', value: interval ? addMonthsLocal(asset.install_date || today(), interval) : '', style: 'width:auto' });
  let procSel = null;
  if (interval) {
    const procs = (await api('GET', '/api/e/procedures?' + qs({ view: 'approved', f_model_id: asset.model_id })).catch(() => ({ rows: [] }))).rows;
    if (procs.length) procSel = h('select', { style: 'width:auto' }, h('option', { value: '' }, '(no procedure)'), procs.map(p => h('option', { value: p.id }, p._label)));
    if (procSel && procs.length) procSel.value = procs[0].id;
  }
  const label = model ? `${model.manufacturer} ${model.model}` : asset.description || 'asset';
  const body = h('div', { class: 'stack' },
    h('div', { class: 'banner ok' }, `Asset ${asset.asset_tag} (${label}) saved.`),
    interval ? h('div', { class: 'card', style: 'margin:0' },
      h('label', { class: 'check', style: 'padding:0' }, pmBox, `Create a PM schedule every ${interval} month(s)`),
      h('div', { class: 'toolbar', style: 'margin:.5rem 0 0 1.6rem' }, h('span', { class: 'small muted' }, 'First due'), due, procSel ? [h('span', { class: 'small muted' }, 'Procedure'), procSel] : null),
      h('div', { class: 'small muted', style: 'margin-left:1.6rem' }, `PM interval from the ${label} model record${model.lookup_source ? ` (${model.lookup_source})` : ''}.`))
      : h('div', { class: 'small muted' }, model ? 'Tip: set a PM interval on the equipment model (or use Device Lookup) to be offered a PM schedule automatically.' : null),
    h('p', {}, model ? `Add another ${label}? The model, manufacturer, device class and purchase details carry over; you enter the tag, serial number and owning account.` : 'Add another similar asset?'));
  const choice = await modal('Asset added', body, [{ label: 'Done', value: 'done' }, { label: '+ Add another similar', cls: 'primary', value: 'similar' }], { sticky: true });
  if (interval && pmBox.checked) {
    await api('POST', '/api/e/pm_schedules', { asset_id: asset.id, interval_months: interval, next_due: due.value || today(), procedure_id: procSel?.value || null, active: 1, program: 'Manufacturer Recommended' })
      .then(() => toast('PM schedule created')).catch(fail);
  }
  if (choice === 'similar') {
    if (location.hash.startsWith(`#/assets/new?similar=${asset.id}`)) route(); else go(`#/assets/new?similar=${asset.id}`);
  } else go(`#/assets/${asset.id}`);
}

// ======================================================================
// Device Lookup (FDA GUDID / classification / recalls + Libre reference)
// ======================================================================
const LOOKUP_FIELDS = [
  ['manufacturer', 'Manufacturer'], ['model', 'Model / Model Number'], ['common_name', 'Common Name / Brand'], ['description', 'Description'],
  ['category', 'Device Type'], ['risk_class', 'FDA Device Class', ['Class I', 'Class II', 'Class III', 'Unclassified', 'Not classified', 'HDE']],
  ['criticality', 'Criticality', ['Low', 'Medium', 'High', 'Life Support']], ['pm_interval_months', 'Suggested PM Interval (months)', 'number'],
  ['expected_life_years', 'Expected Service Life (years)', 'number'], ['fda_device_name', 'FDA Device Name'], ['fda_product_code', 'FDA Product Code'],
  ['regulation_number', 'FDA Regulation (21 CFR)'], ['medical_specialty', 'Medical Specialty'], ['gmdn_term', 'GMDN Term'], ['udi_di', 'UDI-DI'],
  ['fda_510k', 'FDA 510(k) Clearance(s)'], ['umdns_code', 'ECRI UMDNS Code / Term'], ['life_sustaining', 'Life-Sustaining / Supporting', 'bool'],
];

// mode: 'page' (save to catalog / add asset), 'asset' (pick a model for an asset form),
// 'model' (fill an equipment-model form), 'refresh' (update an existing model).
function deviceLookupPanel({ initial = {}, mode = 'page', model_id = null, onDone }) {
  const writer = ['admin', 'supervisor', 'technician'].includes(S.user.role);
  const modelInp = h('input', { type: 'text', value: initial.model || '', placeholder: 'e.g. 8015, LIFEPAK 15, Force FX' });
  const mfrInp = h('input', { type: 'text', value: initial.manufacturer || '', placeholder: 'optional, e.g. BD, Stryker' });
  const status = h('div');
  const results = h('div');
  const linksHost = h('div');
  const panel = h('div', { class: 'lookup' });

  const field = (k, label, kind, value, basis) => {
    let inp;
    if (Array.isArray(kind)) { inp = h('select', {}, h('option', { value: '' }, ''), kind.map(o => h('option', {}, o))); inp.value = value ?? ''; }
    else if (kind === 'bool') inp = h('input', { type: 'checkbox', checked: !!value });
    else inp = h('input', { type: kind === 'number' ? 'number' : 'text', value: value ?? '', step: 'any' });
    inp.dataset.k = k;
    return kind === 'bool' ? h('div', { class: 'field' }, h('label', { class: 'check' }, inp, label), basis ? h('div', { class: 'hint' }, basis) : null)
      : h('div', { class: 'field' }, h('label', {}, label), inp, basis ? h('div', { class: 'hint' }, `Source: ${basis}`) : null);
  };
  const readFields = host => Object.fromEntries($$('[data-k]', host).map(i => [i.dataset.k, i.type === 'checkbox' ? (i.checked ? 1 : 0) : i.value]));

  function renderLinks(list) {
    linksHost.replaceChildren(h('h3', {}, 'More references'), h('div', { class: 'small muted' }, 'ECRI and AAMI resources require a membership or purchase; OEM manuals are on the manufacturer\'s site.'),
      h('ul', { class: 'linklist' }, (list || []).map(l => h('li', {}, h('a', { href: l.url, target: '_blank', rel: 'noopener' }, l.name, ' ↗')))));
  }

  async function review(c) {
    const host = h('div', { class: 'form' });
    const b = c.basis || {};
    host.append(
      c.warning ? h('div', { class: 'banner warn' }, c.warning) : null,
      c.note ? h('div', { class: 'banner info' }, c.note) : null,
      !c.equipment && c.fda_product_code ? h('div', { class: 'banner info' }, c.implant ? 'FDA lists this as an implant - no equipment maintenance suggested.' : 'This looks like an accessory or consumable rather than maintainable equipment - no PM interval suggested.') : null,
      h('div', { class: 'fields' }, LOOKUP_FIELDS.map(([k, label, kind]) => field(k, label, kind, c[k], b[k]))),
      c.typical_tests ? h('div', { class: 'small', style: 'margin-top:.6rem' }, h('strong', {}, 'Typical PM tests: '), c.typical_tests) : null,
      h('div', { class: 'small muted', style: 'margin-top:.4rem' }, 'Suggested PM interval and service life are typical starting points. Confirm with the OEM service manual and your AEM / risk-based maintenance program.'));
    const recallsHost = h('div');
    const saveModel = async (extra = {}) => api('POST', '/api/device-lookup/apply', { ...readFields(host), lookup_source: c.fda_product_code ? 'FDA GUDID / Product Classification via openFDA' : 'Libre Device Lookup', ...extra });
    const btns = [];
    if (mode === 'page' && writer) {
      btns.push(h('button', { class: 'btn', onclick: async () => {
        const r = await saveModel().catch(fail); if (r) { toast(r.created ? 'Equipment model created' : 'Existing equipment model updated'); go(`#/models/${r.row.id}`); }
      } }, 'Save to equipment models'));
      btns.push(h('button', { class: 'btn primary', onclick: async () => {
        const r = await saveModel().catch(fail); if (r) go(`#/assets/new?model_id=${r.row.id}`);
      } }, 'Save & add asset'));
    }
    if (mode === 'asset') btns.push(h('button', { class: 'btn primary', onclick: async () => { const r = await saveModel().catch(fail); if (r) onDone({ model: r.row }); } }, 'Use for this asset'));
    if (mode === 'model') btns.push(h('button', { class: 'btn primary', onclick: () => onDone({ fields: readFields(host) }) }, 'Fill in the form'));
    if (mode === 'refresh') {
      const over = h('input', { type: 'checkbox' });
      btns.push(h('label', { class: 'check', style: 'padding:0' }, over, 'Overwrite values already on the model'),
        h('button', { class: 'btn primary', onclick: async () => { const r = await saveModel({ model_id, overwrite: over.checked }).catch(fail); if (r) onDone({ model: r.row }); } }, 'Update model'));
    }
    btns.push(h('button', { class: 'btn', onclick: async () => {
      recallsHost.replaceChildren(h('div', { class: 'muted' }, 'Checking FDA recalls…'));
      const f = readFields(host);
      const r = await api('GET', '/api/device-lookup/recalls?' + qs({ model: f.model || c.model, manufacturer: f.manufacturer })).catch(fail);
      if (!r) return;
      if (!r.rows.length) return recallsHost.replaceChildren(h('div', { class: 'banner ok' }, r.message || 'No FDA recalls found that mention this model.'));
      recallsHost.replaceChildren(h('h3', {}, `FDA recalls mentioning ${f.model || c.model}`), h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Recall #', 'Class', 'Initiated', 'Status', 'Reason', ''].map(x => h('th', {}, x)))),
        h('tbody', {}, r.rows.map(x => h('tr', {}, h('td', { class: 'nowrap' }, x.recall_number), h('td', {}, pill(x.classification)), h('td', { class: 'nowrap' }, x.initiated), h('td', {}, x.status),
          h('td', { class: 'small' }, String(x.reason || '').slice(0, 220)),
          h('td', {}, x.already_imported ? h('span', { class: 'pill ok' }, 'In Libre') : writer ? h('button', { class: 'btn small', onclick: async ev => {
            const m = model_id ? { model_id } : {};
            const ir = await api('POST', '/api/device-lookup/recall', { ...x, ...m, model: f.model || c.model }).catch(fail);
            if (ir) { ev.target.replaceWith(h('a', { class: 'pill ok', href: `#/recalls/${ir.row.id}`, target: '_blank' }, 'Imported')); toast(`Recall ${x.recall_number} imported - use "Find Affected Assets" on it`); }
          } }, 'Import') : null)))))));
    } }, 'Check FDA recalls'));
    results.replaceChildren(h('div', { class: 'card' }, h('div', { class: 'toolbar' }, h('button', { class: 'btn small', onclick: () => search(false) }, '← Back to results'),
      h('strong', {}, `${c.manufacturer || ''} ${c.model || ''}`)), host, h('div', { class: 'toolbar', style: 'margin-top:1rem' }, btns), recallsHost));
    renderLinks(c.links);
  }

  let last = null;
  async function search(refresh) {
    if (!modelInp.value.trim()) return toast('Enter a model or model number', true);
    if (refresh !== false || !last) {
      status.replaceChildren(h('div', { class: 'muted' }, 'Searching your catalog and the FDA device database…'));
      results.replaceChildren();
      try { last = await api('GET', '/api/device-lookup?' + qs({ model: modelInp.value, manufacturer: mfrInp.value, refresh: refresh ? 1 : '' })); } catch (e) { status.replaceChildren(); return fail(e); }
    }
    const r = last;
    status.replaceChildren(r.message ? h('div', { class: `banner ${r.online ? 'info' : 'warn'}` }, r.message) : null,
      r.hidden ? h('div', { class: 'small muted' }, `${r.hidden} result(s) from other manufacturers hidden. Clear the manufacturer to see everything.`) : null,
      r.online ? h('div', { class: 'small muted' }, `Sources: ${r.sources.map(s => `${s.name} (${s.records})`).join(', ')}. Data from openFDA is unvalidated - review before saving.`) : null);
    const local = r.local.length ? h('div', { class: 'card' }, h('h3', {}, 'Already in your equipment catalog'),
      r.local.map(m => h('div', { class: 'lookup-cand' }, h('div', { class: 'main' }, h('strong', {}, `${m.manufacturer} ${m.model}`), m.category ? ` · ${m.category}` : '', m.risk_class ? [' ', pill(m.risk_class)] : null,
        h('div', { class: 'small muted' }, [m.common_name, m.pm_interval_months ? `PM every ${m.pm_interval_months} mo` : null, `${m.asset_count} asset(s)`].filter(Boolean).join(' · '))),
        mode === 'asset' ? h('button', { class: 'btn small primary', onclick: () => onDone({ model: m }) }, 'Use') :
          mode === 'page' ? [h('a', { class: 'btn small', href: `#/models/${m.id}` }, 'Open'), writer ? h('a', { class: 'btn small primary', href: `#/assets/new?model_id=${m.id}` }, 'Add asset') : null] : null))) : null;
    const cands = r.candidates.length ? h('div', { class: 'card' }, h('h3', {}, 'FDA device database matches'),
      r.candidates.map(c => h('div', { class: 'lookup-cand' + (c.equipment ? '' : ' dim') },
        h('div', { class: 'main' },
          h('div', {}, h('strong', {}, `${c.manufacturer} — ${c.model}`), ' ', c.risk_class ? pill(c.risk_class) : null, c.life_sustaining ? [' ', h('span', { class: 'pill bad' }, 'Life-sustaining')] : null,
            !c.equipment ? [' ', h('span', { class: 'pill' }, c.implant ? 'Implant' : 'Accessory / consumable?')] : null, c.warning ? [' ', h('span', { class: 'pill warn' }, 'Verify type')] : null,
            c.source === '510k' ? [' ', h('span', { class: 'pill info', title: 'Found in FDA 510(k) clearances; no UDI records' }, 'Older model · 510(k)')] : null),
          h('div', {}, [c.common_name, c.category].filter(Boolean).join(' · ')),
          h('div', { class: 'small muted' }, [c.gmdn_term ? `GMDN: ${c.gmdn_term}` : null, c.fda_product_code ? `FDA ${c.fda_product_code} ${c.fda_device_name || ''}` : null, c.regulation_number ? `21 CFR ${c.regulation_number}` : null,
            c.source === 'udi' && c.variants > 1 ? `${c.variants} UDI records` : null, c.source === '510k' ? `${c.variants} clearance(s) ${String(c.first_cleared || '').slice(0, 4)}–${String(c.last_cleared || '').slice(0, 4)}` : null].filter(Boolean).join(' · ')),
          c.pm_interval_months ? h('div', { class: 'small' }, `Suggested: PM every ${c.pm_interval_months} months · ${c.expected_life_years}-year life · ${c.criticality} criticality`) : null),
        h('button', { class: 'btn small primary', onclick: () => review(c) }, 'Select')))) : null;
    const manual = h('div', { class: 'card' }, h('h3', {}, 'Not listed?'), h('p', { class: 'small muted' }, 'Enter the details yourself, then save them to your equipment catalog.'),
      h('button', { class: 'btn', onclick: () => review({ manufacturer: mfrInp.value, model: modelInp.value, equipment: true, basis: {}, links: r.links }) }, 'Enter manually'));
    results.replaceChildren(local, cands, manual);
    renderLinks(r.links);
  }

  panel.append(h('div', { class: 'card form' }, h('div', { class: 'lookup-search' },
    h('div', {}, h('label', {}, 'Model or model number'), modelInp), h('div', {}, h('label', {}, 'Manufacturer'), mfrInp),
    h('button', { class: 'btn primary', onclick: () => search() }, 'Look up'),
    h('button', { class: 'btn small', title: 'Ignore cached results and ask the FDA database again', onclick: () => search(true) }, 'Refresh')), status),
  h('div', { class: 'lookup-cols' }, results, h('div', { class: 'card' }, linksHost)));
  [modelInp, mfrInp].forEach(i => i.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); search(); } }));
  renderLinks([]);
  if (initial.model) setTimeout(() => search(), 0);
  setTimeout(() => modelInp.focus(), 50);
  return panel;
}

function viewDeviceLookup(el, params) {
  el.replaceChildren(h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Device Lookup'),
    h('div', { class: 'muted' }, 'Type a model or model number (and optionally the manufacturer). Libre checks your catalog and the FDA device database (GUDID, product classification, recalls) and suggests device type, FDA class, criticality, PM interval and service life.'))),
  deviceLookupPanel({ initial: { model: params.model || '', manufacturer: params.manufacturer || '' }, mode: 'page' }));
}

// Dialog used from the asset form, model form and model page.
function deviceLookupDialog(initial, mode = 'refresh') {
  let closeFn;
  const done = v => closeFn && closeFn(v);
  const panel = deviceLookupPanel({ initial, mode, model_id: initial.model_id || null, onDone: done });
  return modal('Device Lookup', panel, [{ label: 'Close', value: null }], { wide: true, onOpen: c => { closeFn = c; } });
}

async function lookupIntoForm(name, form, row) {
  const val = k => form.inputs[k]?.inp;
  if (name === 'assets') {
    const pickerText = val('model_id') ? $('input', val('model_id')).value : '';
    const [mf, ...rest] = pickerText.split(' - ');
    const r = await deviceLookupDialog({ model: rest.join(' - ') || pickerText || '', manufacturer: rest.length ? mf : '' }, 'asset');
    if (!r?.model) return;
    const m = r.model;
    const picker = val('model_id');
    picker.value = m.id; $('input', picker).value = m._label || `${m.manufacturer} - ${m.model}`;
    const setIfEmpty = (k, v) => { const i = val(k); if (i && !i.value && v != null && v !== '') i.value = v; };
    setIfEmpty('description', [m.manufacturer, m.model, m.category ? `(${m.category})` : ''].filter(Boolean).join(' '));
    setIfEmpty('criticality', m.criticality);
    setIfEmpty('expected_life_years', m.expected_life_years);
    toast(`Model set to ${m.manufacturer} ${m.model}`);
  } else {
    const r = await deviceLookupDialog({ model: val('model')?.value || row.model || '', manufacturer: val('manufacturer')?.value || row.manufacturer || '' }, 'model');
    if (!r?.fields) return;
    for (const [k, v] of Object.entries(r.fields)) {
      const i = val(k); if (!i || v === '' || v == null) continue;
      if (i.type === 'checkbox') i.checked = !!Number(v); else i.value = v;
    }
    toast('Form filled from lookup - review and Save');
  }
}

function coverageBanner(c) {
  if (!c) return '';
  if (!c.covered) return h('div', { class: 'banner info' }, 'No active warranty or service contract - in-house / billable service.');
  const bits = [];
  if (c.warranty) bits.push(`Under manufacturer warranty until ${c.warranty_expires}.`);
  if (c.contract) bits.push(`Covered by ${c.contract.type || 'service'} contract "${c.contract.name}" with ${c.contract.vendor || 'vendor'}${c.contract.vendor_phone ? ' (' + c.contract.vendor_phone + ')' : ''} until ${c.contract.end_date || 'n/a'}` +
    ` - labor: ${c.contract.covers_labor ? 'yes' : 'no'}, parts: ${c.contract.covers_parts ? 'yes' : 'no'}, PM: ${c.contract.covers_pm ? 'yes' : 'no'}${c.contract.response_hours ? `, response ${c.contract.response_hours}h` : ''}.`);
  return h('div', { class: 'banner warn' }, h('strong', {}, 'Coverage check: '), bits.join(' '), ' Contact the vendor before authorizing billable work.');
}

// ======================================================================
// Detail view
// ======================================================================
async function viewDetail(el, name, id) {
  const e = ent(name);
  const res = await api('GET', `/api/e/${name}/${id}`);
  const row = res.row;
  const reload = () => route();
  const actions = [];
  const isMgr = ['admin', 'supervisor'].includes(S.user.role);
  const extraTop = [];
  if (res.coverage && (name === 'work_orders' || name === 'assets')) extraTop.push(coverageBanner(res.coverage));

  // ---- entity-specific actions ----
  if (name === 'work_orders') woActions(row, actions, extraTop, reload);
  if (name === 'assets') {
    if (row.status === 'Out of Service') extraTop.push(h('div', { class: 'banner bad' }, 'This equipment is OUT OF SERVICE.'));
    if (row.utl_since) extraTop.push(h('div', { class: 'banner bad' }, `UNABLE TO LOCATE since ${row.utl_since}. Scanning it in an inventory or completing work on it marks it located.`));
    const fl = await api('GET', `/api/assets/${id}/flags`).catch(() => ({ flags: [] }));
    const shown = fl.flags.filter(f => f.level !== 'info' && f.code !== 'utl');
    if (shown.length) extraTop.push(h('div', { class: 'flagchips' }, shown.map(f => h(f.link ? 'a' : 'span', { class: `flagchip ${f.level}`, href: f.link || null }, f.text))));
    if (e.canWrite) {
      actions.push(row.utl_since
        ? h('button', { class: 'btn', onclick: async () => {
          const r = await promptBox('Mark asset located', [{ name: 'notes', label: 'Where was it found?' }]); if (!r) return;
          await api('POST', `/api/assets/${id}/located`, r).then(() => { toast('Marked located'); reload(); }).catch(fail);
        } }, 'Mark Located')
        : h('button', { class: 'btn', onclick: async () => {
          const r = await promptBox('Mark Unable To Locate', [{ name: 'notes', label: 'Where did you search?', type: 'textarea', required: true }]); if (!r) return;
          await api('POST', `/api/assets/${id}/utl`, r).then(() => { toast('Marked Unable To Locate'); reload(); }).catch(fail);
        } }, 'Unable To Locate'));
    }
    if (row.is_test_equipment && (!row.cal_due_date || row.cal_due_date < today())) extraTop.push(h('div', { class: 'banner bad' }, 'Test equipment calibration is overdue - do not use for testing.'));
    actions.push(h('a', { class: 'btn primary', href: `#/work_orders/new?asset_id=${row.id}` }, '+ Work Order'),
      h('a', { class: 'btn', href: `#/pm_schedules/new?asset_id=${row.id}` }, '+ PM Schedule'),
      h('a', { class: 'btn', href: `#/labels?ids=${row.id}` }, 'Print Label'));
    if (e.canWrite) actions.push(h('a', { class: 'btn', href: `#/assets/new?similar=${row.id}` }, '+ Add Similar'));
  }
  if (name === 'procedures') {
    if (row.status === 'Draft' && isMgr) actions.push(h('button', { class: 'btn primary', onclick: () => procAct(id, 'approve', 'Approve this procedure? It will be locked, and any previously approved version will be retired.') }, 'Approve'));
    if (row.status !== 'Draft' && e.canWrite) actions.push(h('button', { class: 'btn', onclick: () => procAct(id, 'revise', 'Create a new draft revision of this procedure?') }, 'New Revision'));
    if (row.status === 'Approved' && isMgr) actions.push(h('button', { class: 'btn danger', onclick: () => procAct(id, 'retire', 'Retire this procedure? It can no longer be used for new tests.') }, 'Retire'));
    if (row.status !== 'Draft') extraTop.push(h('div', { class: 'banner info' }, `Version ${row.version} is ${row.status.toLowerCase()} and locked${row.approved_by ? ` (approved by ${row.approved_by}, ${dt(row.approved_at)})` : ''}. Use New Revision to make changes.`));
  }
  if (name === 'recalls' && e.canWrite) {
    actions.push(h('button', { class: 'btn primary', onclick: async () => {
      const r = await api('POST', `/api/recalls/${id}/match`, {}).catch(fail);
      if (r) { toast(`Scanned ${r.scanned} assets across ${r.models} model(s); ${r.added} newly flagged as affected.`); reload(); }
    } }, 'Find Affected Assets'), h('button', { class: 'btn', onclick: async () => {
      if (!await confirmBox('Generate work orders', 'Create a Recall / FCA work order for every affected asset that does not have one yet?')) return;
      const r = await api('POST', `/api/recalls/${id}/workorders`, {}).catch(fail);
      if (r) { toast(`${r.created.length} work order(s) created`); reload(); }
    } }, 'Generate Work Orders'));
  }
  if (name === 'service_requests' && !row.work_order_id && e.canWrite) {
    actions.push(h('button', { class: 'btn primary', onclick: async () => {
      const r = await api('POST', `/api/requests/${id}/convert`, {}).catch(fail);
      if (r) { toast(`Work order ${r.row.wo_number} created`); go(`#/work_orders/${r.row.id}`); }
    } }, 'Convert to Work Order'));
  }
  if (name === 'parts' && e.canWrite) {
    actions.push(h('button', { class: 'btn primary', onclick: async () => {
      const r = await promptBox('Stock transaction', [
        { name: 'type', label: 'Type', type: 'select', options: ['Receive', 'Adjust', 'Return', 'Count'], hint: 'Count sets the on-hand quantity to the number entered.' },
        { name: 'quantity', label: 'Quantity (negative to remove for Adjust)', type: 'number', required: true },
        { name: 'unit_cost', label: 'Unit cost (Receive only, optional)', type: 'number' }, { name: 'note', label: 'Note' }]);
      if (!r) return;
      if (r.unit_cost === '') delete r.unit_cost;
      await api('POST', `/api/parts/${id}/stock`, r).then(() => { toast('Stock updated'); reload(); }).catch(fail);
    } }, 'Receive / Adjust Stock'));
  }
  if (name === 'purchase_orders' && e.canWrite && row.status !== 'Received') {
    actions.push(h('button', { class: 'btn primary', onclick: async () => {
      if (!await confirmBox('Receive PO', 'Receive all remaining quantities on this PO into stock?')) return;
      await api('POST', `/api/po/${id}/receive`, {}).then(() => { toast('Received into stock'); reload(); }).catch(fail);
    } }, 'Receive All'));
  }
  if (name === 'pm_schedules' && isMgr) {
    actions.push(h('button', { class: 'btn', onclick: async () => {
      const r = await promptBox('Approve PM deferral / exception', [{ name: 'until', label: 'Defer until', type: 'date', required: true }, { name: 'reason', label: 'Reason / risk justification', type: 'textarea', required: true }]);
      if (!r) return;
      await api('POST', `/api/pm/${id}/defer`, r).then(() => { toast('Deferral approved'); reload(); }).catch(fail);
    } }, 'Approve Deferral'));
  }
  if (name === 'models' && e.canWrite) {
    actions.push(h('button', { class: 'btn', onclick: async () => {
      const saved = await deviceLookupDialog({ model: row.model, manufacturer: row.manufacturer, model_id: row.id });
      if (saved) { toast('Model updated from lookup'); reload(); }
    } }, '\u{1F50D} Look Up / Refresh'));
  }
  if (name === 'models' && isMgr) {
    actions.push(h('button', { class: 'btn', onclick: async () => {
      const procs = await api('GET', `/api/e/procedures?` + qs({ view: 'approved', f_model_id: id }));
      const r = await promptBox('Create PM schedules for all assets of this model', [
        { name: 'procedure_id', label: 'Procedure', type: 'select', options: [{ value: '', label: '(none)' }, ...procs.rows.map(p => ({ value: p.id, label: p._label }))] },
        { name: 'interval_months', label: 'Interval (months)', type: 'number', value: row.pm_interval_months ?? '' },
        { name: 'next_due', label: 'First due date', type: 'date', value: today() },
        { name: 'program', label: 'Program', type: 'select', options: ['Manufacturer Recommended', 'AEM (Alternative Equipment Maintenance)', 'Risk-Based', 'Regulatory', 'Supplemental'] }]);
      if (!r) return;
      const out = await api('POST', '/api/pm/bulk', { ...r, model_id: id }).catch(fail);
      if (out) toast(`${out.created.length} PM schedule(s) created`);
    } }, 'Bulk PM Schedules'));
  }
  if (name === 'users' && S.user.role === 'admin') {
    actions.push(h('button', { class: 'btn', onclick: async () => {
      const r = await promptBox(`Set password for ${row.full_name}`, [{ name: 'password', label: 'New password', type: 'password', required: true, hint: 'The user will be asked to change it at next sign-in.' }]);
      if (!r) return;
      await api('POST', `/api/users/${id}/password`, r).then(() => toast('Password set')).catch(fail);
    } }, 'Set Password'));
  }
  if (name === 'test_runs') actions.push(h('a', { class: 'btn primary', href: `#/run/${id}` }, row.status === 'In Progress' ? 'Continue Test' : 'View Results'));

  if (e.canWrite && !(name === 'work_orders' && row.status === 'Closed') && !(name === 'procedures' && row.status !== 'Draft')) actions.push(h('a', { class: 'btn', href: `#/${name}/${id}/edit` }, 'Edit'));
  actions.push(h('button', { class: 'btn', onclick: () => window.print() }, 'Print'));
  if (e.canDelete) actions.push(h('button', { class: 'btn danger', onclick: async () => {
    if (!await confirmBox(`Delete ${e.label}`, `Delete ${row._label}? This is recorded in the audit trail and cannot be undone.`, 'Delete', 'danger')) return;
    await api('DELETE', `/api/e/${name}/${id}`).then(() => { toast('Deleted'); go(`#/list/${name}`); }).catch(fail);
  } }, 'Delete'));

  // ---- fields ----
  const nodes = [];
  let pendingSection = null;
  for (const f of e.fields) {
    if (f.section) { pendingSection = f.section; continue; }
    const v = row[f.name];
    if (v == null || v === '') continue;
    if (pendingSection) { nodes.push(h('div', { class: 'section-title' }, pendingSection)); pendingSection = null; }
    nodes.push(h('div', { class: 'field' + (f.type === 'textarea' ? ' wide' : '') }, h('div', { class: 'k' }, f.label), h('div', { class: 'v' }, show(f, row))));
  }
  nodes.push(h('div', { class: 'field wide muted small' }, `Created ${dt(row.created_at)} by ${row.created_by || '?'} · Updated ${dt(row.updated_at)} by ${row.updated_by || '?'}`));

  // ---- tabs: children, attachments, history ----
  const tabs = [];
  for (const c of e.children) {
    const ce = ent(c.entity); if (!ce) continue;
    tabs.push({ title: c.title || ce.plural, render: host => childList(host, c, ce, row, reload) });
  }
  if (name === 'work_orders') tabs.unshift({ title: 'Testing', render: host => woTesting(host, row, reload) });
  if (name === 'assets') tabs.push({ title: 'Network', render: host => { host.replaceChildren(h('p', { class: 'muted' }, 'Network and cybersecurity fields are shown in the details above. See the Cybersecurity report for the full networked-device inventory.'), h('a', { class: 'btn', href: '#/reports/cybersecurity' }, 'Open report')); } });
  tabs.push({ title: 'Attachments', render: host => attachments(host, name, id, e.canWrite || name === 'service_requests') });
  tabs.push({ title: 'History', render: host => history(host, name, id) });
  const tabHost = h('div');
  const tabBar = h('div', { class: 'tabs' });
  const select = i => { $$('button', tabBar).forEach((b, j) => b.classList.toggle('active', i === j)); tabHost.replaceChildren(h('div', { class: 'muted' }, 'Loading…')); tabs[i].render(tabHost); };
  tabs.forEach((t, i) => tabBar.append(h('button', { onclick: () => select(i) }, t.title)));

  el.replaceChildren(
    h('div', { class: 'page-head' }, h('div', {}, h('div', { class: 'muted small' }, h('a', { href: `#/list/${name}` }, e.plural)),
      h('h1', {}, row._label, ' ', row.status ? pill(row.status) : '')), h('div', { class: 'actions' }, actions)),
    ...extraTop, h('div', { class: 'card' }, h('div', { class: 'fields' }, nodes)), tabBar, tabHost);
  select(0);

  async function procAct(pid, action, text) {
    if (!await confirmBox('Procedure', text)) return;
    const r = await api('POST', `/api/procedures/${pid}/${action}`, {}).catch(fail);
    if (r) { toast('Done'); go(`#/procedures/${r.row.id}`); if (r.row.id === pid) reload(); }
  }
}

async function childList(host, c, ce, parent, reload) {
  const filter = { [`f_${c.fk}`]: parent.id, limit: 500 };
  if (c.orderBy) { filter.sort = c.orderBy; filter.dir = 'asc'; }
  const r = await api('GET', `/api/e/${c.entity}?` + qs(filter));
  const inline = ['wo_labor', 'wo_parts', 'procedure_steps', 'po_lines', 'recall_assets', 'certifications'].includes(c.entity);
  const cols = listColumns(ce).filter(f => f.name !== c.fk);
  const add = ce.canWrite ? h('button', { class: 'btn small primary', onclick: () => inline ? childModal(ce, { [c.fk]: parent.id }, c.fk, reload) : go(`#/${c.entity}/new?${c.fk}=${parent.id}`) }, `+ Add ${ce.label}`) : null;
  const rowActions = inline && (ce.canWrite || ce.canDelete) ? row => [
    ce.canWrite ? h('button', { class: 'btn small', onclick: () => childModal(ce, row, c.fk, reload) }, 'Edit') : null, ' ',
    ce.canDelete ? h('button', { class: 'btn small danger', onclick: async () => {
      if (!await confirmBox('Remove', `Remove this ${ce.label.toLowerCase()}?`, 'Remove', 'danger')) return;
      await api('DELETE', `/api/e/${c.entity}/${row.id}`).then(reload).catch(fail);
    } }, '×') : null] : null;
  host.replaceChildren(h('div', { class: 'toolbar' }, add, h('span', { class: 'muted small' }, `${r.total} record(s)`)),
    renderTable(ce, r.rows, { columns: cols, rowActions, onRow: inline ? (row => ce.canWrite && childModal(ce, row, c.fk, reload)) : null }));
}

async function childModal(ce, row, fk, reload) {
  if (row.id) row = (await api('GET', `/api/e/${ce.name}/${row.id}`)).row;
  if (!row.id && ce.name === 'procedure_steps') {
    const r = await api('GET', `/api/e/procedure_steps?` + qs({ f_procedure_id: row.procedure_id, sort: 'seq', dir: 'desc', limit: 1 }));
    row.seq = (r.rows[0]?.seq || 0) + 1;
  }
  const form = buildForm(ce, row, { hide: [fk] });
  await modal(`${row.id ? 'Edit' : 'Add'} ${ce.label}`, form, [{ label: 'Cancel' }, { label: 'Save', cls: 'primary', action: async () => {
    const data = { ...form.values(), [fk]: row[fk] };
    if (row.id) await api('PUT', `/api/e/${ce.name}/${row.id}`, data); else await api('POST', `/api/e/${ce.name}`, data);
    toast('Saved');
  } }], { wide: true });
  reload();
}

async function attachments(host, name, id, canWrite) {
  const r = await api('GET', `/api/files?` + qs({ entity: name, id }));
  const file = h('input', { type: 'file', multiple: true, accept: 'image/*,application/pdf,video/*,.doc,.docx,.xls,.xlsx,.csv,.txt,.zip' });
  const upload = async () => {
    for (const f of file.files) {
      await api('POST', `/api/files?` + qs({ entity: name, id, name: f.name }), f, { raw: true, type: f.type || 'application/octet-stream' }).catch(fail);
    }
    toast('Uploaded'); attachments(host, name, id, canWrite);
  };
  file.addEventListener('change', upload);
  host.replaceChildren(
    canWrite ? h('div', { class: 'toolbar' }, h('label', { class: 'btn small primary' }, '+ Upload photo / file', h('span', { style: 'display:none' }, file)), h('span', { class: 'muted small' }, 'Photos, PDFs, certificates, service reports. On phones this opens the camera.')) : null,
    r.rows.length ? h('div', { class: 'table-wrap' }, h('table', {}, h('tbody', {}, r.rows.map(a => h('tr', {},
      h('td', {}, a.mime.startsWith('image/') ? h('a', { href: `/api/files/${a.id}`, target: '_blank' }, h('img', { src: `/api/files/${a.id}`, alt: a.filename, style: 'max-height:60px;max-width:90px;border-radius:4px' })) : ''),
      h('td', {}, h('a', { href: `/api/files/${a.id}`, target: '_blank' }, a.filename)), h('td', { class: 'muted' }, `${Math.ceil(a.size / 1024)} KB`),
      h('td', { class: 'muted' }, `${a.uploaded_by} · ${dt(a.created_at)}`),
      h('td', {}, canWrite ? h('button', { class: 'btn small danger', onclick: async () => {
        if (!await confirmBox('Remove attachment', `Remove ${a.filename}?`, 'Remove', 'danger')) return;
        await api('DELETE', `/api/files/${a.id}`).then(() => attachments(host, name, id, canWrite)).catch(fail);
      } }, '×') : null)))))) : h('p', { class: 'muted' }, 'No attachments.'));
}

async function history(host, name, id) {
  const r = await api('GET', `/api/audit?` + qs({ entity: name, entity_id: id }));
  host.replaceChildren(r.rows.length ? auditTable(r.rows) : h('p', { class: 'muted' }, 'No history.'));
}

function auditTable(rows) {
  const fmtChanges = c => {
    if (!c) return '';
    try {
      const o = JSON.parse(c);
      return Object.entries(o).map(([k, v]) => Array.isArray(v) && v.length === 2 ? `${k}: ${v[0] ?? '∅'} → ${v[1] ?? '∅'}` : `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n');
    } catch { return c; }
  };
  return h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['When', 'User', 'Action', 'Record', 'Details'].map(x => h('th', {}, x)))),
    h('tbody', {}, rows.map(a => h('tr', {}, h('td', { class: 'nowrap' }, dt(a.ts)), h('td', {}, a.user_name), h('td', {}, h('span', { class: 'pill' + (a.action === 'e-signature' ? ' ok' : a.action === 'delete' ? ' bad' : '') }, a.action)),
      h('td', {}, a.entity && a.entity_id ? h('a', { href: `#/${a.entity}/${a.entity_id}` }, `${a.entity} #${a.entity_id}`) : a.entity || ''),
      h('td', {}, h('div', {}, a.summary || ''), h('div', { class: 'pre small muted' }, fmtChanges(a.changes))))))));
}

// ======================================================================
// Work order workflow
// ======================================================================
function woActions(row, actions, extraTop, reload) {
  const id = row.id;
  const isMgr = ['admin', 'supervisor'].includes(S.user.role);
  const writer = ['admin', 'supervisor', 'technician'].includes(S.user.role);
  const act = async (action, body = {}) => {
    const r = await api('POST', `/api/wo/${id}/${action}`, body).catch(fail);
    if (r) { toast(`${r.row.wo_number}: ${r.row.status}`); if (r.row.id !== id) go(`#/work_orders/${r.row.id}`); else reload(); }
  };
  if (!writer) return;
  const open = !['Completed', 'Closed', 'Cancelled'].includes(row.status);
  if (open && row.status !== 'In Progress') actions.push(h('button', { class: 'btn primary', onclick: () => act('start') }, 'Start Work'));
  if (open) actions.push(h('button', { class: 'btn primary', onclick: async () => {
    const r = await signature('Complete work order & sign', [
      { name: 'work_performed', label: 'Work performed', type: 'textarea', value: row.work_performed || '', required: true },
      { name: 'return_to_service', label: 'Return to service verified? (yes/no)', type: 'select', options: ['yes', 'no'] }]);
    if (r) act('complete', { ...r, return_to_service: r.return_to_service === 'yes' });
  } }, 'Complete & Sign'));
  if (row.status === 'Completed' && isMgr) actions.push(h('button', { class: 'btn primary', onclick: async () => {
    const r = await signature('Supervisor review & sign-off'); if (r) act('supervisor_sign', r);
  } }, 'Supervisor Sign-off'));
  if (['Completed', 'Closed', 'Cancelled'].includes(row.status) && isMgr) actions.push(h('button', { class: 'btn', onclick: async () => {
    const r = await promptBox('Reopen work order', [{ name: 'reason', label: 'Reason', type: 'textarea', required: true }]); if (r) act('reopen', r);
  } }, 'Reopen'));
  if (open) actions.push(h('button', { class: 'btn', onclick: async () => {
    const r = await promptBox('Cancel work order', [{ name: 'reason', label: 'Reason', type: 'textarea', required: true }]); if (r) act('cancel', r);
  } }, 'Cancel WO'));
  actions.push(h('button', { class: 'btn', onclick: async () => {
    const r = await promptBox('Create follow-up corrective work order', [{ name: 'problem', label: 'Problem', type: 'textarea', required: true }, { name: 'priority', label: 'Priority', type: 'select', options: ['Low', 'Normal', 'High', 'Urgent', 'Emergency'], value: 'High' }]);
    if (r) act('followup', r);
  } }, 'Follow-up WO'));
  if (row.unable_to_locate) {
    extraTop.push(h('div', { class: 'banner bad' }, `UNABLE TO LOCATE - reported ${dt(row.utl_reported_at)}. This work order is on hold until the asset is found (an inventory scan releases it automatically).`));
    actions.push(h('button', { class: 'btn primary', onclick: async () => {
      const r = await promptBox('Asset located', [{ name: 'notes', label: 'Where was it found?' }]); if (r) act('located', r);
    } }, 'Asset Located'));
  } else if (open && row.asset_id) {
    actions.push(h('button', { class: 'btn danger', onclick: async () => {
      const r = await promptBox('Unable To Locate', [{ name: 'notes', label: 'Where did you search? (recorded for the department and Clinical Engineering metrics)', type: 'textarea', required: true }]);
      if (r) act('utl', r);
    } }, 'Unable To Locate'));
  }
  if (row.tech_signature) extraTop.push(h('div', { class: 'banner ok' }, `✔ Technician: ${row.tech_signature} · ${dt(row.tech_signed_at)}`, row.supervisor_signature ? h('div', {}, `✔ Supervisor: ${row.supervisor_signature} · ${dt(row.supervisor_signed_at)}`) : ''));
  if (row.due_date && row.due_date < today() && open) extraTop.push(h('div', { class: 'banner bad' }, `Overdue - was due ${row.due_date}.`));
}

async function woTesting(host, wo, reload) {
  const runs = await api('GET', `/api/e/test_runs?` + qs({ f_work_order_id: wo.id }));
  const canStart = ['admin', 'supervisor', 'technician'].includes(S.user.role) && !['Closed', 'Cancelled'].includes(wo.status);
  const start = async () => {
    let model = null;
    if (wo.asset_id) model = (await api('GET', `/api/e/assets/${wo.asset_id}`)).row.model_id;
    let procs = (await api('GET', '/api/e/procedures?' + qs({ view: 'approved', limit: 200 }))).rows;
    procs.sort((a, b) => (b.model_id === model) - (a.model_id === model));
    const te = (await api('GET', '/api/e/assets?' + qs({ view: 'test_equipment', limit: 200 }))).rows;
    if (!procs.length) return toast('No approved procedures exist yet. Create and approve one under Maintenance > Procedures.', true);
    const procSel = h('select', {}, procs.map(p => h('option', { value: p.id }, `${p._label}${p.model_id === model ? '  (matches model)' : ''}`)));
    const checks = te.map(t => {
      const bad = !t.cal_due_date || t.cal_due_date < today();
      const cb = h('input', { type: 'checkbox', value: t.id });
      return { cb, bad, node: h('label', { class: 'check', style: 'padding-top:.3rem' }, cb, `${t._label} — cal due ${t.cal_due_date || 'unknown'}`, bad ? h('span', { class: 'pill bad' }, 'OVERDUE') : '') };
    });
    const override = h('input', { type: 'checkbox' });
    const body = h('div', { class: 'form stack' }, h('div', {}, h('label', {}, 'Procedure (approved versions only)'), procSel),
      h('div', {}, h('label', {}, 'Test equipment used'), checks.length ? checks.map(c => c.node) : h('div', { class: 'muted' }, 'No test equipment registered (mark assets as test equipment).')),
      ['admin', 'supervisor'].includes(S.user.role) ? h('label', { class: 'check' }, override, 'Supervisor override: allow test equipment with overdue calibration') : null);
    const r = await modal('Start test record', body, [{ label: 'Cancel' }, { label: 'Start', cls: 'primary', action: async () => api('POST', '/api/runs', {
      work_order_id: wo.id, procedure_id: Number(procSel.value), test_equipment_ids: checks.filter(c => c.cb.checked).map(c => Number(c.cb.value)), override_cal: override.checked,
    }) }]);
    if (r) go(`#/run/${r.run.id}`);
  };
  host.replaceChildren(h('div', { class: 'toolbar' }, canStart ? h('button', { class: 'btn small primary', onclick: start }, '+ Start Test / Checklist') : null,
    h('span', { class: 'muted small' }, 'Guided procedures with automatic pass/fail against approved limits.')),
  renderTable(ent('test_runs'), runs.rows, { onRow: r => go(`#/run/${r.id}`) }));
}

// ======================================================================
// Test runner (guided procedure)
// ======================================================================
async function viewRun(el, id) {
  let data = await api('GET', `/api/runs/${id}`);
  const pending = {};
  let saving = Promise.resolve();
  const save = debounce(() => {
    saving = saving.then(async () => {
      const entries = Object.values(pending); for (const k in pending) delete pending[k];
      if (!entries.length) return;
      try { data = await api('PUT', `/api/runs/${id}/results`, { results: entries }); render(); } catch (e) { fail(e); }
    });
  }, 500);
  const render = () => {
    // Re-rendering replaces inputs, so remember focus and caret and overlay unsaved typing.
    const active = document.activeElement?.dataset?.k;
    const caret = active ? document.activeElement.selectionStart : null;
    const { run } = data;
    const results = data.results.map(r => (pending[r.id] ? { ...r, ...pending[r.id] } : r));
    const editable = run.status === 'In Progress';
    const failed = new Set(results.filter(r => r.result === 'Fail').map(r => r.seq));
    const set = (r, patch) => { pending[r.id] = { id: r.id, value: r.value, note: r.note, as_found: r.as_found, ...pending[r.id], ...patch }; save(); };
    const steps = results.map(r => {
      const hidden = r.only_if_step != null && !failed.has(r.only_if_step);
      if (hidden) return null;
      const lim = r.step_type === 'Measurement' ? [r.lower_limit != null ? `≥ ${r.lower_limit}` : '', r.upper_limit != null ? `≤ ${r.upper_limit}` : ''].filter(Boolean).join('  ') + (r.unit ? ` ${r.unit}` : '') : '';
      let input;
      if (!editable) input = h('div', {}, r.value ?? '', r.unit && r.value ? ` ${r.unit}` : '', r.as_found ? h('div', { class: 'small muted' }, `As found: ${r.as_found}`) : '');
      else if (r.step_type === 'Pass/Fail') input = h('div', { class: 'seg' }, [['Pass', 'p'], ['Fail', 'f'], ['N/A', 'n']].map(([v, c]) => h('button', { class: `${c} ${r.value === v ? 'on' : ''}`, onclick: () => { set(r, { value: v, result: v }); render(); } }, v)));
      else if (r.step_type === 'Instruction') input = h('label', { class: 'check', style: 'padding:0' }, h('input', { type: 'checkbox', checked: !!r.value, onchange: ev => set(r, { value: ev.target.checked ? 'Done' : '' }) }), 'Done');
      else if (r.step_type === 'Measurement') {
        const asFound = h('input', { type: 'text', inputmode: 'decimal', 'data-k': `${r.id}:as_found`, placeholder: 'As found (optional)', value: r.as_found ?? '', oninput: ev => set(r, { as_found: ev.target.value }) });
        input = h('div', { class: 'stack' }, h('input', { type: 'text', inputmode: 'decimal', 'data-k': `${r.id}:value`, placeholder: r.unit ? `Value (${r.unit})` : 'Value', value: r.value ?? '', oninput: ev => set(r, { value: ev.target.value }) }), asFound);
      } else input = h('textarea', { rows: 2, 'data-k': `${r.id}:value`, oninput: ev => set(r, { value: ev.target.value }) }, r.value ?? '');
      return h('div', { class: `step ${r.result === 'Fail' ? 'fail' : r.result === 'Pass' ? 'pass' : ''} ${r.only_if_step != null ? 'cond' : ''}` },
        h('div', { class: 'n' }, r.seq),
        h('div', {}, h('div', {}, r.prompt, r.required ? '' : h('span', { class: 'muted small' }, ' (optional)')),
          r.only_if_step != null ? h('div', { class: 'small', style: 'color:var(--warn)' }, `Shown because step ${r.only_if_step} failed`) : null,
          lim ? h('div', { class: 'lim' }, `Limits: ${lim}${r.nominal != null ? ` · nominal ${r.nominal}` : ''}`) : null,
          r.media_url ? h('a', { class: 'small', href: r.media_url, target: '_blank', rel: 'noopener' }, 'Reference / image') : null,
          r.error_pct != null ? h('div', { class: 'lim' }, `Error: ${r.error_pct}%`) : null,
          editable ? h('input', { type: 'text', 'data-k': `${r.id}:note`, placeholder: 'Note', value: r.note ?? '', style: 'margin-top:.35rem', oninput: ev => set(r, { note: ev.target.value }) }) : (r.note ? h('div', { class: 'small muted' }, r.note) : null)),
        input, h('div', {}, pill(r.result)));
    }).filter(Boolean);
    const done = results.filter(r => r.result).length;
    el.replaceChildren(
      h('div', { class: 'page-head' }, h('div', {}, h('div', { class: 'muted small' }, h('a', { href: `#/work_orders/${run.work_order_id}` }, run._labels.work_order_id || 'Work order')),
        h('h1', {}, `Test Record ${run.run_number} `, pill(run.status === 'Completed' ? run.result : run.status)),
        h('div', { class: 'muted' }, `${run._labels.procedure_id || ''} · Asset ${run._labels.asset_id || ''} · ${run._labels.technician_id || ''}`)),
      h('div', { class: 'actions' },
        editable ? h('button', { class: 'btn primary', onclick: async () => {
          await new Promise(r => setTimeout(r, 600)); await saving;
          const s = await signature('Complete & sign test record');
          if (!s) return;
          const r = await api('POST', `/api/runs/${id}/complete`, s).catch(fail);
          if (!r) return;
          data = r; render();
          if (r.followup) toast(`Test FAILED - corrective work order ${r.followup.wo_number} created and asset marked out of service.`, true);
          else toast('Test record completed: PASS');
        } }, 'Complete & Sign') : null,
        editable ? h('button', { class: 'btn danger', onclick: async () => {
          if (!await confirmBox('Discard test record', 'Discard this in-progress test record and all entered values?', 'Discard', 'danger')) return;
          await api('DELETE', `/api/runs/${id}`).then(() => go(`#/work_orders/${run.work_order_id}`)).catch(fail);
        } }, 'Discard') : null,
        h('button', { class: 'btn', onclick: () => window.print() }, 'Print / PDF'))),
      h('div', { class: 'print-only' }, h('h2', {}, S.meta.org_name)),
      h('div', { class: 'card' }, h('div', { class: 'fields' },
        [['Work order', run._labels.work_order_id], ['Asset', run._labels.asset_id], ['Procedure', run._labels.procedure_id],
          ['Technician', run._labels.technician_id], ['Started', dt(run.started_at)], ['Completed', dt(run.completed_at)], ['Progress', `${done} of ${results.length} steps recorded`]]
          .map(([k, v]) => h('div', { class: 'field' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v || ''))),
        h('div', { class: 'field wide' }, h('div', { class: 'k' }, 'Test equipment'), h('div', { class: 'v pre' }, run.test_equipment || 'None recorded')),
        run.signature ? h('div', { class: 'field wide' }, h('div', { class: 'k' }, 'Electronic signature'), h('div', { class: 'v' }, run.signature)) : null)),
      h('div', { class: 'card', style: 'padding:0' }, steps));
    if (active) {
      const elx = el.querySelector(`[data-k="${active}"]`);
      if (elx) { elx.focus(); try { elx.setSelectionRange(caret, caret); } catch { /* not a text input */ } }
    }
  };
  render();
}

// ======================================================================
// Reports
// ======================================================================
async function viewReports(el, name, params) {
  if (!name) {
    el.replaceChildren(h('div', { class: 'page-head' }, h('h1', {}, 'Reports & KPIs')),
      h('div', { class: 'grid g3' }, S.meta.reports.map(r => h('a', { class: 'kpi', href: `#/reports/${r.key}` }, h('div', { style: 'font-weight:600' }, r.title),
        h('div', { class: 'l' }, r.filters.length ? `Filters: ${r.filters.map(f => f === 'category' ? 'device type' : f.replace('_id', '')).join(', ')}` : 'No filters')))));
    return;
  }
  const meta = S.meta.reports.find(r => r.key === name);
  const filters = {};
  const filterNodes = [];
  for (const f of meta.filters) {
    let inp;
    if (f === 'from' || f === 'to') inp = h('input', { type: 'date', value: params[f] || '' });
    else if (f.endsWith('_id')) {
      const refName = { facility_id: 'facilities', department_id: 'departments', technician_id: 'users', model_id: 'models', inventory_id: 'inventories' }[f];
      inp = refPicker({ ref: refName }, params[f] ? Number(params[f]) : null, '');
      if (params[f]) { const p = inp; api('GET', `/api/e/${refName}/${params[f]}`).then(r => { $('input', p).value = r.row._label; }).catch(() => {}); }
    } else if (f === 'utl_status') inp = h('select', {}, h('option', { value: '' }, 'All'), h('option', {}, 'Open'), h('option', {}, 'Resolved'));
    else if (f === 'source') inp = h('select', {}, h('option', { value: '' }, 'All sources'), ['Inventory', 'PM Work Order', 'Work Order', 'Manual'].map(o => h('option', {}, o)));
    else if (f === 'flag') inp = h('select', {}, h('option', { value: '' }, 'Red and Yellow'), h('option', {}, 'Red'), h('option', {}, 'Yellow'));
    else if (f === 'type') inp = h('select', {}, h('option', { value: '' }, 'All types'), ent('work_orders').fields.find(x => x.name === 'type').options.map(o => h('option', {}, o)));
    else if (f === 'result') inp = h('select', {}, h('option', { value: '' }, 'All'), h('option', {}, 'Pass'), h('option', {}, 'Fail'));
    else if (f === 'status') inp = h('select', {}, h('option', { value: '' }, 'All'), ent('assets').fields.find(x => x.name === 'status').options.map(o => h('option', {}, o)));
    else if (f === 'category') {
      const types = (await api('GET', '/api/distinct/models/category').catch(() => ({ values: [] }))).values;
      inp = h('select', {}, h('option', { value: '' }, 'All device types'), types.map(o => h('option', {}, o)));
    } else inp = h('input', { type: 'text', value: params[f] || '' });
    if (inp.tagName === 'SELECT' && params[f]) inp.value = params[f];
    filters[f] = inp;
    const flabel = { utl_status: 'status', from: 'from', to: 'to', category: 'device type' }[f] || f.replace('_id', '').replace('_', ' ');
    filterNodes.push(h('div', { style: 'min-width:170px' }, h('label', { class: 'small muted' }, flabel), inp));
  }
  const vals = () => Object.fromEntries(Object.entries(filters).map(([k, i]) => [k, i.value ?? '']));
  // Printed reports state the filters used (e.g. which department), for presentation.
  const printFilters = h('div', { class: 'small' });
  const describeFilters = () => Object.entries(filters).map(([k, i]) => {
    const v = i.classList?.contains('picker') ? (i.value ? $('input', i).value : '') : i.value;
    return v ? `${filterNodes.find(n => n.contains(i))?.querySelector('label')?.textContent || k}: ${v}` : null;
  }).filter(Boolean).join(' · ');
  const out = h('div');
  const run = async () => {
    const r = await api('GET', `/api/reports/${name}?` + qs(vals()));
    printFilters.textContent = `${describeFilters() || 'All records'} · Generated ${new Date().toLocaleString()}`;
    out.replaceChildren(h('div', { class: 'muted small', style: 'margin-bottom:.5rem' }, `${r.rows.length} row(s) · generated ${new Date().toLocaleString()}`),
      r.rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'report' }, h('thead', {}, h('tr', {}, r.columns.map(c => h('th', {}, c.label)))),
        h('tbody', {}, r.rows.map(row => h('tr', {}, r.columns.map(c => {
          const v = row[c.key];
          const txt = v == null ? '' : c.type === 'money' ? money(v) : c.type === 'pct' ? `${num(v)}%` : c.type === 'number' ? num(v) : ['status', 'result', 'recommendation', 'priority', 'cyber_risk', 'patch_status', 'flag'].includes(c.key) ? pill(v) : String(v);
          const long = ['problem', 'work_performed', 'test_equipment', 'title', 'reasons', 'notes', 'resolution'].includes(c.key);
          return h('td', { class: (['money', 'pct', 'number', 'int'].includes(c.type) ? 'num' : '') + (long ? ' wrap' : '') }, txt);
        })))))) : h('div', { class: 'card muted' }, 'No data for these filters.'));
  };
  el.replaceChildren(h('div', { class: 'page-head' }, h('div', {}, h('div', { class: 'muted small' }, h('a', { href: '#/reports' }, 'Reports')), h('h1', {}, meta.title)),
    h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => { location.href = `/api/reports/${name}?` + qs({ ...vals(), format: 'csv' }); } }, 'Export CSV / Excel'),
      h('button', { class: 'btn', onclick: () => window.print() }, 'Print / PDF'))),
  h('div', { class: 'print-only' }, h('h2', {}, `${S.meta.org_name} - ${meta.title}`), printFilters),
  filterNodes.length ? h('div', { class: 'card toolbar', style: 'align-items:flex-end' }, filterNodes, h('button', { class: 'btn primary', onclick: () => run().catch(fail) }, 'Run')) : null, out);
  await run();
}

// ======================================================================
// Audit trail
// ======================================================================
async function viewAudit(el, params) {
  const f = { user: h('input', { type: 'text', placeholder: 'username', value: params.user || '' }), action: h('select', {}, ['', 'create', 'update', 'delete', 'e-signature', 'login', 'login-failed', 'import', 'attach', 'settings', 'backup', 'stock', 'reopen'].map(a => h('option', { value: a }, a || 'All actions'))),
    entity: h('select', {}, h('option', { value: '' }, 'All records'), Object.values(S.meta.entities).map(e => h('option', { value: e.name }, e.plural))),
    from: h('input', { type: 'date' }), to: h('input', { type: 'date' }) };
  const out = h('div');
  const vals = () => Object.fromEntries(Object.entries(f).map(([k, i]) => [k, i.value]));
  const run = async () => { const r = await api('GET', '/api/audit?' + qs({ ...vals(), limit: 500 })); out.replaceChildren(auditTable(r.rows)); };
  el.replaceChildren(h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Audit Trail'), h('div', { class: 'muted small' }, 'Every create, change, delete, signature, login and export is recorded. Entries cannot be edited or deleted from the application.')),
    h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => { location.href = '/api/audit?' + qs({ ...vals(), format: 'csv' }); } }, 'Export CSV'))),
  h('div', { class: 'card toolbar', style: 'align-items:flex-end' }, Object.entries(f).map(([k, i]) => h('div', {}, h('label', { class: 'small muted' }, k), i)), h('button', { class: 'btn primary', onclick: () => run().catch(fail) }, 'Filter')), out);
  await run();
}

// ======================================================================
// Settings (admin)
// ======================================================================
async function viewSettings(el) {
  const s = await api('GET', '/api/settings');
  const b = await api('GET', '/api/backups');
  const inp = {
    org_name: h('input', { type: 'text', value: s.settings.org_name }),
    public_url: h('input', { type: 'text', value: s.settings.public_url, placeholder: 'https://cmms.example.org' }),
    portal_enabled: h('select', {}, h('option', { value: '1' }, 'Enabled'), h('option', { value: '0' }, 'Disabled')),
    portal_message: h('textarea', { rows: 2 }, s.settings.portal_message),
    sla_emergency_hours: h('input', { type: 'number', value: s.settings.sla_emergency_hours || 1 }),
    sla_urgent_hours: h('input', { type: 'number', value: s.settings.sla_urgent_hours || 4 }),
    sla_high_hours: h('input', { type: 'number', value: s.settings.sla_high_hours || 24 }),
    label_code: h('select', {}, h('option', { value: 'qr' }, 'QR code'), h('option', { value: 'barcode' }, 'Barcode (Code 128)'), h('option', { value: 'both' }, 'QR code + barcode')),
    label_qr_content: h('select', {}, h('option', { value: 'url' }, 'Service request link (any phone camera)'), h('option', { value: 'tag' }, 'Asset tag only')),
    label_size: h('select', {}, Object.entries(LABEL_SIZES).map(([k, v]) => h('option', { value: k }, v.label))),
  };
  inp.portal_enabled.value = s.settings.portal_enabled === '0' ? '0' : '1';
  inp.label_code.value = s.settings.label_code || 'qr';
  inp.label_qr_content.value = s.settings.label_qr_content || 'url';
  inp.label_size.value = s.settings.label_size || 'standard';
  const field = (label, i, hint) => h('div', { class: 'field' }, h('label', {}, label), i, hint ? h('div', { class: 'hint' }, hint) : null);
  const lists = {};
  for (const l of s.lookups) (lists[l.list] = lists[l.list] || []).push(l.value);
  const lookupBoxes = Object.entries(lists).map(([list, values]) => {
    const ta = h('textarea', { rows: 8 }, values.join('\n'));
    return h('div', { class: 'field' }, h('label', {}, list.replace('_', ' ')), ta, h('button', { class: 'btn small', style: 'margin-top:.4rem', onclick: () =>
      api('PUT', `/api/lookups/${list}`, { values: ta.value.split('\n') }).then(() => toast('Saved')).catch(fail) }, 'Save list'));
  });
  el.replaceChildren(h('div', { class: 'page-head' }, h('h1', {}, 'Settings & Backups')),
    h('div', { class: 'card form' }, h('h2', {}, 'Organization & portal'), h('div', { class: 'fields' },
      field('Organization name', inp.org_name), field('Public URL', inp.public_url, 'Used on printed asset labels so staff can scan to request service.'),
      field('Service request portal', inp.portal_enabled, 'Allows anyone who can reach the server to submit requests at /portal'), field('Portal message', inp.portal_message),
      field('Escalate Emergency WOs after (hours)', inp.sla_emergency_hours), field('Escalate Urgent WOs after (hours)', inp.sla_urgent_hours), field('Escalate High WOs after (hours)', inp.sla_high_hours),
      h('div', { class: 'section-title' }, 'Asset labels (defaults; can be changed when printing)'),
      field('Code type', inp.label_code), field('QR code contains', inp.label_qr_content, 'The service request link lets anyone scan with a phone camera to report a problem with that device. Requires Public URL.'),
      field('Label size', inp.label_size)),
    h('button', { class: 'btn primary', style: 'margin-top:1rem', onclick: () => api('PUT', '/api/settings', Object.fromEntries(Object.entries(inp).map(([k, i]) => [k, i.value])))
      .then(async () => { S.meta = await api('GET', '/api/meta'); localStorage.removeItem('libre.labels'); toast('Settings saved'); }).catch(fail) }, 'Save settings')),
    h('div', { class: 'card form' }, h('h2', {}, 'Failure, cause & action codes'), h('div', { class: 'fields' }, lookupBoxes)),
    h('div', { class: 'card' }, h('h2', {}, 'Backups'),
      h('p', { class: 'muted' }, `Automatic daily backups are written to ${b.dir}. Copy this folder to another machine or offsite storage regularly.`),
      h('button', { class: 'btn primary', onclick: () => api('POST', '/api/backups', {}).then(r => { toast(`Backup ${r.file} created`); route(); }).catch(fail) }, 'Back up now'),
      h('div', { class: 'table-wrap', style: 'margin-top:.75rem' }, h('table', {}, h('tbody', {}, b.rows.map(r => h('tr', {}, h('td', {}, r.name), h('td', { class: 'num' }, `${(r.size / 1048576).toFixed(2)} MB`),
        h('td', {}, h('a', { href: `/api/backups/${encodeURIComponent(r.name)}` }, 'Download')))))))),
    h('div', { class: 'card' }, h('h2', {}, 'Server'), h('div', { class: 'fields' }, Object.entries(s.server).map(([k, v]) => h('div', { class: 'field' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, String(v)))))));
}

// ======================================================================
// Scan, labels, about
// ======================================================================
// ======================================================================
// Inventory Mode
// ======================================================================
async function viewInventoryStart(el) {
  const facilities = (await api('GET', '/api/e/facilities?limit=500&sort=name')).rows;
  const facSel = h('select', {}, facilities.length > 1 ? h('option', { value: '' }, 'Choose a facility…') : null, facilities.map(f => h('option', { value: f.id }, f.name)));
  const deptSel = h('select', {}, h('option', { value: '' }, 'Choose a department…'));
  const info = h('div', { class: 'muted small' });
  const loadDepts = async () => {
    deptSel.replaceChildren(h('option', { value: '' }, 'Choose a department…'));
    const q = facSel.value ? { f_facility_id: facSel.value } : {};
    const d = await api('GET', '/api/e/departments?' + qs({ ...q, limit: 1000, sort: 'name' }));
    deptSel.append(...d.rows.map(x => h('option', { value: x.id }, x.name)));
  };
  facSel.addEventListener('change', loadDepts);
  deptSel.addEventListener('change', async () => {
    info.textContent = '';
    if (!deptSel.value) return;
    const r = await api('GET', '/api/e/assets?' + qs({ f_department_id: deptSel.value, view: 'active', limit: 1 }));
    info.textContent = `${r.total} asset(s) are owned by this department. Assets last located here are also expected.`;
  });
  await loadDepts();
  const startBtn = h('button', { class: 'btn primary', onclick: async () => {
    if (!deptSel.value) return toast('Choose a department', true);
    const r = await api('POST', '/api/inventories', { facility_id: facSel.value || null, department_id: Number(deptSel.value) }).catch(fail);
    if (r) { if (r.resumed) toast('An inventory of this department was already in progress - resuming it'); go(`#/inventory/${r.id}`); }
  } }, 'Start inventory');
  const open = await api('GET', '/api/e/inventories?' + qs({ view: 'in_progress', limit: 50 }));
  const recent = await api('GET', '/api/e/inventories?' + qs({ view: 'completed', limit: 10 }));
  el.replaceChildren(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Inventory Mode'), h('div', { class: 'muted' }, 'Choose a department, then scan every asset you find there.'))),
    h('div', { class: 'card form stack', style: 'max-width:620px' }, h('h2', {}, 'Start a department inventory'),
      h('div', {}, h('label', {}, 'Facility'), facSel), h('div', {}, h('label', {}, 'Department'), deptSel), info, startBtn),
    open.rows.length ? h('div', { class: 'card' }, h('h2', {}, 'In progress'), renderTable(ent('inventories'), open.rows, { onRow: r => go(`#/inventory/${r.id}`) })) : null,
    recent.rows.length ? h('div', { class: 'card' }, h('h2', {}, 'Recently completed'), renderTable(ent('inventories'), recent.rows, { onRow: r => go(`#/inventory/${r.id}`) }),
      h('div', { style: 'margin-top:.5rem' }, h('a', { href: '#/list/inventories' }, 'All inventories →'))) : null);
}

// Short audible cue so the user can keep scanning without looking at the screen.
function beep(kind) {
  try {
    const ctx = beep.ctx || (beep.ctx = new (window.AudioContext || window.webkitAudioContext)());
    const tones = kind === 'red' ? [[220, 0], [220, 0.22]] : kind === 'yellow' ? [[520, 0]] : [[880, 0]];
    for (const [f, at] of tones) {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.15, ctx.currentTime + at); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + at + 0.18);
      o.start(ctx.currentTime + at); o.stop(ctx.currentTime + at + 0.2);
    }
  } catch { /* audio unavailable */ }
}

const flagClass = lvl => ({ Red: 'red', Yellow: 'yellow', red: 'red', yellow: 'yellow' }[lvl] || 'green');
function flagList(flags) {
  const f = (flags || []).filter(x => x.text);
  return f.length ? h('div', { class: 'flags' }, f.map(x => h('div', { class: { red: 'r', yellow: 'y', info: 'i' }[x.level] }, (x.level === 'red' ? '● ' : x.level === 'yellow' ? '▲ ' : 'ℹ ') + x.text))) : null;
}

async function viewInventory(el, id) {
  let S2 = await api('GET', `/api/inventories/${id}/session`);
  const inv = S2.inventory;
  const deptName = inv._labels?.department_id || 'Department';
  const facName = inv._labels?.facility_id || '';
  if (inv.status !== 'In Progress') return viewInventorySummary(el, S2);

  const roomKey = `libre.invroom.${id}`;
  const room = h('input', { type: 'text', placeholder: 'e.g. Bed 4, Clean utility', value: sessionStorage.getItem(roomKey) || '' });
  room.addEventListener('input', () => sessionStorage.setItem(roomKey, room.value));
  const code = h('input', { type: 'text', class: 'code', placeholder: 'Scan or type asset tag, then Enter', autocomplete: 'off', autocapitalize: 'characters' });
  const result = h('div');
  const stats = h('div', { class: 'inv-head' });
  const scannedHost = h('div', { class: 'inv-list' });
  const remainingHost = h('div', { class: 'inv-list' });
  const video = h('video', { playsinline: true, muted: true, style: 'width:100%;max-width:420px;border-radius:8px;display:none;background:#000' });
  let busy = false;

  const refresh = async () => { S2 = await api('GET', `/api/inventories/${id}/session`); render(); };
  function render() {
    const exp = S2.expected;
    const found = exp.filter(x => x.scanned).length;
    const red = S2.scans.filter(s => s.flag_level === 'Red').length;
    const yellow = S2.scans.filter(s => s.flag_level === 'Yellow').length;
    const other = S2.scans.filter(s => s.result === 'Found - Other Department').length;
    const notIn = S2.scans.filter(s => s.result === 'Not In Inventory' || s.result === 'Added To Inventory').length;
    const k = (v, l, cls = '') => h('div', { class: `kpi ${cls}` }, h('div', { class: 'v' }, v), h('div', { class: 'l' }, l));
    stats.replaceChildren(k(`${found} / ${exp.length}`, 'Expected assets found', found === exp.length ? 'ok' : ''), k(exp.length - found, 'Not yet scanned', exp.length - found ? 'warn' : 'ok'),
      k(red, 'Red flags', red ? 'bad' : ''), k(yellow, 'Yellow flags', yellow ? 'warn' : ''), k(other, 'From other departments'), k(notIn, 'Not in inventory', notIn ? 'bad' : ''));
    scannedHost.replaceChildren(S2.scans.length ? S2.scans.map(s => h('div', { class: `inv-item ${flagClass(s.flag_level)}` },
      h('div', { class: 'main' }, h('div', {}, h('strong', {}, s.asset_tag || s.scanned_code), ' ', pill(s.result), s.room ? h('span', { class: 'muted small' }, ` · ${s.room}`) : ''),
        s.asset_id ? h('div', { class: 'small muted' }, `${s.description || ''}${s.serial_number ? ' · SN ' + s.serial_number : ''}`) : null, flagList(s.flags)),
      h('button', { class: 'btn small', title: 'Remove this scan', onclick: async () => {
        await api('DELETE', `/api/inventories/${id}/scans/${s.id}`).catch(fail); refresh();
      } }, '×'))) : h('div', { class: 'muted', style: 'padding:.6rem' }, 'Nothing scanned yet.'));
    const remaining = exp.filter(x => !x.scanned).sort((a, b) => ({ Red: 0, Yellow: 1, None: 2 }[a.flag_level] - { Red: 0, Yellow: 1, None: 2 }[b.flag_level]));
    remainingHost.replaceChildren(remaining.length ? remaining.map(x => h('div', { class: `inv-item ${flagClass(x.flag_level)}` },
      h('div', { class: 'main' }, h('div', {}, h('a', { href: `#/assets/${x.id}`, target: '_blank' }, x.asset_tag), ` ${x.description || ''}`),
        h('div', { class: 'small muted' }, [x.serial_number ? `SN ${x.serial_number}` : '', x.current_room || x.room ? `last at ${x.current_room || x.room}` : '', x.last_seen_at ? `seen ${x.last_seen_at.slice(0, 10)}` : 'never inventoried'].filter(Boolean).join(' · ')),
        flagList(x.flags.filter(f => f.level !== 'info'))))) : h('div', { class: 'muted', style: 'padding:.6rem' }, 'All expected assets have been scanned.'));
  }

  function showResult(r) {
    const s = r.scan;
    const cls = flagClass(s.flag_level);
    const title = r.duplicate ? 'Already scanned' : r.notFound ? 'NOT IN INVENTORY' : cls === 'red' ? 'RED FLAG' : cls === 'yellow' ? 'Yellow flag' : 'OK';
    result.replaceChildren(h('div', { class: `inv-result ${r.duplicate ? 'green' : cls}` },
      h('div', { class: 'big' }, `${title} — ${r.asset ? r.asset.asset_tag : s.scanned_code}`),
      r.asset ? h('div', {}, `${r.asset.description || ''}${r.asset.serial_number ? ' · SN ' + r.asset.serial_number : ''}`) : null,
      flagList(s.flags)));
    if (!r.duplicate) beep(cls);
  }

  async function doScan(value) {
    const v = String(value || '').trim();
    if (!v || busy) return;
    busy = true;
    try {
      const r = await api('POST', `/api/inventories/${id}/scan`, { code: v, room: room.value });
      showResult(r);
      code.value = '';
      await refresh();
      const recalls = (r.scan.flags || []).filter(f => f.alert);
      if (recalls.length && !r.duplicate) {
        await modal(`⚠ Recall alert — ${r.asset?.asset_tag || v}`, h('div', { class: 'stack' },
          recalls.map(f => h('div', { class: 'banner bad' }, f.text, f.link ? h('div', {}, h('a', { href: f.link, target: '_blank' }, 'Open recall')) : null)),
          h('p', {}, 'Follow your recall procedure (for example, remove from service or tag the device) before continuing.')),
        [{ label: 'Acknowledge', cls: 'primary', value: true }], { cls: 'alert-modal', sticky: true });
      }
      if (r.notFound && !r.duplicate) await offerAdd(r.scan);
    } catch (e) { fail(e); beep('red'); } finally { busy = false; code.focus(); }
  }

  async function offerAdd(scanRow) {
    const add = await modal('Not in inventory', h('div', { class: 'stack' },
      h('div', { class: 'banner bad' }, `"${scanRow.scanned_code}" does not match any asset tag, control number or serial number.`),
      h('p', {}, `Add it to the equipment inventory now? Facility, department${room.value ? ' and room' : ''} will be filled in from this inventory.`)),
    [{ label: 'Not now', value: false }, { label: 'Add to inventory', cls: 'primary', value: true }]);
    if (!add) return;
    const row = { asset_tag: scanRow.scanned_code, status: 'Active', facility_id: inv.facility_id, department_id: inv.department_id,
      current_facility_id: inv.facility_id, current_department_id: inv.department_id, room: room.value || null, current_room: room.value || null,
      _labels: { facility_id: facName, department_id: deptName, current_facility_id: facName, current_department_id: deptName } };
    const form = buildForm(ent('assets'), row);
    const saved = await modal('Add asset to inventory', form, [{ label: 'Cancel', value: null }, { label: 'Save asset', cls: 'primary', action: async () => {
      const a = await api('POST', '/api/e/assets', form.values());
      return a.row;
    } }], { wide: true });
    if (!saved) return;
    const l = await api('POST', `/api/inventories/${id}/scans/${scanRow.id}/link`, { asset_id: saved.id }).catch(fail);
    if (l) { toast(`${saved.asset_tag} added to inventory`); showResult({ ...l, notFound: false }); await refresh(); }
  }

  code.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); doScan(code.value); } });

  let stream = null; let timer = null; let lastCam = '';
  const stopCam = () => { if (stream) stream.getTracks().forEach(t => t.stop()); clearInterval(timer); stream = null; video.style.display = 'none'; };
  const camera = async () => {
    if (stream) return stopCam();
    if (!('BarcodeDetector' in window)) return toast('Camera scanning is not supported in this browser. Use a USB/Bluetooth scanner or type the tag.', true);
    try {
      const det = new window.BarcodeDetector();
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      video.srcObject = stream; video.style.display = ''; await video.play();
      timer = setInterval(async () => {
        const c = (await det.detect(video).catch(() => []))[0];
        if (c && c.rawValue !== lastCam && !busy) { lastCam = c.rawValue; doScan(c.rawValue); setTimeout(() => { lastCam = ''; }, 3000); }
      }, 350);
    } catch (e) { toast(`Camera unavailable: ${e.message}`, true); }
  };
  window.addEventListener('hashchange', stopCam, { once: true });

  const finish = async () => {
    const remaining = S2.expected.filter(x => !x.scanned);
    const boxes = remaining.map(x => ({ x, cb: h('input', { type: 'checkbox', checked: true }) }));
    const body = h('div', { class: 'stack' },
      h('p', {}, `Completing updates the current location of ${S2.scans.filter(s => s.asset_id).length} scanned asset(s) to ${deptName}. Owning departments are not changed.`),
      remaining.length ? [h('p', {}, h('strong', {}, `${remaining.length} expected asset(s) were not scanned.`), ' Checked items will be marked Unable To Locate:'),
        h('div', { class: 'inv-list', style: 'max-height:300px;border:1px solid var(--line);border-radius:6px' }, boxes.map(({ x, cb }) =>
          h('label', { class: `inv-item ${flagClass(x.flag_level)}`, style: 'cursor:pointer' }, cb, h('div', { class: 'main' }, h('strong', {}, x.asset_tag), ` ${x.description || ''}`, h('div', { class: 'small muted' }, x.serial_number ? `SN ${x.serial_number}` : ''))))),
      ] : h('div', { class: 'banner ok' }, 'Every expected asset was found.'));
    const ok = await modal(`Complete inventory ${inv.inventory_number}`, body, [{ label: 'Keep scanning', value: false }, { label: 'Complete inventory', cls: 'primary', value: true }], { wide: true });
    if (!ok) return;
    const r = await api('POST', `/api/inventories/${id}/complete`, { utl_asset_ids: boxes.filter(b => b.cb.checked).map(b => b.x.id) }).catch(fail);
    if (r) { sessionStorage.removeItem(roomKey); toast(`${inv.inventory_number} completed`); route(); }
  };

  el.replaceChildren(
    h('div', { class: 'page-head' }, h('div', {}, h('div', { class: 'muted small' }, h('a', { href: '#/inventory' }, 'Inventory Mode')),
      h('h1', {}, `${deptName} inventory `, pill(inv.status)), h('div', { class: 'muted' }, `${inv.inventory_number} · ${facName} · started ${dt(inv.started_at)} by ${inv.started_by}`)),
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: finish }, 'Complete inventory'),
      h('button', { class: 'btn danger', onclick: async () => {
        if (!await confirmBox('Cancel inventory', 'Cancel this inventory? Scans are kept for reference but no locations are updated.', 'Cancel inventory', 'danger')) return;
        await api('POST', `/api/inventories/${id}/cancel`, {}).then(() => go('#/inventory')).catch(fail);
      } }, 'Cancel'))),
    stats,
    h('div', { class: 'card' }, h('div', { class: 'inv-scan form' },
      h('div', {}, h('label', {}, 'Asset tag'), code), h('div', {}, h('label', {}, 'Current room (optional)'), room),
      h('button', { class: 'btn primary', onclick: () => doScan(code.value) }, 'Enter'), h('button', { class: 'btn', onclick: camera }, '\u{1F4F7} Camera')),
    video, result),
    h('div', { class: 'inv-cols' },
      h('div', { class: 'card', style: 'padding:0' }, h('h3', { style: 'padding:.75rem .75rem 0' }, 'Scanned'), scannedHost),
      h('div', { class: 'card', style: 'padding:0' }, h('h3', { style: 'padding:.75rem .75rem 0' }, 'Not yet scanned'), h('div', { class: 'small muted', style: 'padding:0 .75rem .5rem' }, 'Red items were previously Unable To Locate or have open recalls or repairs.'), remainingHost)));
  render();
  code.focus();
}

async function viewInventorySummary(el, S2) {
  const inv = S2.inventory;
  const deptName = inv._labels?.department_id || '';
  const k = (v, l, cls = '') => h('div', { class: `kpi ${cls}` }, h('div', { class: 'v' }, v ?? 0), h('div', { class: 'l' }, l));
  const scans = (await api('GET', '/api/e/inventory_scans?' + qs({ f_inventory_id: inv.id, limit: 2000 }))).rows;
  const utl = (await api('GET', '/api/e/utl_events?' + qs({ f_inventory_id: inv.id, limit: 2000 }))).rows;
  el.replaceChildren(
    h('div', { class: 'page-head' }, h('div', {}, h('div', { class: 'muted small' }, h('a', { href: '#/inventory' }, 'Inventory Mode')),
      h('h1', {}, `${deptName} inventory `, pill(inv.status)), h('div', { class: 'muted' }, `${inv.inventory_number} · ${inv._labels?.facility_id || ''} · completed ${dt(inv.completed_at)} by ${inv.completed_by || ''}`)),
    h('div', { class: 'actions' }, h('a', { class: 'btn primary', href: `#/reports/inventory_flags?inventory_id=${inv.id}` }, 'Red & Yellow flag report'),
      h('a', { class: 'btn', href: `#/reports/unable_to_locate?department_id=${inv.department_id}&utl_status=Open` }, 'Department UTL report'),
      h('button', { class: 'btn', onclick: () => window.print() }, 'Print'))),
    h('div', { class: 'print-only' }, h('h2', {}, `${S.meta.org_name} — ${deptName} equipment inventory ${inv.inventory_number}`)),
    h('div', { class: 'inv-head' }, k(inv.expected_count, 'Expected'), k(inv.found_count, 'Found', 'ok'), k(inv.missing_count, 'Unable To Locate', inv.missing_count ? 'bad' : 'ok'),
      k(inv.red_count, 'Red flags', inv.red_count ? 'bad' : ''), k(inv.yellow_count, 'Yellow flags', inv.yellow_count ? 'warn' : ''), k(inv.unexpected_count, 'From other departments'), k(inv.added_count, 'Added to inventory')),
    utl.length ? h('div', { class: 'card' }, h('h2', {}, 'Unable To Locate'), renderTable(ent('utl_events'), utl, { columns: ent('utl_events').fields.filter(f => ['asset_id', 'status', 'department_id', 'resolved_at'].includes(f.name)) })) : null,
    h('div', { class: 'card' }, h('h2', {}, 'Scans'), renderTable(ent('inventory_scans'), scans.sort((a, b) => ({ Red: 0, Yellow: 1 }[a.flag_level] ?? 2) - ({ Red: 0, Yellow: 1 }[b.flag_level] ?? 2)),
      { columns: ent('inventory_scans').fields.filter(f => ['asset_id', 'scanned_code', 'room', 'result', 'flag_level', 'flag_text'].includes(f.name)), onRow: r => r.asset_id && go(`#/assets/${r.asset_id}`) })));
}

function viewScan(el) {
  const inp = h('input', { type: 'text', placeholder: 'Asset tag, control # or serial #', autofocus: true });
  const video = h('video', { playsinline: true, muted: true, style: 'width:100%;max-width:480px;border-radius:8px;display:none;background:#000' });
  const msg = h('div', { class: 'muted small' });
  const find = async code => {
    const m = String(code).match(/[?&]asset=([^&#]+)/);
    if (m) code = decodeURIComponent(m[1]); // a scanned label QR link
    try { const r = await api('GET', '/api/lookup/asset?' + qs({ code })); stop(); go(`#/assets/${r.id}`); } catch (e) { msg.textContent = e.message; }
  };
  let stream = null; let timer = null;
  const stop = () => { if (stream) stream.getTracks().forEach(t => t.stop()); clearInterval(timer); stream = null; };
  const camera = async () => {
    if (!('BarcodeDetector' in window)) { msg.textContent = 'This browser does not support camera barcode scanning. Use a USB/Bluetooth barcode scanner (it types into the box) or enter the tag.'; return; }
    try {
      const det = new window.BarcodeDetector();
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      video.srcObject = stream; video.style.display = ''; await video.play();
      msg.textContent = 'Point the camera at the asset barcode or QR code…';
      timer = setInterval(async () => {
        const codes = await det.detect(video).catch(() => []);
        if (codes[0]) {
          let v = codes[0].rawValue;
          const m = v.match(/[?&]asset=([^&]+)/); if (m) v = decodeURIComponent(m[1]);
          find(v);
        }
      }, 400);
    } catch (e) { msg.textContent = `Camera unavailable: ${e.message}. Camera access requires HTTPS on remote devices.`; }
  };
  window.addEventListener('hashchange', stop, { once: true });
  el.replaceChildren(h('div', { class: 'page-head' }, h('h1', {}, 'Scan / Find Asset')),
    h('div', { class: 'card stack', style: 'max-width:560px' },
      h('form', { class: 'toolbar', onsubmit: e => { e.preventDefault(); find(inp.value.trim()); } }, inp, h('button', { class: 'btn primary' }, 'Find')),
      h('button', { class: 'btn', onclick: camera }, '\u{1F4F7} Scan with camera'), video, msg));
}

const LABEL_SIZES = {
  small: { label: '2" × 1" (thermal)', w: 2, h: 1 },
  standard: { label: '2.25" × 1.25" (thermal)', w: 2.25, h: 1.25 },
  large: { label: '3" × 2"', w: 3, h: 2 },
  sheet: { label: '2.625" × 1" (Avery 5160 / 30 per sheet)', w: 2.625, h: 1, sheet: true },
};
const portalUrl = tag => `${(S.meta.labels.public_url || location.origin).replace(/\/+$/, '')}/portal?asset=${encodeURIComponent(tag)}`;

async function viewLabels(el, params) {
  const r = params.ids ? { rows: await Promise.all(params.ids.split(',').map(i => api('GET', `/api/e/assets/${i}`).then(x => x.row))) }
    : await api('GET', '/api/e/assets?' + qs({ view: params.view, limit: 1000 }));
  // Defaults come from Settings; choices made here are remembered on this device.
  const saved = JSON.parse(localStorage.getItem('libre.labels') || '{}');
  const opt = { code: S.meta.labels.code, qr_content: S.meta.labels.qr_content, size: S.meta.labels.size, perPage: false, ...saved };
  if (!LABEL_SIZES[opt.size]) opt.size = 'standard';
  const sel = (key, options) => {
    const s = h('select', { style: 'width:auto' }, Object.entries(options).map(([v, l]) => h('option', { value: v }, l)));
    s.value = opt[key];
    s.addEventListener('change', () => { opt[key] = s.value; save(); render(); });
    return s;
  };
  const perPage = h('input', { type: 'checkbox', checked: opt.perPage, onchange: () => { opt.perPage = perPage.checked; save(); render(); } });
  const save = () => localStorage.setItem('libre.labels', JSON.stringify(opt));
  const sheet = h('div', { class: 'label-sheet' });
  const warn = h('div');
  const pageStyle = h('style');

  function label(a) {
    const tag = a.asset_tag || String(a.id);
    const qrText = opt.qr_content === 'url' ? portalUrl(tag) : tag;
    const sz = LABEL_SIZES[opt.size];
    const qr = opt.code !== 'barcode' ? h('div', { class: 'qr', html: window.LibreQR.svg(qrText, { ecl: 'M', border: 2 }) }) : null;
    const bar = opt.code !== 'qr' ? h('div', { class: 'bar', html: window.LibreBarcode.svg(tag) }) : null;
    const text = h('div', { class: 'txt' }, h('div', { class: 'org' }, S.meta.org_name), h('div', { class: 'model' }, a._labels?.model_id || a.description || ''),
      opt.code === 'barcode' ? bar : null, h('div', { class: 'tag' }, tag), h('div', { class: 'sn' }, `SN ${a.serial_number || '-'}`),
      opt.code !== 'barcode' && opt.qr_content === 'url' ? h('div', { class: 'hint' }, 'Scan for service') : null);
    // QR + barcode: QR and text on top, barcode across the full label width (narrow bars do not scan).
    const body = opt.code === 'both' ? [h('div', { class: 'top' }, qr, text), bar] : [qr, text];
    return h('div', { class: `asset-label code-${opt.code}`, style: `width:${sz.w}in;height:${sz.h}in` }, ...body);
  }
  function render() {
    const sz = LABEL_SIZES[opt.size];
    sheet.className = 'label-sheet' + (opt.perPage ? ' per-page' : '') + (sz.sheet ? ' avery' : '');
    pageStyle.textContent = opt.perPage ? `@media print { @page { size: ${sz.w}in ${sz.h}in; margin: 0; } }` : '';
    sheet.replaceChildren(...r.rows.map(label));
    const host = (S.meta.labels.public_url || location.origin);
    warn.replaceChildren(opt.code !== 'barcode' && opt.qr_content === 'url' && /\/\/(localhost|127\.|\[::1\])/.test(host)
      ? h('div', { class: 'banner warn' }, `QR codes will point to ${host}, which phones cannot reach. An administrator should set Settings → Public URL to the address staff use (e.g. https://cmms.hospital.org).`) : '');
  }
  el.replaceChildren(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Asset Labels'), h('div', { class: 'muted small' }, `${r.rows.length} label(s)`)),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => window.print() }, 'Print'))),
    h('div', { class: 'card toolbar no-print', style: 'align-items:flex-end' },
      h('div', {}, h('label', { class: 'small muted' }, 'Code type'), sel('code', { qr: 'QR code', barcode: 'Barcode (Code 128)', both: 'QR code + barcode' })),
      h('div', {}, h('label', { class: 'small muted' }, 'QR code contains'), sel('qr_content', { url: 'Service request link (any phone camera)', tag: 'Asset tag only' })),
      h('div', {}, h('label', { class: 'small muted' }, 'Label size'), sel('size', Object.fromEntries(Object.entries(LABEL_SIZES).map(([k, v]) => [k, v.label])))),
      h('label', { class: 'check', style: 'padding-bottom:.5rem' }, perPage, 'One label per page (thermal label printer)')),
    h('div', { class: 'no-print' }, warn), pageStyle, sheet);
  render();
}

function viewAbout(el) {
  el.replaceChildren(h('div', { class: 'card', style: 'max-width:720px' }, h('h1', {}, 'Libre CMMS'), h('p', {}, `Version ${S.meta.version}`),
    h('p', {}, 'Libre is an open-source computerized maintenance management system for hospital and medical equipment (healthcare technology management).'),
    h('p', {}, 'Copyright © 2026 CreativeMed LLC. Licensed under the GNU Affero General Public License v3.0 or later. This program comes with ABSOLUTELY NO WARRANTY. The source code is available to all users of this server under the terms of the AGPL.'),
    h('p', { class: 'muted small' }, 'Libre supports documentation for regulatory and accreditation programs but does not by itself establish compliance with any standard. Results, signatures and AI or automated recommendations must be reviewed by qualified personnel.')));
}

boot();

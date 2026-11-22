// Libre CMMS - Copyright (C) 2026 CreativeMed LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
// Public service request portal: no login required.
'use strict';
(function () {
  const root = document.getElementById('portal');
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  async function api(method, url, body) {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json', 'X-Libre': '1' }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
    return data;
  }
  const params = new URLSearchParams(location.search);
  const header = org => `<div class="logo"><img src="/icon.svg" alt=""><div><h1>Equipment Service Request</h1><div class="muted small">${esc(org)}</div></div></div>`;
  const footer = '<div class="muted small">Powered by Libre CMMS · © 2026 CreativeMed LLC · <a href="/">Staff sign in</a></div>';

  async function showForm(info) {
    if (!info.portal_enabled) { root.innerHTML = header(info.org_name) + '<div class="banner warn">The online request portal is disabled. Please call Clinical Engineering.</div>' + footer; return; }
    const depts = info.departments.map(d => `<option value="${d.id}">${esc(d.facility ? d.facility + ' - ' : '')}${esc(d.name)}</option>`).join('');
    root.innerHTML = header(info.org_name) +
      (info.portal_message ? `<div class="banner info">${esc(info.portal_message)}</div>` : '') +
      `<div class="banner bad small">For emergencies affecting a patient, call Clinical Engineering immediately in addition to submitting this form.</div>
      <form class="form stack" id="f">
        <div><label>Equipment tag / control # / serial #</label><input type="text" name="asset_text" id="asset" placeholder="Scan or type the number on the asset label"><div class="hint" id="assetinfo"></div></div>
        <div><label class="req">Describe the problem</label><textarea name="problem" required rows="4"></textarea></div>
        <div><label>Urgency</label><select name="urgency"><option>Normal</option><option>Low</option><option>High</option><option>Patient Care Impacted</option></select></div>
        <div class="grid g2"><div><label class="req">Your name</label><input type="text" name="requester_name" required></div>
          <div><label>Phone / extension</label><input type="text" name="requester_phone"></div></div>
        <div><label class="req">Email</label><input type="email" name="requester_email" required autocomplete="email"><div class="hint">Required so Clinical Engineering can update you on your request.</div></div>
        <div class="grid g2"><div><label>Department</label><select name="department_id" id="dept"><option value=""></option>${depts}</select></div>
          <div><label>Room / location</label><input type="text" name="room" id="room"></div></div>
        <div class="banner bad" id="err" style="display:none"></div>
        <button class="btn primary" type="submit">Submit request</button>
      </form>
      <details><summary class="small">Check the status of an existing request</summary>
        <form class="toolbar" id="chk" style="margin-top:.5rem"><input type="text" name="num" placeholder="Request # (SR-...)"><input type="text" name="token" placeholder="Access code"><button class="btn">Check</button></form></details>` + footer;
    const asset = document.getElementById('asset');
    const lookup = async () => {
      const v = asset.value.trim(); const infoEl = document.getElementById('assetinfo');
      if (!v) { infoEl.textContent = ''; return; }
      try {
        const a = await api('GET', `/api/public/asset/${encodeURIComponent(v)}`);
        infoEl.textContent = `✔ ${a.asset_tag}: ${a.description || ''}`;
        if (a.department_id) document.getElementById('dept').value = a.department_id;
        if (a.room && !document.getElementById('room').value) document.getElementById('room').value = a.room;
      } catch { infoEl.textContent = 'Not found in inventory - that is OK, describe the equipment in the problem field.'; }
    };
    asset.addEventListener('change', lookup);
    if (params.get('asset')) { asset.value = params.get('asset'); lookup(); }
    document.getElementById('f').addEventListener('submit', async e => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target));
      try {
        const r = await api('POST', '/api/public/requests', body);
        history.replaceState(null, '', `/portal?num=${encodeURIComponent(r.request_number)}&token=${encodeURIComponent(r.token)}`);
        showStatus(info, r.request_number, r.token, true);
      } catch (ex) { const err = document.getElementById('err'); err.textContent = ex.message; err.style.display = ''; }
    });
    document.getElementById('chk').addEventListener('submit', e => {
      e.preventDefault(); const d = Object.fromEntries(new FormData(e.target)); showStatus(info, d.num.trim(), d.token.trim());
    });
  }

  async function showStatus(info, num, token, fresh) {
    try {
      const s = await api('GET', `/api/public/requests/${encodeURIComponent(num)}?token=${encodeURIComponent(token)}`);
      const link = `${location.origin}/portal?num=${encodeURIComponent(num)}&token=${encodeURIComponent(token)}`;
      root.innerHTML = header(info.org_name) +
        (fresh ? `<div class="banner ok"><strong>Request submitted.</strong> Your request number is <strong>${esc(s.request_number)}</strong>. Bookmark this page or save the link below to check its status.</div>` : '') +
        `<div class="fields"><div class="field"><div class="k">Request #</div><div class="v">${esc(s.request_number)}</div></div>
          <div class="field"><div class="k">Status</div><div class="v"><span class="pill">${esc(s.status)}</span></div></div>
          <div class="field"><div class="k">Submitted</div><div class="v">${esc(new Date(s.submitted).toLocaleString())}</div></div>
          ${s.work_order ? `<div class="field"><div class="k">Work order</div><div class="v">${esc(s.work_order.number)} - ${esc(s.work_order.status)}</div></div>` : ''}
          <div class="field wide"><div class="k">Problem</div><div class="v pre">${esc(s.problem)}</div></div>
          ${s.response ? `<div class="field wide"><div class="k">Response from Clinical Engineering</div><div class="v pre">${esc(s.response)}</div></div>` : ''}</div>
        <div class="small muted">Status link (access code ${esc(token)}): <a href="${esc(link)}">${esc(link)}</a></div>` +
        (s.can_rate ? `<form class="form stack" id="fb"><h3>How did we do?</h3><select name="satisfaction"><option value="5">5 - Excellent</option><option value="4">4 - Good</option><option value="3">3 - OK</option><option value="2">2 - Poor</option><option value="1">1 - Very poor</option></select><textarea name="feedback" placeholder="Comments (optional)"></textarea><button class="btn primary">Send feedback</button></form>` : '') +
        '<a class="btn" href="/portal">Submit another request</a>' + footer;
      const fb = document.getElementById('fb');
      if (fb) fb.addEventListener('submit', async e => {
        e.preventDefault();
        await api('POST', `/api/public/requests/${encodeURIComponent(num)}/feedback?token=${encodeURIComponent(token)}`, Object.fromEntries(new FormData(fb)));
        showStatus(info, num, token);
      });
    } catch (e) {
      root.innerHTML = header(info.org_name) + `<div class="banner bad">${esc(e.message)}</div><a class="btn" href="/portal">Back</a>` + footer;
    }
  }

  api('GET', '/api/public/info').then(info => {
    document.title = `Service Request - ${info.org_name}`;
    if (params.get('num') && params.get('token')) showStatus(info, params.get('num'), params.get('token'));
    else showForm(info);
  }).catch(e => { root.innerHTML = `<div class="banner bad">Cannot reach server: ${esc(e.message)}</div>`; });
})();

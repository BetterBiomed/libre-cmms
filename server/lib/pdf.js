// Libre CMMS - Copyright (C) 2026 CreativeMed LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// Minimal, dependency-free PDF writer for tabular reports (US Letter, Helvetica).
//
//   const buf = pdf.report({ title, subtitle, meta: [['Department', 'ICU'], ...],
//     paragraphs: ['...'], summary: [['Due', '12'], ...],
//     table: { columns: [{ label, width, align }], rows: [[...], ...] }, footer: '...' });

// Helvetica glyph widths (1/1000 em) for ASCII 32..126 from the standard AFM metrics.
const W = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944,
  667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556,
  500, 722, 500, 500, 500, 334, 260, 334, 584];
// Approximate Helvetica-Bold as slightly wider.
const width = (s, size, bold = false) => [...s].reduce((a, ch) => a + (W[ch.charCodeAt(0) - 32] || 556), 0) * size / 1000 * (bold ? 1.06 : 1);

// Keep to the standard WinAnsi range: replace common typographic characters, drop the rest.
function ascii(s) {
  return String(s ?? '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...')
    .replace(/ /g, ' ').replace(/·/g, '-').replace(/[\r\t]/g, ' ').replace(/[^\x20-\x7e\n]/g, '');
}
const esc = s => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

function wrap(text, size, maxW, bold) {
  const out = [];
  for (const para of ascii(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const t = line ? `${line} ${word}` : word;
      if (width(t, size, bold) <= maxW || !line) line = t; else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}
function fit(text, size, maxW, bold) {
  let s = ascii(text).replace(/\n/g, ' ');
  if (width(s, size, bold) <= maxW) return s;
  while (s.length > 1 && width(s + '...', size, bold) > maxW) s = s.slice(0, -1);
  return s + '...';
}

function report(opt) {
  const PW = 612; const PH = 792; const M = 40; const CW = PW - 2 * M;
  const pages = []; let ops = []; let y = 0;
  const brand = [0.06, 0.37, 0.43];
  const text = (x, yy, s, size = 10, bold = false, color = null) => {
    if (color) ops.push(`${color.join(' ')} rg`);
    ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x.toFixed(2)} ${yy.toFixed(2)} Td (${esc(s)}) Tj ET`);
    if (color) ops.push('0 0 0 rg');
  };
  const rect = (x, yy, w, h, rgb) => ops.push(`${rgb.join(' ')} rg ${x.toFixed(2)} ${yy.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f 0 0 0 rg`);
  const line = (x1, y1, x2, y2, gray = 0.8) => ops.push(`${gray} G 0.5 w ${x1} ${y1.toFixed(2)} m ${x2} ${y2.toFixed(2)} l S 0 G`);
  const newPage = () => { if (ops.length) pages.push(ops); ops = []; y = PH - M; };
  const ensure = h => { if (y - h < M + 24) { newPage(); return true; } return false; };

  newPage();
  // Header band
  rect(0, PH - 64, PW, 64, brand);
  text(M, PH - 30, fit(opt.org || 'Libre CMMS', 11, CW, true), 11, true, [1, 1, 1]);
  text(M, PH - 48, fit(opt.title || 'Report', 16, CW, true), 16, true, [1, 1, 1]);
  y = PH - 84;
  if (opt.subtitle) { for (const l of wrap(opt.subtitle, 10, CW)) { text(M, y, l, 10, false, [0.35, 0.4, 0.45]); y -= 14; } y -= 4; }
  if (opt.meta?.length) {
    for (const [k, v] of opt.meta) { text(M, y, `${ascii(k)}:`, 10, true); text(M + 130, y, fit(v, 10, CW - 130), 10); y -= 14; }
    y -= 6;
  }
  for (const p of opt.paragraphs || []) {
    for (const l of wrap(p, 10.5, CW)) { ensure(15); text(M, y, l, 10.5); y -= 15; }
    y -= 8;
  }
  if (opt.summary?.length) {
    ensure(52);
    const bw = Math.min(130, (CW - 8 * (opt.summary.length - 1)) / opt.summary.length);
    opt.summary.forEach(([label, value], i) => {
      const x = M + i * (bw + 8);
      rect(x, y - 40, bw, 44, [0.94, 0.96, 0.97]);
      text(x + 8, y - 16, fit(String(value), 15, bw - 16, true), 15, true, brand);
      text(x + 8, y - 32, fit(label, 8.5, bw - 16), 8.5, false, [0.35, 0.4, 0.45]);
    });
    y -= 56;
  }
  const t = opt.table;
  if (t && t.columns?.length) {
    const total = t.columns.reduce((a, c) => a + (c.width || 1), 0);
    const cols = t.columns.map(c => ({ ...c, w: CW * (c.width || 1) / total }));
    const size = t.fontSize || 8.5; const rowH = size + 7;
    const header = () => {
      rect(M, y - rowH + 3, CW, rowH, [0.85, 0.9, 0.92]);
      let x = M;
      for (const c of cols) { text(x + 3, y - size + 1, fit(c.label, size, c.w - 6, true), size, true); x += c.w; }
      y -= rowH;
    };
    if (t.title) { ensure(rowH * 3); text(M, y, ascii(t.title), 11, true, brand); y -= 18; }
    ensure(rowH * 2); header();
    if (!t.rows.length) { text(M + 3, y - size + 1, ascii(t.empty || 'No records.'), size, false, [0.4, 0.4, 0.4]); y -= rowH; }
    t.rows.forEach((r, i) => {
      if (ensure(rowH)) header();
      if (i % 2) rect(M, y - rowH + 3, CW, rowH, [0.97, 0.98, 0.98]);
      let x = M;
      cols.forEach((c, j) => {
        const s = fit(r[j] ?? '', size, c.w - 6);
        const tx = c.align === 'right' ? x + c.w - 3 - width(s, size) : x + 3;
        text(tx, y - size + 1, s, size);
        x += c.w;
      });
      y -= rowH;
    });
    line(M, y + 3, M + CW, y + 3);
    y -= 10;
  }
  for (const p of opt.after || []) { for (const l of wrap(p, 10, CW)) { ensure(14); text(M, y, l, 10); y -= 14; } y -= 6; }
  pages.push(ops);

  // Footer with page numbers
  const footer = ascii(opt.footer || `Generated ${new Date().toLocaleString()} by Libre CMMS`);
  pages.forEach((p, i) => {
    p.push(`0.55 0.55 0.55 rg BT /F1 8 Tf ${M} 24 Td (${esc(fit(footer, 8, CW - 80))}) Tj ET`);
    const pn = `Page ${i + 1} of ${pages.length}`;
    p.push(`BT /F1 8 Tf ${(PW - M - width(pn, 8)).toFixed(2)} 24 Td (${pn}) Tj ET 0 0 0 rg`);
  });

  // Assemble the PDF objects.
  const objs = [];
  const add = s => { objs.push(s); return objs.length; };
  const catalog = add(null); const pagesObj = add(null);
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids = [];
  for (const p of pages) {
    const stream = p.join('\n');
    const c = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${c} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const info = add(`<< /Title (${esc(ascii(opt.title || 'Report'))}) /Producer (Libre CMMS) /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z) >>`);
  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

module.exports = { report, ascii };

// Libre CMMS - Copyright (C) 2026 CreativeMed LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// Verifies the QR generator against values published in ISO/IEC 18004 and by
// decoding generated symbols back to text with an independent reader that checks
// Reed-Solomon syndromes (a different algorithm from the encoder's division).
const test = require('node:test');
const assert = require('node:assert');
const QR = require('../public/js/qrcode.js');
const I = QR._internal;

test('data codeword capacity matches ISO/IEC 18004 Table 7', () => {
  const expected = { // version: [L, M, Q, H]
    1: [19, 16, 13, 9], 2: [34, 28, 22, 16], 3: [55, 44, 34, 26], 4: [80, 64, 48, 36], 5: [108, 86, 62, 46],
    6: [136, 108, 76, 60], 7: [156, 124, 88, 66], 10: [274, 216, 154, 122], 15: [523, 415, 295, 223],
    20: [861, 669, 485, 385], 27: [1468, 1128, 808, 628], 40: [2956, 2334, 1666, 1276],
  };
  for (const [v, caps] of Object.entries(expected)) {
    caps.forEach((c, ecl) => assert.equal(I.numDataCodewords(Number(v), ecl), c, `v${v} ecl${ecl}`));
  }
  assert.equal(Math.floor(I.numRawDataModules(1) / 8), 26);
  assert.equal(Math.floor(I.numRawDataModules(40) / 8), 3706);
});

test('alignment pattern positions match ISO/IEC 18004 Annex E', () => {
  assert.deepEqual(I.alignmentPositions(2), [6, 18]);
  assert.deepEqual(I.alignmentPositions(7), [6, 22, 38]);
  assert.deepEqual(I.alignmentPositions(14), [6, 26, 46, 66]);
  assert.deepEqual(I.alignmentPositions(32), [6, 34, 60, 86, 112, 138]);
  assert.deepEqual(I.alignmentPositions(40), [6, 30, 58, 86, 114, 142, 170]);
});

test('GF(256) arithmetic', () => {
  assert.equal(I.rsMultiply(0x80, 2), 0x1D);
  assert.equal(I.rsMultiply(0x53, 1), 0x53);
});

// Format information strings (after XOR mask) from ISO/IEC 18004 Table C.1, bit 14 first.
const FORMAT = {
  L: ['111011111000100', '111001011110011', '111110110101010', '111100010011101', '110011000101111', '110001100011000', '110110001000001', '110100101110110'],
  M: ['101010000010010', '101000100100101', '101111001111100', '101101101001011', '100010111111001', '100000011001110', '100111110010111', '100101010100000'],
};

// ---- independent reader ----
function readFormat(m) {
  // First copy: row 8 columns 0-5,7,8 then column 8 rows 7,5..0 (bit 14 first).
  const pos = [[0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [7, 8], [8, 8], [8, 7], [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0]];
  return pos.map(([x, y]) => (m[y][x] ? '1' : '0')).join('');
}
function maskFn(mask, x, y) {
  return [
    (x + y) % 2 === 0, y % 2 === 0, x % 3 === 0, (x + y) % 3 === 0, (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    ((x * y) % 2) + ((x * y) % 3) === 0, (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ][mask];
}
function functionMap(ver, size) {
  const f = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (x0, y0, w, h) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (x >= 0 && y >= 0 && x < size && y < size) f[y][x] = true; };
  mark(0, 0, 9, 9); mark(size - 8, 0, 8, 9); mark(0, size - 8, 9, 8); // finders + separators + format
  mark(6, 0, 1, size); mark(0, 6, size, 1); // timing
  const al = I.alignmentPositions(ver);
  for (const a of al) for (const b of al) {
    if ((a === 6 && b === 6) || (a === 6 && b === al[al.length - 1]) || (a === al[al.length - 1] && b === 6)) continue;
    mark(a - 2, b - 2, 5, 5);
  }
  if (ver >= 7) { mark(size - 11, 0, 3, 6); mark(0, size - 11, 6, 3); }
  return f;
}
const gfExp = (() => { const e = [1]; for (let i = 1; i < 255; i++) e.push(I.rsMultiply(e[i - 1], 2)); return e; })();
function syndromesZero(block, eccLen) {
  for (let i = 0; i < eccLen; i++) {
    let s = 0;
    for (const c of block) s = I.rsMultiply(s, gfExp[i]) ^ c; // Horner evaluation at alpha^i
    if (s !== 0) return false;
  }
  return true;
}
function decode(qr) {
  const { modules: m, size, version: ver } = qr;
  const fmt = readFormat(m);
  let ecl = null; let mask = null;
  for (const [k, list] of Object.entries(FORMAT)) { const i = list.indexOf(fmt); if (i >= 0) { ecl = k; mask = i; } }
  assert.ok(ecl, `format bits ${fmt} not in the ISO table`);
  const f = functionMap(ver, size);
  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j; const up = ((right + 1) & 2) === 0; const y = up ? size - 1 - vert : vert;
      if (!f[y][x]) bits.push(m[y][x] !== maskFn(mask, x, y) ? 1 : 0);
    }
  }
  const eclIdx = { L: 0, M: 1, Q: 2, H: 3 }[ecl];
  const nb = I.NUM_ERROR_CORRECTION_BLOCKS[eclIdx][ver]; const eccLen = I.ECC_CODEWORDS_PER_BLOCK[eclIdx][ver];
  const raw = Math.floor(I.numRawDataModules(ver) / 8);
  assert.ok(bits.length >= raw * 8, 'enough data modules');
  const cw = []; for (let i = 0; i < raw; i++) { let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | bits[i * 8 + j]; cw.push(v); }
  const shortBlocks = nb - (raw % nb); const shortLen = Math.floor(raw / nb);
  const blocks = Array.from({ length: nb }, (_, i) => ({ data: [], ecc: [], dlen: shortLen - eccLen + (i < shortBlocks ? 0 : 1) }));
  let k = 0;
  const maxD = Math.max(...blocks.map(b => b.dlen));
  for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.dlen) b.data.push(cw[k++]);
  for (let i = 0; i < eccLen; i++) for (const b of blocks) b.ecc.push(cw[k++]);
  for (const b of blocks) assert.ok(syndromesZero([...b.data, ...b.ecc], eccLen), 'Reed-Solomon syndromes must be zero');
  const data = blocks.flatMap(b => b.data);
  const db = data.flatMap(v => [7, 6, 5, 4, 3, 2, 1, 0].map(i => (v >> i) & 1));
  let p = 0; const read = n => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | db[p++]; return v; };
  assert.equal(read(4), 4, 'byte mode indicator');
  const len = read(ver < 10 ? 8 : 16);
  const bytes = []; for (let i = 0; i < len; i++) bytes.push(read(8));
  return { text: new TextDecoder().decode(new Uint8Array(bytes)), ecl, mask };
}

test('generated symbols decode back to the original text', () => {
  const samples = [
    'A', 'RGH-00001', 'https://cmms.example.org/portal?asset=RGH-00001',
    'http://localhost:8080/portal?asset=TE-0001', 'Ünïcødé tag Ω 123',
    'x'.repeat(120), 'y'.repeat(300), 'z'.repeat(1000),
  ];
  for (const ecl of ['L', 'M']) {
    for (const s of samples) {
      const qr = QR.encode(s, ecl);
      assert.equal(qr.size, qr.version * 4 + 17);
      const d = decode(qr);
      assert.equal(d.text, s, `round trip v${qr.version}-${ecl}`);
      assert.equal(d.ecl, ecl);
    }
  }
  // A typical label URL fits in a small symbol.
  assert.ok(QR.encode('https://cmms.example.org/portal?asset=RGH-00001', 'M').version <= 4);
});

test('finder patterns and timing are correct', () => {
  const { modules: m, size } = QR.encode('RGH-00001', 'M');
  const finder = ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111'];
  for (const [ox, oy] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    for (let y = 0; y < 7; y++) assert.equal(m[oy + y].slice(ox, ox + 7).map(b => (b ? 1 : 0)).join(''), finder[y]);
  }
  for (let i = 8; i < size - 8; i++) { assert.equal(m[6][i], i % 2 === 0); assert.equal(m[i][6], i % 2 === 0); }
  assert.equal(m[size - 8][8], true, 'dark module');
});

test('version information for v7+ matches ISO/IEC 18004 Annex D', () => {
  const qr = QR.encode('v'.repeat(140), 'M'); // forces version >= 7
  assert.ok(qr.version >= 7);
  const VERSION_INFO = { 7: 0x07C94, 8: 0x085BC, 9: 0x09A99, 10: 0x0A4D3 };
  if (VERSION_INFO[qr.version]) {
    let bits = 0;
    for (let i = 17; i >= 0; i--) bits = (bits << 1) | (qr.modules[Math.floor(i / 3)][qr.size - 11 + (i % 3)] ? 1 : 0);
    assert.equal(bits, VERSION_INFO[qr.version]);
  }
  assert.equal(decode(qr).text, 'v'.repeat(140));
});

test('svg output', () => {
  const s = QR.svg('RGH-00001');
  assert.match(s, /^<svg [^>]*viewBox="0 0 29 29"/); // version 1 (21) + 2*4 quiet zone
});

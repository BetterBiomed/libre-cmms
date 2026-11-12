// Libre CMMS - Copyright (C) 2026 CreativeMed LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
// Dependency-free QR Code generator (ISO/IEC 18004, byte mode, versions 1-40,
// error-correction levels L/M/Q/H, automatic mask selection). Outputs SVG.
// Works in the browser (window.LibreQR) and in Node (module.exports) for tests.
'use strict';
(function (root) {
  // Error-correction codewords per block, and number of blocks, indexed [ecl][version].
  // ecl index order: L, M, Q, H.
  const ECC_CODEWORDS_PER_BLOCK = [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  ];
  const NUM_ERROR_CORRECTION_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
  ];
  const ECL = { L: { index: 0, bits: 1 }, M: { index: 1, bits: 0 }, Q: { index: 2, bits: 3 }, H: { index: 3, bits: 2 } };

  const getBit = (x, i) => ((x >>> i) & 1) !== 0;

  function numRawDataModules(ver) {
    let result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }
  const numDataCodewords = (ver, ecl) => Math.floor(numRawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[ecl][ver] * NUM_ERROR_CORRECTION_BLOCKS[ecl][ver];

  // GF(2^8) arithmetic with the QR polynomial 0x11D.
  function rsMultiply(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z;
  }
  function rsDivisor(degree) {
    const result = new Array(degree).fill(0);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < result.length; j++) {
        result[j] = rsMultiply(result[j], root);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      root = rsMultiply(root, 0x02);
    }
    return result;
  }
  function rsRemainder(data, divisor) {
    const result = divisor.map(() => 0);
    for (const b of data) {
      const factor = b ^ result.shift();
      result.push(0);
      divisor.forEach((coef, i) => { result[i] ^= rsMultiply(coef, factor); });
    }
    return result;
  }

  function alignmentPositions(ver) {
    if (ver === 1) return [];
    const numAlign = Math.floor(ver / 7) + 2;
    const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
    const result = [6];
    for (let pos = ver * 4 + 17 - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  function utf8(text) { return Array.from(new TextEncoder().encode(String(text))); }

  function encode(text, eclName = 'M') {
    const e = ECL[eclName] || ECL.M;
    const ecl = e.index;
    const bytes = utf8(text);
    let ver;
    for (ver = 1; ver <= 40; ver++) {
      const used = 4 + (ver < 10 ? 8 : 16) + bytes.length * 8;
      if (used <= numDataCodewords(ver, ecl) * 8) break;
    }
    if (ver > 40) throw new Error('Data too long for a QR code');

    // ---- data bit stream ----
    const bb = [];
    const append = (val, len) => { for (let i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1); };
    append(0x4, 4); // byte mode
    append(bytes.length, ver < 10 ? 8 : 16);
    for (const b of bytes) append(b, 8);
    const capacity = numDataCodewords(ver, ecl) * 8;
    append(0, Math.min(4, capacity - bb.length));
    append(0, (8 - (bb.length % 8)) % 8);
    for (let pad = 0xEC; bb.length < capacity; pad ^= 0xEC ^ 0x11) append(pad, 8);
    const data = [];
    for (let i = 0; i < bb.length; i += 8) { let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | bb[i + j]; data.push(v); }

    // ---- error correction + interleaving ----
    const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecl][ver];
    const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecl][ver];
    const rawCodewords = Math.floor(numRawDataModules(ver) / 8);
    const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
    const shortBlockLen = Math.floor(rawCodewords / numBlocks);
    const divisor = rsDivisor(blockEccLen);
    const blocks = [];
    for (let i = 0, k = 0; i < numBlocks; i++) {
      const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
      k += dat.length;
      const ecc = rsRemainder(dat, divisor);
      if (i < numShortBlocks) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    const codewords = [];
    for (let i = 0; i < blocks[0].length; i++) {
      blocks.forEach((block, j) => { if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) codewords.push(block[i]); });
    }

    // ---- matrix ----
    const size = ver * 4 + 17;
    const modules = Array.from({ length: size }, () => new Array(size).fill(false));
    const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));
    const setF = (x, y, dark) => { modules[y][x] = dark; isFunction[y][x] = true; };

    for (let i = 0; i < size; i++) { setF(6, i, i % 2 === 0); setF(i, 6, i % 2 === 0); }
    const finder = (x, y) => {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx; const yy = y + dy;
        if (xx >= 0 && xx < size && yy >= 0 && yy < size) setF(xx, yy, dist !== 2 && dist !== 4);
      }
    };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    const al = alignmentPositions(ver);
    const n = al.length;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setF(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    const drawFormat = mask => {
      const d = (e.bits << 3) | mask;
      let rem = d;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const bits = ((d << 10) | rem) ^ 0x5412;
      for (let i = 0; i <= 5; i++) setF(8, i, getBit(bits, i));
      setF(8, 7, getBit(bits, 6)); setF(8, 8, getBit(bits, 7)); setF(7, 8, getBit(bits, 8));
      for (let i = 9; i < 15; i++) setF(14 - i, 8, getBit(bits, i));
      for (let i = 0; i < 8; i++) setF(size - 1 - i, 8, getBit(bits, i));
      for (let i = 8; i < 15; i++) setF(8, size - 15 + i, getBit(bits, i));
      setF(8, size - 8, true);
    };
    drawFormat(0);
    if (ver >= 7) {
      let rem = ver;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      const bits = (ver << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const bit = getBit(bits, i); const a = size - 11 + (i % 3); const b = Math.floor(i / 3);
        setF(a, b, bit); setF(b, a, bit);
      }
    }
    // Zig-zag codeword placement.
    let bitIdx = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!isFunction[y][x] && bitIdx < codewords.length * 8) {
            modules[y][x] = getBit(codewords[bitIdx >>> 3], 7 - (bitIdx & 7));
            bitIdx++;
          }
        }
      }
    }
    const applyMask = mask => {
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        let inv;
        switch (mask) {
          case 0: inv = (x + y) % 2 === 0; break;
          case 1: inv = y % 2 === 0; break;
          case 2: inv = x % 3 === 0; break;
          case 3: inv = (x + y) % 3 === 0; break;
          case 4: inv = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: inv = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: inv = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: inv = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
        }
        if (!isFunction[y][x] && inv) modules[y][x] = !modules[y][x];
      }
    };
    const penalty = () => {
      let p = 0; let dark = 0;
      for (let y = 0; y < size; y++) {
        for (let pass = 0; pass < 2; pass++) {
          let run = 1;
          for (let i = 1; i <= size; i++) {
            const same = i < size && (pass ? modules[i][y] === modules[i - 1][y] : modules[y][i] === modules[y][i - 1]);
            if (same) run++; else { if (run >= 5) p += run - 2; run = 1; }
          }
        }
        for (let x = 0; x < size; x++) {
          if (modules[y][x]) dark++;
          if (x < size - 1 && y < size - 1) {
            const c = modules[y][x];
            if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) p += 3;
          }
        }
      }
      const total = size * size;
      p += Math.ceil(Math.abs(dark * 20 - total * 10) / total - 1) * 10;
      return p;
    };
    let best = 0; let bestScore = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(m); drawFormat(m);
      const s = penalty();
      if (s < bestScore) { bestScore = s; best = m; }
      applyMask(m);
    }
    applyMask(best); drawFormat(best);
    return { version: ver, size, mask: best, ecl: eclName, modules };
  }

  function svg(text, opts = {}) {
    const qr = encode(text, opts.ecl || 'M');
    const border = opts.border ?? 4;
    const dim = qr.size + border * 2;
    let path = '';
    for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y][x]) path += `M${x + border},${y + border}h1v1h-1z`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges"><rect width="${dim}" height="${dim}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
  }

  const api = { encode, svg, _internal: { numDataCodewords, numRawDataModules, rsDivisor, rsRemainder, rsMultiply, alignmentPositions, ECC_CODEWORDS_PER_BLOCK, NUM_ERROR_CORRECTION_BLOCKS } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LibreQR = api;
})(typeof window !== 'undefined' ? window : globalThis);

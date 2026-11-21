#!/usr/bin/env node
// Libre CMMS - Copyright (C) 2026 CreativeMed LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
// Builds a self-contained DEMO copy of Libre with a fully populated demonstration
// database (fictional data), ready to run and show to people.
//
//   node scripts/build-demo.js [targetFolder=DEMO] [seed]
//
// Run from the Libre source tree to (re)create the folder, or run it inside an
// existing demo folder ("node scripts/build-demo.js .") to regenerate just the data
// with fresh, current dates.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(ROOT, process.argv[2] || 'DEMO');
const SEED = process.argv[3] || '';
const PORT = 8090;

const sameTree = path.relative(ROOT, OUT) === '';
fs.mkdirSync(OUT, { recursive: true });

if (!sameTree) {
  // Program files (the demo runs exactly this version of Libre).
  for (const item of ['server', 'public', 'scripts', 'docs', 'package.json', 'LICENSE', 'NOTICE', 'README.md']) {
    const src = path.join(ROOT, item);
    if (!fs.existsSync(src)) continue;
    fs.rmSync(path.join(OUT, item), { recursive: true, force: true });
    fs.cpSync(src, path.join(OUT, item), { recursive: true });
  }
}

// Configuration: its own port, so it can run next to a real Libre server.
fs.mkdirSync(path.join(OUT, 'config'), { recursive: true });
const cfgFile = path.join(OUT, 'config', 'libre.config.json');
if (!fs.existsSync(cfgFile)) {
  fs.writeFileSync(cfgFile, JSON.stringify({ host: '0.0.0.0', port: PORT, dataDir: 'data', sessionHours: 12, backup: { enabled: false } }, null, 2) + '\n');
}

// Fresh data.
const dataDir = path.join(OUT, 'data');
fs.rmSync(dataDir, { recursive: true, force: true });
const gen = spawnSync(process.execPath, [path.join(OUT, 'scripts', 'demo-data.js'), SEED].filter(Boolean), {
  cwd: OUT, env: { ...process.env, LIBRE_DATA_DIR: dataDir }, stdio: 'inherit',
});
if (gen.status !== 0) { console.error('Demo data generation failed.'); process.exit(gen.status || 1); }

// Launchers.
fs.writeFileSync(path.join(OUT, 'start-demo.cmd'), [
  '@echo off',
  'rem Libre CMMS DEMO - Copyright (C) 2026 CreativeMed LLC - AGPL-3.0-or-later',
  'cd /d "%~dp0"',
  'where node >nul 2>nul || (echo Node.js 24 or later is required: https://nodejs.org & pause & exit /b 1)',
  `echo Starting the Libre CMMS demo on http://localhost:${PORT}  (close this window to stop)`,
  `start "" http://localhost:${PORT}`,
  'node server\\server.js',
  'pause', '',
].join('\r\n'));
fs.writeFileSync(path.join(OUT, 'rebuild-demo.cmd'), [
  '@echo off',
  'rem Regenerates the demo database with fresh dates. All changes made in the demo are discarded.',
  'cd /d "%~dp0"',
  'echo This deletes the demo database and builds a fresh one with current dates.',
  'choice /M "Continue"',
  'if errorlevel 2 exit /b 0',
  'node scripts\\build-demo.js .',
  'pause', '',
].join('\r\n'));
fs.writeFileSync(path.join(OUT, 'start-demo.sh'), `#!/usr/bin/env sh\ncd "$(dirname "$0")" || exit 1\necho "Libre CMMS demo on http://localhost:${PORT}"\nexec node server/server.js\n`);

// Guide.
const guideSrc = path.join(ROOT, 'docs', 'DEMO-GUIDE.md');
if (fs.existsSync(guideSrc) && !sameTree) fs.copyFileSync(guideSrc, path.join(OUT, 'README-DEMO.md'));

console.log(`\nDemo ready in ${OUT}`);
console.log(`Start it with start-demo.cmd (Windows) or ./start-demo.sh, then open http://localhost:${PORT}`);
console.log('Sign in as "demo" / "LibreDemo2026" (see README-DEMO.md for all demo logins).');

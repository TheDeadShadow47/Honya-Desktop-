// Drives the REAL Electron app through the REAL LNReader repo UI flow, then restarts it on the same data dir.
// Site HTML comes from scripts/fixture-site.cjs (synthetic). Verified on Linux (uses xvfb-run when there is no DISPLAY).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { root } from './lib/bundle.mjs';
import './build-electron.mjs';

const require = createRequire(import.meta.url);
const electron = require('electron');
const fixture = await require('./fixture-site.cjs').start(0);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'honya-e2e-'));
const linuxHeadless = process.platform === 'linux' && !process.env.DISPLAY;

const run = (script) => new Promise((resolve) => {
  const env = {
    ...process.env, HONYA_SMOKE: '1', HONYA_DATA_DIR: dataDir, HONYA_SMOKE_SCRIPT: path.join(root, 'scripts', script),
    HONYA_SMOKE_OUT: path.join(dataDir, 'shots'), HONYA_TEST_HOST_MAP: `https://www.royalroad.com=http://127.0.0.1:${fixture.address().port}`,
  };
  const args = [root, ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : [])];
  const [cmd, argv] = linuxHeadless ? ['xvfb-run', ['-a', electron, ...args]] : [electron, args];
  const p = spawn(cmd, argv, { env });
  let buf = '';
  p.stdout.on('data', (d) => (buf += d));
  p.on('exit', () => resolve(buf.split('\n').find((l) => l.startsWith('SMOKE_RESULT'))?.slice(13)));
});

let failed = false;
for (const [label, script] of [['PHASE 1 (fresh data dir)', 'e2e-phase1.js'], ['PHASE 2 (restart, same data dir)', 'e2e-phase2.js']]) {
  const raw = await run(script);
  console.log(`\n### ${label}`);
  if (!raw) { console.log('no result from app'); failed = true; continue; }
  const { errors, report } = JSON.parse(raw);
  delete report.script.bodyText;
  console.log('renderer errors:', errors.length ? errors : 'none');
  console.log(JSON.stringify(report.script, null, 1));
  if (errors.length || report.script.error) failed = true;
}
fixture.close();
process.exit(failed ? 1 : 0);

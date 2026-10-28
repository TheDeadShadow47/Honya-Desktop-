// Regression tests for the automatic updater (services/appUpdater.js, renderer helpers, release configuration).
// Bundled with esbuild like the other Node tests; no network and no Electron needed.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { bundle, root } from './lib/bundle.mjs';

const out = path.join(os.tmpdir(), 'honya-app-updater-test.mjs');
await bundle({ entry: 'scripts/app-updater.entry.js', outfile: out, format: 'esm' });

// The main-process bundle must still build with electron-updater inlined (the app ships no node_modules).
const mainOut = path.join(os.tmpdir(), 'honya-main-bundle-check.cjs');
await bundle({ entry: 'electron/main.js', outfile: mainOut });
const main = fs.readFileSync(mainOut, 'utf8');
if (!/NsisUpdater/.test(main) || !/autoDownload/.test(main)) {
  console.error('FAIL: electron-updater is not bundled into the main process');
  process.exit(1);
}
console.log('ok  - main process bundle includes electron-updater (no node_modules needed at runtime)');

execFileSync(process.execPath, ['--no-warnings', out], { stdio: 'inherit', cwd: root });

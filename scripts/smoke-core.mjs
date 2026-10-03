// Node-side smoke test: SQLite adapter + vendored db module + plugin service, including persistence across a process restart.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { bundle } from './lib/bundle.mjs';

const out = path.join(os.tmpdir(), 'honya-smoke-core.mjs');
await bundle({ entry: 'scripts/smoke-core.entry.js', outfile: out, format: 'esm' });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'honya-data-'));
const env = { ...process.env, HONYA_DATA_DIR: dir };
for (const phase of ['write', 'read']) {
  console.log(`--- ${phase} (${phase === 'read' ? 'new process = restart' : 'first run'})`);
  execFileSync(process.execPath, ['--no-warnings', out, phase], { env, stdio: 'inherit' });
}
console.log('CORE SMOKE PASSED');

// Installs the REAL "boxnovel" (Madara) plugin from the REAL LNReader repo and exercises popular/search/novel/chapters
// against a local fixture site (scripts/fixture-site.cjs). Needs internet access to raw.githubusercontent.com only.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { bundle } from './lib/bundle.mjs';

const require = createRequire(import.meta.url);
const fixture = await require('./fixture-site.cjs').start(0);
const port = fixture.address().port;
const out = path.join(os.tmpdir(), 'honya-e2e-madara.mjs');
await bundle({ entry: 'scripts/e2e-madara.entry.js', outfile: out, format: 'esm' });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'honya-data-'));
const code = await new Promise((res) => {
  const c = spawn(process.execPath, ['--no-warnings', out], { stdio: 'inherit', env: { ...process.env, HONYA_DATA_DIR: dir, FIXTURE_PORT: String(port) } });
  c.on('exit', res);
});
fixture.close();
process.exit(code ?? 1);

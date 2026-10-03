// Compatibility sweep over ALL real LNReader plugin bundles:
//   1) load each through the real pluginEngine and check the 4 core methods exist,
//   2) call popular/search/novel/chapter on each with a mocked network and report missing shims/globals.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { bundle } from './lib/bundle.mjs';
import { downloadAll } from './download-plugins.mjs';

const dir = await downloadAll();
for (const name of ['audit-plugins', 'sweep-plugins']) {
  const out = path.join(os.tmpdir(), `honya-${name}.mjs`);
  await bundle({ entry: `scripts/${name}.entry.js`, outfile: out, format: 'esm' });
  console.log(`\n=== ${name}`);
  execFileSync(process.execPath, ['--no-warnings', out, dir], { stdio: 'inherit' });
}

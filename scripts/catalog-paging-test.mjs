// Node-side unit test for the source-browser pagination rules. Bundled with esbuild like the other Node tests.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { bundle } from './lib/bundle.mjs';

const out = path.join(os.tmpdir(), 'honya-catalog-paging.mjs');
await bundle({ entry: 'scripts/catalog-paging.entry.js', outfile: out, format: 'esm' });
execFileSync(process.execPath, ['--no-warnings', out], { stdio: 'inherit' });

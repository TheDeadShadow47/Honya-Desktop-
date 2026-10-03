// Node-side unit test for the continuous-reader rules. Bundled with esbuild like the other Node tests.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { bundle } from './lib/bundle.mjs';

const out = path.join(os.tmpdir(), 'honya-reader-logic.mjs');
await bundle({ entry: 'scripts/reader-logic.entry.js', outfile: out, format: 'esm' });
execFileSync(process.execPath, ['--no-warnings', out], { stdio: 'inherit' });

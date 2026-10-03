// Bundles the Electron main process + preload to CommonJS in dist-electron/.
import path from 'node:path';
import { bundle, root } from './lib/bundle.mjs';

await bundle({ entry: 'electron/main.js', outfile: path.join(root, 'dist-electron', 'main.cjs') });
await bundle({ entry: 'electron/preload.js', outfile: path.join(root, 'dist-electron', 'preload.cjs') });
console.log('electron main + preload built');

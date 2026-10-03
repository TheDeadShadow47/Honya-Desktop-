// Shared esbuild helper for the main process and Node-side test scripts.
// `expo-sqlite` (imported by the vendored core/db/database.js) is redirected to shims/expo-sqlite.js with a resolver
// plugin rather than an alias, so it behaves identically on Windows, macOS and Linux.
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const expoSqliteShim = {
  name: 'expo-sqlite-shim',
  setup(b) {
    b.onResolve({ filter: /^expo-sqlite$/ }, () => ({ path: path.join(root, 'shims', 'expo-sqlite.js') }));
  },
};

export function bundle({ entry, outfile, format = 'cjs', extra = {} }) {
  return build({
    entryPoints: [path.isAbsolute(entry) ? entry : path.join(root, entry)],
    outfile,
    bundle: true,
    platform: 'node',
    format,
    target: 'node22',
    sourcemap: format === 'cjs',
    external: ['electron', 'node:sqlite'],
    plugins: [expoSqliteShim],
    // ESM bundles need a require() for CommonJS deps (plugin bundles are eval'd with their own require shim).
    banner: format === 'esm' ? { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } : undefined,
    logLevel: 'warning',
    ...extra,
  });
}

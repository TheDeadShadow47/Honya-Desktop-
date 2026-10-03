import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

// Standalone renderer build: every import resolves inside this project (core/ holds the vendored Honya logic).
export default defineConfig({
  root,
  base: './',
  plugins: [react()],
  define: { __DEV__: 'false' },
  resolve: {
    alias: [
      { find: /^@core\//, replacement: path.resolve(root, 'core') + '/' },
      { find: /^@assets\//, replacement: path.resolve(root, 'assets') + '/' },
      // core/i18n/i18n.js (vendored from mobile) only needs Platform from react-native.
      { find: /^react-native$/, replacement: path.resolve(root, 'src/shims/react-native.js') },
    ],
  },
  build: { outDir: 'dist', emptyOutDir: true },
});

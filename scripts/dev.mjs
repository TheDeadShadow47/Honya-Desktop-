// Dev workflow: Vite dev server for the renderer + Electron pointed at it.
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import './build-electron.mjs';

const require = createRequire(import.meta.url);
const server = await createServer({ server: { port: 5173, strictPort: true } });
await server.listen();
const url = server.resolvedUrls.local[0].replace(/\/$/, '');
const child = spawn(require('electron'), ['.'], { stdio: 'inherit', env: { ...process.env, HONYA_DEV_URL: url } });
child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});

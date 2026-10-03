// End-to-end test of the continuous reader in the REAL Electron app (xvfb on Linux), across real app restarts, with a
// fake Discord server so presence updates can be asserted too. Offline-capable: uses a synthetic plugin, no internet.
// Run: npm run test:reader   (builds first)
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { root } from './lib/bundle.mjs';

const require = createRequire(import.meta.url);
const electron = require('electron');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'honya-e2e-reader-'));
const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'honya-xdg-'));
const linuxHeadless = process.platform === 'linux' && !process.env.DISPLAY;

// --- minimal fake Discord IPC server (same wire format the integration speaks) ---
const frame = (op, obj) => { const b = Buffer.from(JSON.stringify(obj)); const h = Buffer.alloc(8); h.writeInt32LE(op, 0); h.writeInt32LE(b.length, 4); return Buffer.concat([h, b]); };
const activities = [];
const sockets = new Set();
const server = net.createServer((s) => {
  sockets.add(s); s.on('close', () => sockets.delete(s)); s.on('error', () => {});
  let buf = Buffer.alloc(0);
  s.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 8) {
      const op = buf.readInt32LE(0), len = buf.readInt32LE(4);
      if (buf.length < 8 + len) return;
      const msg = JSON.parse(buf.subarray(8, 8 + len).toString() || '{}');
      buf = buf.subarray(8 + len);
      if (op === 0) s.write(frame(1, { cmd: 'DISPATCH', evt: 'READY', data: { v: 1 } }));
      else if (op === 1 && msg.cmd === 'SET_ACTIVITY') { activities.push(msg.args.activity ?? null); s.write(frame(1, { cmd: 'SET_ACTIVITY', evt: null, data: {}, nonce: msg.nonce })); }
    }
  });
});
await new Promise((r) => server.listen(path.join(runtimeDir, 'discord-ipc-0'), r));

const body = fs.readFileSync(path.join(root, 'scripts', 'e2e-reader.js'), 'utf8');
const run = (phase) => new Promise((resolve) => {
  const script = path.join(dataDir, `phase-${phase}.js`);
  fs.writeFileSync(script, `const PHASE = ${JSON.stringify(phase)};\n${body}`);
  const env = {
    ...process.env, HONYA_SMOKE: '1', HONYA_DATA_DIR: dataDir, HONYA_SMOKE_SCRIPT: script, HONYA_SMOKE_OUT: path.join(dataDir, 'shots-' + phase),
    XDG_RUNTIME_DIR: runtimeDir, HONYA_DISCORD_CLIENT_ID: '123456789012345678',
  };
  const args = [root, ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : [])];
  const [cmd, argv] = linuxHeadless ? ['xvfb-run', ['-a', electron, ...args]] : [electron, args];
  const p = spawn(cmd, argv, { env });
  let buf = '';
  p.stdout.on('data', (d) => (buf += d));
  p.on('exit', () => resolve(buf.split('\n').find((l) => l.startsWith('SMOKE_RESULT'))?.slice(13)));
});

let failed = 0, total = 0;
const report = (name, ok, detail = '') => { total += 1; if (!ok) failed += 1; console.log(`${ok ? 'ok  ' : 'FAIL'} - ${name}${detail && !ok ? `   [${detail}]` : ''}`); };

for (const phase of ['seed', 'a', 'b', 'c']) {
  const raw = await run(phase);
  console.log(`\n### phase ${phase}`);
  if (!raw) { report(`phase ${phase} produced a result`, false); continue; }
  const { errors, report: rep } = JSON.parse(raw);
  const s = rep.script ?? {};
  report(`phase ${phase}: no renderer errors`, !errors.length, errors.join('; '));
  report(`phase ${phase}: script completed`, !s.error, `${s.error} @ ${s.hash}`);
  for (const c of s.checks ?? []) report(c.name, c.ok, c.detail);
  if (s.heap) console.log(`   (renderer JS heap after reading 12 chapters: ${s.heap})`);
  if (phase === 'a') {
    // Discord: presence followed the reader across the chapter boundary, same session timer, no leaked paths.
    const reading = activities.filter((a) => a?.details === 'Reading Offline Saga');
    const states = reading.map((a) => a.state);
    report('Discord: presence shows the novel and chapter 1', states.includes('Offline Chapter 1'), JSON.stringify(states));
    report('Discord: presence moved to chapter 2 when the reader crossed into it', states.includes('Offline Chapter 2'), JSON.stringify(states));
    report('Discord: chapter change kept the same session start time (no timer reset)', new Set(reading.map((a) => a.timestamps?.start)).size === 1);
    const all = activities.filter(Boolean).map((a) => a.details);
    const seq = (...want) => { let i = -1; return want.every((w) => (i = all.indexOf(w, i + 1)) !== -1); };
    report('Discord: browsing the library is shown', all.includes('Browsing the library'), JSON.stringify(all));
    report('Discord: novel page shows "Viewing <title>"', all.includes('Viewing Offline Saga'), JSON.stringify(all));
    report('Discord: browsing a source is shown', all.includes('Browsing a source'), JSON.stringify(all));
    report('Discord: searching is shown (without the search text)', all.includes('Searching for a novel') && !JSON.stringify(activities).includes('dragon'), JSON.stringify(all));
    report('Discord: order is reading -> library -> novel -> source -> search -> library (a screen visible <1s is coalesced, not published)', seq('Reading Offline Saga', 'Browsing the library', 'Viewing Offline Saga', 'Browsing a source', 'Searching for a novel', 'Browsing the library'), JSON.stringify(all));
    report('Discord: only title + chapter label are sent (no ids/paths)', activities.every((a) => !a || !/synth::|\/off\d|http/i.test(JSON.stringify(a))));
  }
}
for (const x of sockets) x.destroy();
server.close();
console.log(`\n${total - failed}/${total} checks passed`);
process.exit(failed ? 1 : 0);

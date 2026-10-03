// Runs all 4 core API methods of every real bundle with a mocked network and classifies failures.
// Mock responses are generic (empty-ish HTML/JSON): this finds missing shims/globals, not site-specific parse bugs.
import fs from 'node:fs';
import { loadPlugin, pluginApi } from '../core/plugins/pluginEngine.js';

const dir = process.argv[2];
const hits = new Map();
globalThis.fetch = async (url) => {
  hits.set('n', (hits.get('n') ?? 0) + 1);
  const body = '<html><head><title>t</title></head><body><div></div></body></html>';
  const res = new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
  // A real fetch exposes the final URL; plugins (madara) call getHostname(res.url).
  Object.defineProperty(res, 'url', { value: String(url) });
  return res;
};

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('TIMEOUT')), ms))]);
const SHIM_GAP = /ReferenceError|is not defined|is not a function|unsupported module|not supported|UnsupportedFeature|Cannot read properties of undefined \(reading '(?:get|set|storage)/i;
const summary = { plugins: 0, loadFail: [], shimGaps: [], parseMiss: {}, ok: 0, timeouts: [] };

for (const f of fs.readdirSync(dir).sort()) {
  const id = f.replace(/\.js$/, '');
  let inst;
  try { inst = loadPlugin({ id, version: '0', code: fs.readFileSync(`${dir}/${f}`, 'utf8') }); } catch (e) { summary.loadFail.push(`${id}: ${e.message}`); continue; }
  summary.plugins++;
  let clean = true;
  for (const [m, args] of [['popular', [1]], ['search', ['a', 1]], ['novel', ['/novel/x']], ['chapter', ['/novel/x/c1']]]) {
    try { await withTimeout(pluginApi[m](inst, ...args), 8000); }
    catch (e) {
      const msg = `${e?.name}: ${String(e?.message).slice(0, 110)}`;
      if (e.message === 'TIMEOUT') { summary.timeouts.push(`${id}.${m}`); clean = false; }
      else if (SHIM_GAP.test(msg)) { summary.shimGaps.push(`${id}.${m} -> ${msg}`); clean = false; }
      else { (summary.parseMiss[msg] ??= []).push(`${id}.${m}`); }
    }
  }
  if (clean) summary.ok++;
}
const top = Object.entries(summary.parseMiss).sort((a, b) => b[1].length - a[1].length).slice(0, 12).map(([k, v]) => `${v.length}x ${k}  e.g. ${v[0]}`);
console.log(JSON.stringify({ plugins: summary.plugins, loadFail: summary.loadFail, withoutShimGapOrTimeout: summary.ok, shimGaps: summary.shimGaps, timeouts: summary.timeouts, topOtherErrors: top, fetches: hits.get('n') }, null, 1));
process.exit(0);

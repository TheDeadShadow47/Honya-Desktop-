// Loads every downloaded real bundle through the REAL pluginEngine and reports shape/compat problems.
import fs from 'node:fs';
import { loadPlugin } from '../core/plugins/pluginEngine.js';
const dir = process.argv[2];
const res = { ok: 0, loadFail: [], missing: {}, extra: {} };
for (const f of fs.readdirSync(dir)) {
  const id = f.replace(/\.js$/, '');
  try {
    const p = loadPlugin({ id, version: '0', code: fs.readFileSync(`${dir}/${f}`, 'utf8') });
    res.ok++;
    for (const m of ['popularNovels', 'searchNovels', 'parseNovel', 'parseChapter'])
      if (typeof p[m] !== 'function') (res.missing[m] ??= []).push(id);
    for (const k of ['filters', 'pluginSettings', 'resolveUrl', 'imageRequestInit', 'webStorageUtilized', 'customJS', 'customCSS'])
      if (p[k] !== undefined) (res.extra[k] ??= []).push(id);
  } catch (e) { res.loadFail.push(`${id}: ${e.message}`); }
}
console.log(JSON.stringify({ ok: res.ok, loadFail: res.loadFail, missing: res.missing, extra: Object.fromEntries(Object.entries(res.extra).map(([k, v]) => [k, v.length])) }, null, 1));

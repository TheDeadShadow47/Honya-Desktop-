// Downloads every plugin bundle listed in the real LNReader repository into .cache/plugin-bundles/.
import fs from 'node:fs';
import path from 'node:path';
import { root } from './lib/bundle.mjs';

export const REPO = 'https://raw.githubusercontent.com/LNReader/lnreader-plugins/plugins/v3.0.0/.dist/plugins.min.json';
export const CACHE = path.join(root, '.cache', 'plugin-bundles');

export async function downloadAll() {
  fs.mkdirSync(CACHE, { recursive: true });
  const list = await (await fetch(REPO)).json();
  let i = 0, failed = 0;
  const worker = async () => {
    while (i < list.length) {
      const p = list[i++];
      const file = path.join(CACHE, `${p.id}.js`);
      if (fs.existsSync(file)) continue;
      try {
        const r = await fetch(p.url);
        if (!r.ok) throw new Error(String(r.status));
        fs.writeFileSync(file, await r.text());
      } catch (e) { failed++; console.warn('download failed:', p.id, e.message); }
    }
  };
  await Promise.all(Array.from({ length: 10 }, worker));
  console.log(`bundles: ${list.length - failed}/${list.length} in ${CACHE}`);
  return CACHE;
}
if (import.meta.url === new URL(process.argv[1], 'file://').href || process.argv[1]?.endsWith('download-plugins.mjs')) await downloadAll();

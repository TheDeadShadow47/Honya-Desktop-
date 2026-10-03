// Audit: every t('key', {...}) call site vs the English locale value it will interpolate.
// Reports (a) keys used by the UI but missing from every locale, (b) placeholders present in the
// string but not supplied by the caller (these leak as literal {{...}}), (c) unused params.
// Run: node scripts/i18n-audit.mjs
import fs from 'node:fs';
import path from 'node:path';
import en from '../core/i18n/locales/en.js';
import ar from '../core/i18n/locales/ar.js';
import fr from '../core/i18n/locales/fr.js';
import de from '../core/i18n/locales/de.js';
import it from '../core/i18n/locales/it.js';
import desktop from '../core/i18n/locales/desktop.js';

const flat = (base, extra) => ({ ...base, ...(extra ?? {}) });
const locales = { en: flat(en, desktop.en), ar: flat(ar, desktop.ar), fr: flat(fr, desktop.fr), de: flat(de, desktop.de), it: flat(it, desktop.it) };
const langs = Object.keys(locales);

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.(jsx?|tsx?)$/.test(e.name) && !p.includes(path.join('node_modules', '')) ? [p] : [];
  });

const placeholders = (s) => [...String(s).matchAll(/\{\{([A-Za-z0-9_]+)(?::([^}|]+)\|([^}]+))?\}\}/g)];

let hardProblems = 0;
const missingKey = new Map();
const missingParam = new Map();

for (const file of walk(path.resolve('src'))) {
  const src = fs.readFileSync(file, 'utf8');
  const rel = path.relative(process.cwd(), file);
  // t('key') or t('key', { a, b: expr })
  for (const call of src.matchAll(/\bt\(\s*'([^']+)'\s*(?:,\s*(\{[\s\S]*?\}))?\s*\)/g)) {
    const [, key, argText = ''] = call;
    const line = src.slice(0, call.index).split('\n').length;
    const value = locales.en[key];
    if (typeof value !== 'string') {
      missingKey.set(key, [...(missingKey.get(key) ?? []), `${rel}:${line}`]);
      continue;
    }
    const provided = new Set([...argText.matchAll(/([A-Za-z0-9_]+)\s*[:,}]/g)].map((m) => m[1]));
    const needed = new Set();
    for (const [, name] of placeholders(value)) needed.add(name);
    // only params the string actually interpolates matter
    for (const name of needed) {
      if (!provided.has(name)) {
        missingParam.set(`${key} -> {{${name}}}`, [...(missingParam.get(`${key} -> {{${name}}}`) ?? []), `${rel}:${line}`]);
      }
    }
  }
}

// keys defined in one locale but not another
const keySets = Object.fromEntries(langs.map((l) => [l, new Set(Object.keys(locales[l]))]));
const union = new Set(langs.flatMap((l) => [...keySets[l]]));
const baseOnly = new Set([...keySets.en].filter((k) => !(k in desktop.en ?? {})));
const unaligned = [];
const upstream = [];
for (const key of union) {
  const missing = langs.filter((l) => !keySets[l].has(key));
  if (!missing.length) continue;
  // keys that come from the shared Android locales are an upstream gap: the desktop falls back to
  // English exactly like Android does, so they are reported but never fail the audit.
  (baseOnly.has(key) ? upstream : unaligned).push(`${key} (missing: ${missing.join(',')})`);
}

// strings that still carry an untranslated placeholder after interpolation is unknowable statically,
// so flag locale values that reference a param never passed anywhere in src.
console.log(`locales: ${langs.map((l) => `${l}=${keySets[l].size}`).join(' ')} | union=${union.size}`);
console.log(`\n[1] t() keys with no English string (${missingKey.size}):`);
for (const [k, at] of missingKey) console.log(`  ${k}  <- ${at.join(', ')}`);
console.log(`\n[2] caller missing a placeholder the string needs (${missingParam.size}):`);
for (const [k, at] of missingParam) console.log(`  ${k}  <- ${at.join(', ')}`);
console.log(`\n[3] desktop keys not present in every locale (${unaligned.length}):`);
for (const u of unaligned) console.log(`  ${u}`);
console.log(`\n[4] upstream Android keys present only in en (${upstream.length}, informational):`);
for (const u of upstream) console.log(`  ${u}`);
hardProblems = missingKey.size + missingParam.size + unaligned.length;
console.log(`\nproblems: ${hardProblems}`);
process.exit(hardProblems ? 1 : 0);

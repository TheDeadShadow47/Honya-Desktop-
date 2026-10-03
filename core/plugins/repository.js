/** Fetches and normalises plugin metadata from arbitrary user-supplied repos. */
const joinUrl = (repoUrl, relative) => {
  if (!relative) return null;
  if (/^https?:\/\//i.test(relative)) return relative;
  const base = repoUrl.slice(0, repoUrl.lastIndexOf('/') + 1);
  return base + relative.replace(/^\.?\//, '');
};

export function normalizePlugin(raw, repoUrl) {
  const id = String(raw.id ?? raw.name ?? Math.random().toString(36).slice(2));
  return {
    id,
    name: raw.name ?? id,
    version: String(raw.version ?? '0.0.0'),
    lang: raw.lang ?? raw.language ?? 'unknown',
    iconUrl: joinUrl(repoUrl, raw.iconUrl ?? raw.icon),
    site: raw.site ?? raw.url ?? null,
    codeUrl: joinUrl(repoUrl, raw.url ?? raw.pluginUrl ?? raw.code ?? `${id}.js`),
    repoUrl,
  };
}

export async function fetchRepository(repoUrl) {
  const res = await fetch(repoUrl, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Repository responded ${res.status}`);
  const json = await res.json();
  const list = Array.isArray(json) ? json : (json.plugins ?? json.sources ?? []);
  if (!Array.isArray(list)) throw new Error('Unexpected repository format');
  return list.map((raw) => normalizePlugin(raw, repoUrl));
}

export async function fetchPluginCode(codeUrl) {
  const res = await fetch(codeUrl);
  if (!res.ok) throw new Error(`Plugin bundle responded ${res.status}`);
  const code = await res.text();
  if (!code.trim()) throw new Error('Plugin bundle is empty');
  return code;
}

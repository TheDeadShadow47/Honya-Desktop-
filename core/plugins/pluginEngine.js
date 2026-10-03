// Restricted scope mirrors LNETReader's plugin helpers so published bundles run unmodified.
import * as cheerio from 'cheerio/slim';
import * as htmlparser2 from 'htmlparser2';
import dayjs from 'dayjs';

const cache = new Map();

/** Matches src/types/constants.ts (plugins repo) and src/plugins/types/index.ts (LNReader). */
const NovelStatus = {
  Unknown: 'Unknown',
  Ongoing: 'Ongoing',
  Completed: 'Completed',
  Licensed: 'Licensed',
  PublishingFinished: 'Publishing Finished',
  Cancelled: 'Cancelled',
  OnHiatus: 'On Hiatus',
  STUB: 'STUB',
  Inactive: 'Inactive',
};

/** Matches FilterTypes in src/types/filters.ts. Note ExcludableCheckboxGroup is 'XCheckbox'. */
const FilterTypes = {
  Text: 'Text',
  Picker: 'Picker',
  Checkbox: 'Checkbox',
  Switch: 'Switch',
  ExcludableCheckboxGroup: 'XCheckbox',
};

/** Matches the deprecated defaultCover LNReader injects for @libs/defaultCover. */
const defaultCover =
  'https://github.com/LNReader/lnreader-plugins/blob/master/public/static/coverNotAvailable.webp?raw=true';

/** Persists in-memory per plugin, mirroring LNReader's storage API. */
class PluginStorage {
  constructor(pluginId) {
    this.prefix = `${pluginId}::db::`;
    this.db = new Map();
  }
  set(key, value, expires) {
    this.db.set(this.prefix + key, {
      created: new Date(),
      value,
      expires: expires instanceof Date ? expires.getTime() : expires,
    });
  }
  get(key, raw) {
    const item = this.db.get(this.prefix + key);
    if (item === undefined) return undefined;
    if (item.expires && Date.now() > item.expires) {
      this.delete(key);
      return undefined;
    }
    return raw ? item : item.value;
  }
  delete(key) {
    this.db.delete(this.prefix + key);
  }
  clearAll() {
    for (const key of this.getAllKeys()) this.delete(key);
  }
  getAllKeys() {
    return [...this.db.keys()].filter((k) => k.startsWith(this.prefix)).map((k) => k.slice(this.prefix.length));
  }
}

class PluginLocalStorage {
  constructor(pluginId) {
    this.prefix = `${pluginId}::localStorage`;
    this.db = new Map();
  }
  get() {
    return this.db.get(this.prefix);
  }
}

class PluginSessionStorage {
  constructor(pluginId) {
    this.prefix = `${pluginId}::sessionStorage`;
    this.db = new Map();
  }
  get() {
    return this.db.get(this.prefix);
  }
}

// Android user agent is required by most of these sites.
const USER_AGENT = 'Mozilla/5.0 (Android 14; Mobile) LNReader/3.0.0';

const makeInit = (init) => {
  const defaultHeaders = {
    Connection: 'keep-alive',
    Accept: '*/*',
    'Accept-Language': '*',
    'Sec-Fetch-Mode': 'cors',
    'Accept-Encoding': 'gzip, deflate',
    'Cache-Control': 'max-age=0',
    'User-Agent': USER_AGENT,
  };
  if (init?.headers) {
    if (typeof Headers !== 'undefined' && init.headers instanceof Headers) {
      if (!init.headers.get('User-Agent') && defaultHeaders['User-Agent']) {
        init.headers.set('User-Agent', defaultHeaders['User-Agent']);
      }
    } else {
      init.headers = { ...defaultHeaders, ...init.headers };
    }
  } else {
    init = { ...init, headers: defaultHeaders };
  }
  return init;
};

const fetchApi = async (url, init) => fetch(url, makeInit(init));

const fetchText = async (url, init, encoding) => {
  try {
    const res = await fetch(url, makeInit(init));
    if (!res.ok) throw new Error();
    const buf = await res.arrayBuffer();
    if (encoding && typeof TextDecoder !== 'undefined' && TextDecoder) {
      try {
        return new TextDecoder(encoding).decode(buf);
      } catch {
      }
    }
    return new TextDecoder('utf-8').decode(buf);
  } catch {
    return '';
  }
};

const unsupported = (name) => {
  const error = new Error(
    `This source uses ${name}, which this app does not support yet. See LNReader's helper modules for reference.`,
  );
  error.name = 'UnsupportedFeatureError';
  throw error;
};

const fetchProto = async () => unsupported('fetchProto (protobuf requests)');

/** AES-GCM (from @noble/ciphers in LNReader). Not bundled here. */
const gcm = () => unsupported('gcm (AES encryption)');

/** Matches src/plugins/helpers/isAbsoluteUrl.ts. */
const isUrlAbsolute = (url) => {
  if (url) {
    if (url.indexOf('//') === 0) return true;
    if (url.indexOf('://') === -1) return false;
    if (url.indexOf('.') === -1) return false;
    if (url.indexOf('/') === -1) return false;
    if (url.indexOf(':') > url.indexOf('/')) return false;
    if (url.indexOf('://') < url.indexOf('.')) return true;
  }
  return false;
};

/** The fixed table of modules plugin code may require(). */
const REQUIRE_TABLE = {
  cheerio: () => cheerio,
  htmlparser2: () => htmlparser2,
  dayjs: () => dayjs,
  '@libs/fetch': () => ({ fetchApi, fetchText, fetchProto }),
  '@libs/novelStatus': () => ({ NovelStatus }),
  '@libs/defaultCover': () => ({ defaultCover }),
  '@libs/storage': (pluginId) => ({
    storage: new PluginStorage(pluginId),
    localStorage: new PluginLocalStorage(pluginId),
    sessionStorage: new PluginSessionStorage(pluginId),
  }),
  '@libs/filterInputs': () => ({ FilterTypes }),
  '@libs/isAbsoluteUrl': () => ({ isUrlAbsolute }),
  '@libs/aes': () => ({ gcm }),
  // Plugin repo tsconfig maps both `@/` and `@libs/` to src/, so bundles may use either spelling.
  '@/libs/fetch': () => ({ fetchApi, fetchText, fetchProto }),
  '@/libs/novelStatus': () => ({ NovelStatus }),
  '@/libs/defaultCover': () => ({ defaultCover }),
  '@/libs/storage': (pluginId) => ({
    storage: new PluginStorage(pluginId),
    localStorage: new PluginLocalStorage(pluginId),
    sessionStorage: new PluginSessionStorage(pluginId),
  }),
  '@/libs/filterInputs': () => ({ FilterTypes }),
  '@/libs/isAbsoluteUrl': () => ({ isUrlAbsolute }),
  '@/libs/aes': () => ({ gcm }),
  '@/types/constants': () => ({ NovelStatus, defaultCover }),
};

function makeRequire(pluginId) {
  return (name) => {
    const resolve = REQUIRE_TABLE[name];
    if (!resolve) {
      throw new Error(`This source uses an unsupported module ("${name}") and can't run in this app yet.`);
    }
    return resolve(pluginId);
  };
}

const ALLOWED_GLOBALS = () => ({
  fetch: fetchApi,
  URL,
  URLSearchParams,
  TextDecoder: typeof TextDecoder !== 'undefined' ? TextDecoder : undefined,
  encodeURIComponent,
  decodeURIComponent,
  JSON,
  Math,
  Date,
  Number,
  String,
  Boolean,
  Array,
  Object,
  RegExp,
  Promise,
  Error,
  isNaN,
  parseInt,
  parseFloat,
  console: { log: () => {}, warn: () => {}, error: () => {} },
});

/** Restricts ambient globals; require() resolves to the shimmed table above. */
function evaluatePlugin(code, pluginId) {
  const scope = ALLOWED_GLOBALS();
  scope.require = makeRequire(pluginId);
  const names = Object.keys(scope);
  const shadow = ['process', 'global', 'globalThis', 'window', 'document', '__DEV__'];
  const factory = new Function(
    ...names,
    ...shadow,
    `"use strict";
     const module = { exports: {} };
     const exports = module.exports;
     ${code}
     ;return (typeof plugin !== 'undefined' && plugin)
        || module.exports.default
        || module.exports.plugin
        || module.exports;`,
  );
  const instance = factory(...names.map((n) => scope[n]), ...shadow.map(() => undefined));
  if (!instance || typeof instance !== 'object') {
    throw new Error(`Plugin "${pluginId}" did not export a usable object.`);
  }
  return instance;
}

export function loadPlugin(record) {
  const cacheKey = `${record.id}@${record.version}`;
  if (!cache.has(cacheKey)) cache.set(cacheKey, evaluatePlugin(record.code, record.id));
  return cache.get(cacheKey);
}

export function unloadPlugin(pluginId) {
  [...cache.keys()].filter((k) => k.startsWith(`${pluginId}@`)).forEach((k) => cache.delete(k));
}

const call = async (instance, candidates, args, fallback) => {
  for (const name of candidates) {
    if (typeof instance[name] === 'function') return instance[name](...args);
  }
  if (fallback !== undefined) return fallback;
  throw new Error(`Plugin is missing one of: ${candidates.join(', ')}`);
};

export const pluginApi = {
  popular: (p, page = 1) =>
    call(p, ['popularNovels', 'fetchPopular', 'getPopular'], [page, { showLatestNovels: false, filters: p.filters ?? {} }], []),
  latest: (p, page = 1) =>
    call(p, ['latestNovels', 'popularNovels', 'fetchLatest'], [page, { showLatestNovels: true, filters: p.filters ?? {} }], []),
  search: (p, query, page = 1) => call(p, ['searchNovels', 'fetchSearch', 'searchNovel'], [query, page], []),
  novel: (p, path) => call(p, ['parseNovel', 'fetchNovel', 'parseNovelAndChapters'], [path]),
  chapter: (p, path) => call(p, ['parseChapter', 'fetchChapter'], [path], ''),
};

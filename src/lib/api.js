// Typed-ish wrapper over the preload bridge. All native work happens in the Electron main process.
const bridge = () => {
  if (!window.honya) throw new Error('Honya bridge unavailable (not running inside Electron)');
  return window.honya;
};
const invoke = (channel, ...args) => bridge().invoke(channel, ...args);

export const db = new Proxy({}, { get: (_t, name) => (...args) => invoke(`db:${String(name)}`, ...args) });
export const plugins = new Proxy({}, { get: (_t, name) => (...args) => invoke(`plugins:${String(name)}`, ...args) });
export const downloads = new Proxy({}, { get: (_t, name) => (...args) => invoke(`downloads:${String(name)}`, ...args) });
export const updates = new Proxy({}, { get: (_t, name) => (...args) => invoke(`updates:${String(name)}`, ...args) });
export const session = new Proxy({}, { get: (_t, name) => (...args) => invoke(`session:${String(name)}`, ...args) });
// Honya Desktop's own updater (main process). Not to be confused with `updates`, the library chapter refresh.
export const appUpdate = {
  getState: () => invoke('appUpdate:getState'),
  check: () => invoke('appUpdate:check'),
  download: () => invoke('appUpdate:download'),
  install: () => invoke('appUpdate:install'),
  openReleases: () => invoke('appUpdate:openReleases'),
  openDownload: () => invoke('appUpdate:openDownload'),
  onState: (fn) => (window.honya?.onAppUpdateState ? window.honya.onAppUpdateState(fn) : () => {}),
};
export const prefs = { invalidate: () => invoke('prefs:invalidate') };
export const discord = { status: () => invoke('discord:status') };
export const search = {
  global: (query, opts) => invoke('search:global', query, opts),
};
export const app = {
  info: () => invoke('app:info'),
  importBackup: () => invoke('app:importBackup'),
  exportBackup: () => invoke('app:exportBackup'),
  storageStats: () => invoke('app:storageStats'),
  openExternal: (url) => invoke('app:openExternal', url),
};

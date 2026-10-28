// Pure helpers for the app-update UI (no React, no Electron) so they can be unit-tested in Node.

export const ERROR_KEYS = Object.freeze({
  offline: 'appUpdate.err.offline',
  'rate-limited': 'appUpdate.err.rateLimited',
  'no-release': 'appUpdate.err.noRelease',
  'missing-assets': 'appUpdate.err.missingAssets',
  checksum: 'appUpdate.err.checksum',
  signature: 'appUpdate.err.signature',
  server: 'appUpdate.err.server',
  config: 'appUpdate.err.config',
  'bad-response': 'appUpdate.err.badResponse',
  unknown: 'appUpdate.err.unknown',
});

export const errorKey = (code) => ERROR_KEYS[code] ?? ERROR_KEYS.unknown;

/**
 * Should the unobtrusive "update available" notice be shown? Once per version per session, never for a version the user
 * chose "Later" for (persisted as postponedUpdateVersion), and a newer version always notifies again.
 */
export function shouldNotify(state, { postponedVersion = '', dismissed = [] } = {}) {
  if (!state?.version) return false;
  if (dismissed.includes(state.version)) return false;
  if (state.status === 'ready') return true; // a finished download keeps its install notice for the session
  if (state.status === 'available') return state.version !== postponedVersion;
  return false;
}

/** One-line status as { key, params, tone } for t(key, params). */
export function statusView(state) {
  if (!state) return { key: 'update.checking', params: {}, tone: 'muted' };
  const version = state.version ?? '';
  switch (state.status) {
    case 'disabled':
      return { key: 'appUpdate.disabledDev', params: {}, tone: 'muted' };
    case 'checking':
      return { key: 'update.checking', params: {}, tone: 'muted' };
    case 'up-to-date':
      return { key: 'update.upToDateBody', params: { version: state.currentVersion }, tone: 'ok' };
    case 'available':
      if (state.missingAsset) return { key: 'appUpdate.missingAsset', params: { version }, tone: 'warn' };
      return { key: 'update.available', params: { version }, tone: 'accent' };
    case 'downloading':
      return { key: 'update.downloadingVersion', params: { version }, tone: 'accent' };
    case 'ready':
      return { key: 'update.updateReadyBody', params: { version }, tone: 'ok' };
    case 'error':
      return { key: errorKey(state.error?.code), params: {}, tone: 'error' };
    default:
      return { key: 'update.currentVersion', params: { version: state.currentVersion }, tone: 'muted' };
  }
}

export const formatBytes = (n) => {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(0)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
};

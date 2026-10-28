// Honya Desktop self-update logic (main process only).
//
// Two update paths, chosen from how the app was installed (see detectDistribution):
//   - "auto"   (NSIS installer): electron-updater + GitHub Releases (latest.yml, sha512-verified download, install on
//              the user's explicit request).
//   - "manual" (portable build, or anything without an update config): the GitHub Releases API is only used to DETECT a
//              newer stable release and show its notes; the user downloads the new file themselves. A running portable
//              executable is never replaced by the app.
//   - "disabled" (development / test runs): nothing is checked and the UI says why.
//
// This file has no Electron imports: everything platform specific (fetch, electron-updater, opening links, timers) is
// injected, so every path is unit-tested in Node (scripts/app-updater.entry.js).

export const UPDATE_STATUS = Object.freeze({
  DISABLED: 'disabled',
  IDLE: 'idle',
  CHECKING: 'checking',
  UP_TO_DATE: 'up-to-date',
  AVAILABLE: 'available',
  DOWNLOADING: 'downloading',
  READY: 'ready',
  ERROR: 'error',
});

const NOTES_MAX = 6000;
const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

// ---------------------------------------------------------------------------------------------------- helpers

/** { owner, repo } from package.json "repository" (string or { url }); null when missing/not GitHub. */
export function parseRepository(pkg) {
  const raw = typeof pkg?.repository === 'string' ? pkg.repository : pkg?.repository?.url;
  if (typeof raw !== 'string') return null;
  const m = raw
    .trim()
    .match(/^(?:git\+)?(?:https:\/\/github\.com\/|git@github\.com:|github:)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

const parseVersion = (v) => {
  const m = SEMVER_RE.exec(String(v ?? '').trim());
  return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : null } : null;
};

/** Semver comparison (-1, 0, 1); null when either side is not a valid version. A pre-release sorts below its release. */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] > y.nums[i] ? 1 : -1;
  if (!x.pre && !y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) > Number(q) ? 1 : -1;
    if (pn) return -1;
    if (qn) return 1;
    return p > q ? 1 : -1;
  }
  return 0;
}

const isStableVersion = (v) => !!parseVersion(v) && !parseVersion(v).pre;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/**
 * Release notes are untrusted text from a GitHub release. They are reduced to PLAIN TEXT here (and rendered as text,
 * never as HTML, in the UI): scripts/styles dropped, tags stripped, entities decoded, length capped.
 */
export function normalizeReleaseNotes(notes) {
  let s = '';
  if (Array.isArray(notes)) s = notes.map((n) => [n?.version, n?.note].filter((x) => typeof x === 'string' && x).join('\n')).join('\n\n');
  else if (typeof notes === 'string') s = notes;
  else return '';
  s = s
    .replace(/<(script|style)[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|ul|ol|pre|blockquote|tr)\s*>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<\/li\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return s.length > NOTES_MAX ? `${s.slice(0, NOTES_MAX).trimEnd()}…` : s;
}

/**
 * How this copy of the app was installed.
 *   dev        not packaged (npm run dev/start) or a test run   -> disabled
 *   portable   electron-builder portable launcher (sets PORTABLE_EXECUTABLE_FILE) -> manual
 *   installer  packaged Windows build WITH app-update.yml (written by electron-builder from `publish`) -> auto
 *   unconfigured / other  packaged but cannot self-update      -> manual
 */
export function detectDistribution({ isPackaged, platform, env = {}, hasUpdateConfig = false }) {
  if (!isPackaged) return { kind: 'dev', mode: 'disabled', reason: 'development' };
  if (env.PORTABLE_EXECUTABLE_FILE) return { kind: 'portable', mode: 'manual' };
  if (platform === 'win32' && hasUpdateConfig) return { kind: 'installer', mode: 'auto' };
  return { kind: platform === 'win32' ? 'unconfigured' : 'other', mode: 'manual' };
}

/** Which release asset a manual (non-auto) copy should download. Names come from electron-builder.yml artifactName. */
export function assetPatternFor(kind, version) {
  const v = String(version).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (kind === 'portable') return new RegExp(`^Honya-Desktop-Portable-${v}\\.exe$`, 'i');
  if (kind === 'unconfigured') return new RegExp(`^Honya-Desktop-Setup-${v}\\.exe$`, 'i');
  return null;
}

export class UpdateError extends Error {
  constructor(code, message, extra = {}) {
    super(message ?? code);
    this.name = 'UpdateError';
    this.code = code;
    Object.assign(this, extra);
  }
}

const NETWORK_RE = /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_NETWORK|ERR_TIMED_OUT|ERR_PROXY|net::|fetch failed|network|timed? ?out|aborted/i;

/** Maps anything thrown by fetch / electron-updater to a stable error code the UI can translate. */
export function classifyError(e) {
  if (e instanceof UpdateError) return e;
  const msg = String(e?.message ?? e ?? '').split('\n')[0].slice(0, 200);
  const code = String(e?.code ?? '');
  const status = Number(e?.statusCode ?? e?.status ?? 0);
  if (code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' || code === 'ERR_UPDATER_ASSET_NOT_FOUND' || /cannot find (latest|channel)[^ ]*\.yml|latest\.yml/i.test(msg)) return new UpdateError('missing-assets', msg);
  if (code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' || /unable to find latest version|no published versions/i.test(msg)) return new UpdateError('no-release', msg);
  if (/sha512|checksum/i.test(msg) || code === 'ERR_CHECKSUM_MISMATCH') return new UpdateError('checksum', msg);
  if (/publisher|signature|certificate|not signed/i.test(msg) && !NETWORK_RE.test(msg)) return new UpdateError('signature', msg);
  if (status === 404) return new UpdateError('missing-assets', msg);
  if (status === 403 || status === 429 || /rate limit/i.test(msg)) return new UpdateError('rate-limited', msg);
  if (status >= 500) return new UpdateError('server', msg);
  if (NETWORK_RE.test(`${code} ${msg}`)) return new UpdateError('offline', msg);
  return new UpdateError('unknown', msg || 'Unknown error');
}

const repoPrefix = (repo) => (repo ? `https://github.com/${repo.owner}/${repo.repo}/releases` : null);

/** Only links into this project's own GitHub releases may be opened by the updater. */
export function isAllowedUpdateUrl(url, repo) {
  const prefix = repoPrefix(repo);
  if (!prefix || typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.hostname !== 'github.com' || u.username || u.password) return false;
    const want = `/${repo.owner}/${repo.repo}/releases`.toLowerCase();
    const p = u.pathname.toLowerCase();
    return p === want || p.startsWith(`${want}/`);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------- backends

/**
 * Detect-only backend: GitHub Releases API (/releases/latest never returns drafts or prereleases). Used for the portable
 * build. `fetch` should be Electron's net.fetch in production (system proxy / certificate store).
 */
export function createGithubReleaseBackend({ repo, fetch, currentVersion, kind, apiBase = 'https://api.github.com', userAgent = 'Honya-Desktop', timeoutMs = 15000 }) {
  return {
    async check() {
      if (!repo) throw new UpdateError('config', 'Repository is not configured');
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      let res;
      try {
        res = await fetch(`${apiBase}/repos/${repo.owner}/${repo.repo}/releases/latest`, {
          headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': userAgent },
          signal: ctl.signal,
        });
      } catch (e) {
        throw new UpdateError('offline', String(e?.message ?? e).split('\n')[0].slice(0, 200));
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 404) throw new UpdateError('no-release', 'No published release was found');
      if (res.status === 429 || res.status === 403) {
        const remaining = res.headers?.get?.('x-ratelimit-remaining');
        const reset = Number(res.headers?.get?.('x-ratelimit-reset'));
        if (res.status === 429 || remaining === '0' || res.headers?.get?.('retry-after')) {
          throw new UpdateError('rate-limited', 'GitHub rate limit reached', Number.isFinite(reset) && reset > 0 ? { resetAt: reset * 1000 } : {});
        }
        throw new UpdateError('unknown', `GitHub refused the request (HTTP ${res.status})`);
      }
      if (!res.ok) throw new UpdateError(res.status >= 500 ? 'server' : 'unknown', `GitHub returned HTTP ${res.status}`);
      let data;
      try {
        data = await res.json();
      } catch {
        throw new UpdateError('bad-response', 'GitHub returned an unreadable response');
      }
      if (!data || typeof data.tag_name !== 'string') throw new UpdateError('bad-response', 'GitHub returned an unexpected release');
      if (data.draft || data.prerelease) return { available: false };
      const version = data.tag_name.replace(/^v/i, '');
      if (!isStableVersion(version)) throw new UpdateError('bad-response', `Release tag "${data.tag_name}" is not a version number`);
      if (compareVersions(version, currentVersion) <= 0) return { available: false, version };
      const pattern = assetPatternFor(kind, version);
      const prefix = `${repoPrefix(repo)}/download/`;
      const asset = pattern
        ? (Array.isArray(data.assets) ? data.assets : []).find(
            (a) => typeof a?.name === 'string' && pattern.test(a.name) && typeof a.browser_download_url === 'string' && a.browser_download_url.toLowerCase().startsWith(prefix.toLowerCase()),
          )
        : null;
      return {
        available: true,
        version,
        releaseNotes: data.body ?? '',
        releaseDate: typeof data.published_at === 'string' ? data.published_at : null,
        releaseUrl: isAllowedUpdateUrl(data.html_url, repo) ? data.html_url : null,
        asset: asset ? { name: asset.name, url: asset.browser_download_url, size: Number(asset.size) || null } : null,
      };
    },
    async download() {
      throw new UpdateError('unsupported', 'This build cannot install updates itself');
    },
    install() {
      throw new UpdateError('unsupported', 'This build cannot install updates itself');
    },
  };
}

/**
 * Adapter around electron-updater's autoUpdater (NSIS installer). Nothing is downloaded or installed unless the user asks
 * (autoDownload / autoInstallOnAppQuit stay off), prereleases and downgrades are refused, and the download is verified
 * by electron-updater against the sha512 in latest.yml.
 *
 * When a GitHub release lookup is supplied, the published version is compared BEFORE electron-updater is asked for
 * latest.yml. electron-updater cannot know a release's version without that file, so a newest release that is older
 * than this build (or one published without metadata) would otherwise be misreported as "missing update files".
 * A genuinely newer release still goes through electron-updater unchanged, including its missing-assets errors.
 */
export function createElectronUpdaterBackend(
  autoUpdater,
  { log = () => {}, repo = null, currentVersion = null, fetch = null, apiBase = 'https://api.github.com' } = {},
) {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.autoRunAppAfterInstall = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.fullChangelog = false;
  autoUpdater.logger = { info: (m) => log('info', m), warn: (m) => log('warn', m), error: (m) => log('error', m), debug: () => {} };
  // An 'error' event with no listener would be thrown as an uncaught exception; failures are reported via the promises.
  autoUpdater.on('error', (e) => log('error', e?.message ?? String(e)));
  // Reuse the manual path's version comparison, release lookup and error classification. It is only created when the
  // caller can provide the repo and a fetch implementation; without them the adapter behaves exactly as before.
  const releaseLookup =
    repo && currentVersion && typeof fetch === 'function'
      ? createGithubReleaseBackend({
          repo,
          fetch,
          currentVersion,
          kind: 'installer',
          apiBase,
          userAgent: `Honya-Desktop/${currentVersion}`,
        })
      : null;
  return {
    async check() {
      if (releaseLookup) {
        const latest = await releaseLookup.check();
        // Equal or older: nothing to install, and latest.yml is irrelevant (this also covers a local build ahead of
        // the newest published release). Do not call electron-updater in this case.
        if (!latest.available) {
          return { available: false, version: latest.version ?? null, releaseNotes: '', releaseDate: null, asset: null };
        }
      }
      const r = await autoUpdater.checkForUpdates();
      if (!r) throw new UpdateError('config', 'Updates are not configured for this build');
      const info = r.updateInfo ?? {};
      return {
        available: r.isUpdateAvailable === true,
        version: info.version,
        releaseNotes: info.releaseNotes ?? '',
        releaseDate: info.releaseDate ?? null,
        asset: null,
      };
    },
    async download(onProgress) {
      const listener = (p) => onProgress?.({ percent: p?.percent, transferred: p?.transferred, total: p?.total, bytesPerSecond: p?.bytesPerSecond });
      autoUpdater.on('download-progress', listener);
      try {
        await autoUpdater.downloadUpdate();
      } finally {
        autoUpdater.removeListener('download-progress', listener);
      }
    },
    install() {
      // isSilent=true: the installer shows no wizard (the user already confirmed in Honya); isForceRunAfter=true restarts Honya.
      autoUpdater.quitAndInstall(true, true);
    },
  };
}

// ---------------------------------------------------------------------------------------------------- state machine

/**
 * @param {object} o
 * @param {string} o.currentVersion
 * @param {{owner:string,repo:string}|null} o.repo
 * @param {{kind:string,mode:'auto'|'manual'|'disabled',reason?:string}} o.distribution
 * @param {object|(() => Promise<object>)} [o.backend]  object with check/download/install, or an async factory (lazy)
 */
export function createAppUpdater({
  currentVersion,
  repo = null,
  distribution,
  backend = null,
  getPrefs = async () => ({}),
  openExternal = async () => {},
  onAvailable = () => {},
  schedule = (fn, ms) => {
    const h = setTimeout(fn, ms);
    h.unref?.();
    return () => clearTimeout(h);
  },
  now = Date.now,
  startupDelayMs = 45_000,
  intervalMs = 6 * 60 * 60 * 1000,
  log = () => {},
}) {
  const listeners = new Set();
  const releasesUrl = repoPrefix(repo);
  const mode = distribution?.mode ?? 'disabled';
  const busy = { check: false, download: false, install: false };
  const notified = new Set();
  let backendPromise = null;
  let lastProgressEmit = 0;

  let state = {
    status: mode === 'disabled' ? UPDATE_STATUS.DISABLED : UPDATE_STATUS.IDLE,
    mode,
    kind: distribution?.kind ?? 'dev',
    disabledReason: mode === 'disabled' ? distribution?.reason ?? 'development' : null,
    currentVersion,
    version: null,
    releaseNotes: '',
    releaseDate: null,
    releaseUrl: releasesUrl,
    releasesUrl,
    downloadUrl: null,
    assetName: null,
    missingAsset: false,
    progress: null,
    error: null,
    lastCheckedAt: null,
  };

  const snapshot = () => ({
    ...state,
    progress: state.progress ? { ...state.progress } : null,
    error: state.error ? { ...state.error } : null,
    canCheck: mode !== 'disabled' && !busy.check && !busy.download && state.status !== UPDATE_STATUS.READY,
    canDownload: mode === 'auto' && state.status === UPDATE_STATUS.AVAILABLE,
    canRetryDownload: mode === 'auto' && state.status === UPDATE_STATUS.ERROR && state.error?.phase === 'download' && !!state.version,
    canInstall: mode === 'auto' && state.status === UPDATE_STATUS.READY,
    canOpenDownload: mode === 'manual' && state.status === UPDATE_STATUS.AVAILABLE && !!state.downloadUrl,
  });

  const emit = () => {
    const s = snapshot();
    for (const l of listeners) {
      try {
        l(s);
      } catch (e) {
        log('warn', `listener failed: ${e?.message}`);
      }
    }
  };
  const set = (patch) => {
    state = { ...state, ...patch };
    emit();
  };

  const getBackend = () => {
    if (!backend) throw new UpdateError('config', 'Updates are not configured for this build');
    if (typeof backend !== 'function') return Promise.resolve(backend);
    backendPromise ??= Promise.resolve().then(backend).catch((e) => {
      backendPromise = null; // allow a later retry
      throw classifyError(e);
    });
    return backendPromise;
  };

  const toError = (e, phase) => {
    const err = classifyError(e);
    log('warn', `${phase} failed [${err.code}]: ${err.message}`);
    return { code: err.code, message: err.message, phase, resetAt: err.resetAt ?? null };
  };

  async function checkForUpdates({ manual = false } = {}) {
    if (state.status === UPDATE_STATUS.DISABLED) return snapshot();
    // One operation at a time; a finished download is kept until the user installs or restarts.
    if (busy.check || busy.download || state.status === UPDATE_STATUS.READY) return snapshot();
    busy.check = true;
    const before = state;
    set({ status: UPDATE_STATUS.CHECKING, error: null });
    try {
      const be = await getBackend();
      const r = await be.check();
      busy.check = false; // cleared before the final state is emitted: the pushed snapshot decides which buttons are enabled
      if (r?.available && r.version) {
        const downloadUrl = mode === 'manual' ? r.asset?.url ?? null : null;
        set({
          status: UPDATE_STATUS.AVAILABLE,
          version: r.version,
          releaseNotes: normalizeReleaseNotes(r.releaseNotes),
          releaseDate: r.releaseDate ?? null,
          releaseUrl: r.releaseUrl ?? releasesUrl,
          downloadUrl,
          assetName: mode === 'manual' ? r.asset?.name ?? null : null,
          missingAsset: mode === 'manual' && !r.asset,
          progress: null,
          error: null,
          lastCheckedAt: now(),
        });
        if (!manual && !notified.has(r.version)) {
          notified.add(r.version);
          try {
            onAvailable({ version: r.version });
          } catch (e) {
            log('warn', `onAvailable failed: ${e?.message}`);
          }
        }
      } else {
        set({
          status: UPDATE_STATUS.UP_TO_DATE,
          version: null,
          releaseNotes: '',
          releaseDate: null,
          releaseUrl: releasesUrl,
          downloadUrl: null,
          assetName: null,
          missingAsset: false,
          progress: null,
          error: null,
          lastCheckedAt: now(),
        });
      }
    } catch (e) {
      busy.check = false;
      const error = toError(e, 'check');
      // A background check that fails stays silent (no error banner); only an explicit "Check for updates" reports it.
      if (manual) set({ ...before, status: UPDATE_STATUS.ERROR, error, progress: null, lastCheckedAt: now() });
      else set({ ...before, lastCheckedAt: now() });
    } finally {
      busy.check = false;
    }
    return snapshot();
  }

  async function downloadUpdate() {
    if (mode !== 'auto') return snapshot();
    if (busy.download || busy.check) return snapshot(); // never two downloads at once
    const retry = state.status === UPDATE_STATUS.ERROR && state.error?.phase === 'download' && !!state.version;
    if (state.status !== UPDATE_STATUS.AVAILABLE && !retry) return snapshot();
    busy.download = true;
    set({ status: UPDATE_STATUS.DOWNLOADING, progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 }, error: null });
    try {
      const be = await getBackend();
      await be.download((p) => {
        const percent = Math.max(0, Math.min(100, Number(p?.percent) || 0));
        const t = now();
        const prev = state.progress?.percent ?? 0;
        state = { ...state, progress: { percent, transferred: Number(p?.transferred) || 0, total: Number(p?.total) || 0, bytesPerSecond: Number(p?.bytesPerSecond) || 0 } };
        if (Math.floor(percent) !== Math.floor(prev) || t - lastProgressEmit >= 250) {
          lastProgressEmit = t;
          emit();
        }
      });
      busy.download = false;
      set({ status: UPDATE_STATUS.READY, progress: { ...(state.progress ?? {}), percent: 100 }, error: null });
    } catch (e) {
      busy.download = false;
      set({ status: UPDATE_STATUS.ERROR, progress: null, error: toError(e, 'download') });
    } finally {
      busy.download = false;
    }
    return snapshot();
  }

  /** Installs the downloaded update and restarts. Only ever reached from an explicit user action. */
  async function installNow() {
    if (mode !== 'auto' || state.status !== UPDATE_STATUS.READY || busy.install) return { ok: false };
    busy.install = true;
    try {
      const be = await getBackend();
      be.install();
      return { ok: true };
    } catch (e) {
      busy.install = false;
      set({ status: UPDATE_STATUS.ERROR, error: toError(e, 'install') });
      return { ok: false };
    }
  }

  async function open(url) {
    if (!isAllowedUpdateUrl(url, repo)) return false;
    try {
      await openExternal(url);
      return true;
    } catch (e) {
      log('warn', `could not open link: ${e?.message}`);
      return false;
    }
  }
  const openReleases = () => open(state.releaseUrl ?? releasesUrl);
  const openDownload = () => open(state.downloadUrl);

  // Background checks: one delayed check after startup, then one per interval, each only after the previous one finished
  // (a chain of timeouts, not setInterval, so a slow check can never stack up with the next).
  let started = false;
  let cancelTimer = null;
  const plan = (ms) => {
    cancelTimer = schedule(async () => {
      cancelTimer = null;
      try {
        const prefs = await getPrefs();
        if (prefs?.autoCheckAppUpdates !== false) await checkForUpdates({ manual: false });
      } catch (e) {
        log('warn', `scheduled check failed: ${e?.message}`);
      } finally {
        if (started) plan(intervalMs);
      }
    }, ms);
  };
  const start = () => {
    if (started || state.status === UPDATE_STATUS.DISABLED) return;
    started = true;
    plan(startupDelayMs);
  };
  const stop = () => {
    started = false;
    cancelTimer?.();
    cancelTimer = null;
  };

  return {
    getState: snapshot,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    checkForUpdates,
    downloadUpdate,
    installNow,
    openReleases,
    openDownload,
    start,
    stop,
  };
}

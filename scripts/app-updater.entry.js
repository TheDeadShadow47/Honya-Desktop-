// Node-side tests for the app updater: services/appUpdater.js, the renderer helpers, and the release configuration.
// Run through scripts/app-updater-test.mjs. No network, no Electron: GitHub and electron-updater are faked.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import pkg from '../package.json';
import en from '../core/i18n/locales/en.js';
import ar from '../core/i18n/locales/ar.js';
import fr from '../core/i18n/locales/fr.js';
import de from '../core/i18n/locales/de.js';
import it from '../core/i18n/locales/it.js';
import desktop from '../core/i18n/locales/desktop.js';
import { DEFAULTS, pickSafePrefs } from '../core/settings/defaults.js';
// The real electron-updater GitHub provider (no Electron needed) is driven against a fake github.com in section 8.
import { GitHubProvider } from 'electron-updater/out/providers/GitHubProvider';
import { HttpError } from 'builder-util-runtime';
import {
  UPDATE_STATUS,
  UpdateError,
  assetPatternFor,
  classifyError,
  compareVersions,
  createAppUpdater,
  createElectronUpdaterBackend,
  createGithubReleaseBackend,
  detectDistribution,
  isAllowedUpdateUrl,
  normalizeReleaseNotes,
  parseRepository,
} from '../services/appUpdater.js';
import { ERROR_KEYS, shouldNotify, statusView } from '../src/lib/appUpdateUi.js';

const root = process.cwd();
let checks = 0;
const ok = (c, m) => {
  checks += 1;
  if (!c) {
    console.error('FAIL:', m);
    process.exit(1);
  }
  console.log('ok  -', m);
};
const same = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)})`);
const flush = () => new Promise((r) => setImmediate(r));

const REPO = { owner: 'o', repo: 'r' };
const INSTALLER = { kind: 'installer', mode: 'auto' };
const PORTABLE = { kind: 'portable', mode: 'manual' };

// ------------------------------------------------------------------ fakes
const fakeSchedule = () => {
  const tasks = [];
  return {
    tasks,
    schedule: (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      tasks.push(t);
      return () => { t.cancelled = true; };
    },
    pending: () => tasks.filter((t) => !t.cancelled && !t.ran),
    async fire() {
      const t = this.pending().at(-1);
      t.ran = true;
      await t.fn();
    },
  };
};

/** Scriptable backend: each entry in `checks` / `downloads` is a value (resolve) or an Error (reject). */
const fakeBackend = ({ checks: cs = [], downloads = [] } = {}) => {
  const calls = { check: 0, download: 0, install: 0 };
  return {
    calls,
    async check() {
      const r = cs[Math.min(calls.check++, cs.length - 1)];
      if (r instanceof Error) throw r;
      return r;
    },
    async download(onProgress) {
      const r = downloads[Math.min(calls.download++, downloads.length - 1)];
      onProgress?.({ percent: 40, transferred: 4, total: 10, bytesPerSecond: 1 });
      if (r instanceof Error) throw r;
    },
    install() { calls.install += 1; },
  };
};
const newer = (version = '0.2.0', extra = {}) => ({ available: true, version, releaseNotes: '<p>Fixes &amp; things</p>', releaseDate: '2026-10-01T00:00:00Z', ...extra });
const none = { available: false };

const make = (o = {}) => {
  const events = [];
  const notified = [];
  const sched = fakeSchedule();
  let clock = 1000;
  const opened = [];
  const u = createAppUpdater({
    currentVersion: '0.1.0',
    repo: REPO,
    distribution: INSTALLER,
    schedule: sched.schedule,
    now: () => (clock += 1000),
    openExternal: async (url) => opened.push(url),
    onAvailable: (a) => notified.push(a.version),
    ...o,
  });
  const snaps = [];
  u.subscribe((s) => { events.push(s.status); snaps.push(s); });
  return { u, events, notified, sched, opened, snaps };
};

const res = (status, body, headers = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => {
    if (body === undefined) throw new SyntaxError('Unexpected token');
    return body;
  },
});
const release = (tag, extra = {}) => {
  const v = tag.replace(/^v/, '');
  return {
    tag_name: tag, draft: false, prerelease: false, body: '## Notes\n- one', published_at: '2026-10-01T00:00:00Z',
    html_url: `https://github.com/o/r/releases/tag/${tag}`,
    assets: [{ name: `Honya-Desktop-Portable-${v}.exe`, browser_download_url: `https://github.com/o/r/releases/download/${tag}/Honya-Desktop-Portable-${v}.exe`, size: 123456 }],
    ...extra,
  };
};
const ghBackend = (fetch, extra = {}) => createGithubReleaseBackend({ repo: REPO, fetch, currentVersion: '0.1.0', kind: 'portable', ...extra });
const rejectsWith = async (fn) => { try { await fn(); } catch (e) { return e; } return null; };

// ================================================================== 1. helpers
{
  same(parseRepository({ repository: { url: 'git+https://github.com/TheDeadShadow47/Honya-Desktop-.git' } }), { owner: 'TheDeadShadow47', repo: 'Honya-Desktop-' }, 'parseRepository: git+https url with .git and a trailing-dash repo name');
  same(parseRepository({ repository: 'https://github.com/a/b' }), { owner: 'a', repo: 'b' }, 'parseRepository: plain https url');
  same(parseRepository({ repository: 'github:a/b' }), { owner: 'a', repo: 'b' }, 'parseRepository: github: shorthand');
  same(parseRepository({ repository: 'a/b' }), { owner: 'a', repo: 'b' }, 'parseRepository: owner/repo shorthand');
  ok(parseRepository({ repository: 'https://gitlab.com/a/b' }) === null && parseRepository({ repository: 'https://evil.com/github.com/a/b' }) === null, 'parseRepository: non-GitHub hosts rejected');
  ok(parseRepository({}) === null && parseRepository(null) === null, 'parseRepository: missing repository -> null (no crash)');

  ok(compareVersions('0.2.0', '0.1.0') === 1 && compareVersions('0.10.0', '0.9.0') === 1 && compareVersions('1.0.0', '1.0.0') === 0 && compareVersions('0.1.0', '0.2.0') === -1, 'compareVersions: numeric ordering (0.10 > 0.9)');
  ok(compareVersions('1.0.0', '1.0.0-beta.1') === 1 && compareVersions('1.0.0-beta.2', '1.0.0-beta.1') === 1 && compareVersions('v1.2.3', '1.2.3') === 0, 'compareVersions: prerelease below release, v prefix ignored');
  ok(compareVersions('nope', '1.0.0') === null, 'compareVersions: invalid -> null');

  const dirty = '<p>Hello &amp; <b>bold</b></p><script>alert(1)</script><img src=x onerror=alert(2)><ul><li>one</li><li>two &#39;q&#39; &lt;b&gt;</li></ul>';
  const text = normalizeReleaseNotes(dirty);
  ok(!/<\/?(script|img|p|ul|li)\b/i.test(text) && !text.includes('</b>'), 'release notes: all tags removed');
  ok(!/alert|onerror|script/i.test(text), 'release notes: script content and event handlers dropped');
  ok(text.includes('Hello & bold') && text.includes('• one') && text.includes("two 'q' <b>"), 'release notes: entities decoded to plain text (shown as text, never HTML)');
  ok(normalizeReleaseNotes([{ version: '0.2.0', note: 'a' }, { version: '0.1.1', note: 'b' }]).includes('0.2.0\na') && normalizeReleaseNotes(null) === '' && normalizeReleaseNotes(42) === '', 'release notes: changelog arrays joined, junk -> empty');
  ok(normalizeReleaseNotes('x'.repeat(20000)).length <= 6001, 'release notes: length capped');

  same(detectDistribution({ isPackaged: false, platform: 'win32', env: {}, hasUpdateConfig: true }), { kind: 'dev', mode: 'disabled', reason: 'development' }, 'distribution: unpackaged run is disabled');
  same(detectDistribution({ isPackaged: true, platform: 'win32', env: { PORTABLE_EXECUTABLE_FILE: 'C:\\x.exe' }, hasUpdateConfig: true }), { kind: 'portable', mode: 'manual' }, 'distribution: portable launcher env -> manual (never self-replaces)');
  same(detectDistribution({ isPackaged: true, platform: 'win32', env: {}, hasUpdateConfig: true }), { kind: 'installer', mode: 'auto' }, 'distribution: packaged Windows + app-update.yml -> auto');
  same(detectDistribution({ isPackaged: true, platform: 'win32', env: {}, hasUpdateConfig: false }), { kind: 'unconfigured', mode: 'manual' }, 'distribution: packaged without app-update.yml -> manual, not a crash');
  same(detectDistribution({ isPackaged: true, platform: 'linux', env: {}, hasUpdateConfig: true }), { kind: 'other', mode: 'manual' }, 'distribution: other platforms -> manual');

  ok(assetPatternFor('portable', '0.2.0').test('Honya-Desktop-Portable-0.2.0.exe') && !assetPatternFor('portable', '0.2.0').test('Honya-Desktop-Portable-0.2.01.exe') && !assetPatternFor('portable', '0.2.0').test('Honya-Desktop-Setup-0.2.0.exe') && assetPatternFor('other', '1.0.0') === null, 'asset pattern: exact portable file name only');

  const table = [
    [Object.assign(new Error('x'), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' }), 'missing-assets'],
    [new Error('Cannot find latest.yml in the latest release artifacts'), 'missing-assets'],
    [Object.assign(new Error('x'), { code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' }), 'no-release'],
    [new Error('sha512 checksum mismatch, expected a, got b'), 'checksum'],
    [new Error('New version 0.2.0 is not signed by the application owner'), 'signature'],
    [Object.assign(new Error('HttpError: 404'), { statusCode: 404 }), 'missing-assets'],
    [Object.assign(new Error('x'), { statusCode: 403 }), 'rate-limited'],
    [new Error('API rate limit exceeded'), 'rate-limited'],
    [Object.assign(new Error('x'), { statusCode: 502 }), 'server'],
    [new Error('net::ERR_INTERNET_DISCONNECTED'), 'offline'],
    [Object.assign(new Error('getaddrinfo ENOTFOUND github.com'), { code: 'ENOTFOUND' }), 'offline'],
    [new Error('something odd'), 'unknown'],
  ];
  for (const [e, code] of table) ok(classifyError(e).code === code, `classifyError -> ${code}`);
  ok(classifyError(new UpdateError('config')).code === 'config', 'classifyError keeps UpdateError codes');

  ok(isAllowedUpdateUrl('https://github.com/o/r/releases', REPO) && isAllowedUpdateUrl('https://github.com/o/r/releases/tag/v1.0.0', REPO) && isAllowedUpdateUrl('https://github.com/O/R/releases/download/v1/x.exe', REPO), 'open-link guard: own repo releases allowed (case-insensitive)');
  ok(!isAllowedUpdateUrl('http://github.com/o/r/releases', REPO) && !isAllowedUpdateUrl('https://github.com.evil.com/o/r/releases', REPO) && !isAllowedUpdateUrl('https://evil.com/o/r/releases', REPO) && !isAllowedUpdateUrl('https://github.com/o/r2/releases', REPO) && !isAllowedUpdateUrl('https://github.com/o/r/issues', REPO) && !isAllowedUpdateUrl('https://user:pw@github.com/o/r/releases', REPO) && !isAllowedUpdateUrl('file:///etc/passwd', REPO) && !isAllowedUpdateUrl(null, REPO) && !isAllowedUpdateUrl('https://github.com/o/r/releases', null), 'open-link guard: http, lookalike hosts, other repos/paths, credentials, file:, junk all refused');
}

// ================================================================== 2. installer (auto) state machine
{ // no update available
  const be = fakeBackend({ checks: [none] });
  const { u, events, notified } = make({ backend: be });
  ok(u.getState().status === 'idle' && u.getState().mode === 'auto', 'starts idle in auto mode');
  const s = await u.checkForUpdates({ manual: true });
  ok(s.status === 'up-to-date' && s.version === null && !s.canDownload && s.lastCheckedAt > 0, 'no update: "up to date", nothing to download');
  same(events, ['checking', 'up-to-date'], 'no update: state events are checking -> up-to-date');
  ok(notified.length === 0, 'no update: no notification');
}
{ // newer release available
  const be = fakeBackend({ checks: [newer('0.2.0')] });
  const { u, notified } = make({ backend: be });
  const s = await u.checkForUpdates({ manual: false });
  ok(s.status === 'available' && s.version === '0.2.0' && s.canDownload && !s.canInstall, 'newer release: available, download offered (not started)');
  ok(s.releaseNotes === 'Fixes & things' && s.releaseDate === '2026-10-01T00:00:00Z', 'newer release: release notes normalised to plain text, date kept');
  same(notified, ['0.2.0'], 'newer release: background check notifies once');
  await u.checkForUpdates({ manual: false });
  same(notified, ['0.2.0'], 'newer release: same version is not announced again (no repeated notifications)');
  ok(be.calls.download === 0 && be.calls.install === 0, 'newer release: nothing downloaded or installed without the user');
}
{ // manual check does not fire the background notification
  const { u, notified } = make({ backend: fakeBackend({ checks: [newer('0.2.0')] }) });
  await u.checkForUpdates({ manual: true });
  ok(notified.length === 0, 'manual check: no extra desktop notification (the user is already looking)');
}
{ // check failures: manual reports, background stays silent
  const be = fakeBackend({ checks: [new Error('net::ERR_INTERNET_DISCONNECTED'), none] });
  const { u, events } = make({ backend: be });
  const s = await u.checkForUpdates({ manual: true });
  ok(s.status === 'error' && s.error.code === 'offline' && s.error.phase === 'check' && s.canCheck, 'check failure (manual): error with code "offline", can retry');
  const s2 = await u.checkForUpdates({ manual: true });
  ok(s2.status === 'up-to-date' && s2.error === null, 'check failure: manual retry succeeds and clears the error');
  const be2 = fakeBackend({ checks: [new Error('ECONNRESET')] });
  const m2 = make({ backend: be2 });
  const s3 = await m2.u.checkForUpdates({ manual: false });
  ok(s3.status === 'idle' && s3.error === null, 'check failure (background): silent, state restored, no error banner');
  ok(events.filter((e) => e === 'checking').length === 2, 'check failure: no hidden retry loop (one backend call per check)');
}
{ // download success + progress
  const be = fakeBackend({ checks: [newer()], downloads: [undefined] });
  const { u, events } = make({ backend: be });
  await u.checkForUpdates({ manual: true });
  const s = await u.downloadUpdate();
  ok(s.status === 'ready' && s.canInstall && s.progress.percent === 100, 'download: ends "ready to install"');
  ok(events.includes('downloading') && events.at(-1) === 'ready', 'download: downloading -> ready');
  const again = await u.checkForUpdates({ manual: true });
  ok(again.status === 'ready' && be.calls.check === 1, 'ready update is kept: a later check does not re-check or discard it');
}
{ // download failure + retry
  const be = fakeBackend({ checks: [newer()], downloads: [new Error('sha512 checksum mismatch'), undefined] });
  const { u } = make({ backend: be });
  await u.checkForUpdates({ manual: true });
  const f = await u.downloadUpdate();
  ok(f.status === 'error' && f.error.code === 'checksum' && f.error.phase === 'download' && f.version === '0.2.0' && f.canRetryDownload && !f.canInstall, 'download failure: error "checksum", version kept, retry offered, install NOT offered');
  const r = await u.downloadUpdate();
  ok(r.status === 'ready' && be.calls.download === 2 && r.canInstall, 'download retry: succeeds on the second attempt');
}
{ // concurrent downloads
  let release;
  const gate = new Promise((r) => { release = r; });
  const be = { calls: { download: 0 }, check: async () => newer(), download: async () => { be.calls.download += 1; await gate; }, install() {} };
  const { u } = make({ backend: be });
  await u.checkForUpdates({ manual: true });
  const a = u.downloadUpdate();
  const b = u.downloadUpdate();
  const c = u.checkForUpdates({ manual: true });
  await flush();
  ok(be.calls.download === 1, 'concurrent downloads: a second request while downloading is ignored');
  ok((await c).status === 'downloading', 'concurrent downloads: a check during a download does not interfere');
  release();
  await Promise.all([a, b]);
  ok(u.getState().status === 'ready' && be.calls.download === 1, 'concurrent downloads: exactly one download completed');
}
{ // a download is refused whenever there is nothing (new) to download
  const be = fakeBackend({ checks: [none], downloads: [undefined] });
  const { u } = make({ backend: be });
  await u.downloadUpdate();
  ok(be.calls.download === 0 && u.getState().status === 'idle', 'download request with no check done yet: refused');
  await u.checkForUpdates({ manual: true });
  await u.downloadUpdate();
  ok(be.calls.download === 0 && u.getState().status === 'up-to-date', 'download request while up to date: refused');
  const be2 = fakeBackend({ checks: [newer()], downloads: [undefined] });
  const m2 = make({ backend: be2 });
  await m2.u.checkForUpdates({ manual: true });
  await m2.u.downloadUpdate();
  await m2.u.downloadUpdate();
  ok(be2.calls.download === 1 && m2.u.getState().status === 'ready', 'download request after the update is already downloaded: not repeated');
}
{ // missing release assets
  const be = fakeBackend({ checks: [Object.assign(new Error('Cannot find latest.yml in the latest release artifacts (https://github.com/o/r/releases/download/v0.2.0/latest.yml)'), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' })] });
  const { u, opened } = make({ backend: be });
  const s = await u.checkForUpdates({ manual: true });
  ok(s.status === 'error' && s.error.code === 'missing-assets' && s.releasesUrl === 'https://github.com/o/r/releases', 'missing assets: clear error + link to the releases page (no fake download)');
  ok((await u.openReleases()) === true && opened[0] === 'https://github.com/o/r/releases', 'missing assets: the releases page can be opened');
  const be2 = fakeBackend({ checks: [newer()], downloads: [Object.assign(new Error('404'), { statusCode: 404 })] });
  const m2 = make({ backend: be2 });
  await m2.u.checkForUpdates({ manual: true });
  const d = await m2.u.downloadUpdate();
  ok(d.status === 'error' && d.error.code === 'missing-assets' && d.error.phase === 'download', 'missing assets: a 404 on the installer download is reported, not hidden');
}
{ // postponing never installs
  const be = fakeBackend({ checks: [newer()], downloads: [undefined] });
  const { u, sched } = make({ backend: be, getPrefs: async () => ({ autoCheckAppUpdates: true, postponedUpdateVersion: '0.2.0' }) });
  ok((await u.installNow()).ok === false && be.calls.install === 0, 'install is refused before an update is downloaded');
  await u.checkForUpdates({ manual: true });
  ok((await u.installNow()).ok === false && be.calls.install === 0, 'install is refused while only "available"');
  await u.downloadUpdate();
  u.start();
  await sched.fire(); await sched.fire(); await sched.fire(); // postponed: background checks keep running
  ok(u.getState().status === 'ready' && be.calls.install === 0, 'postponed ("Later"): downloaded update waits; nothing installs by itself, even across background checks');
  ok((await u.installNow()).ok === true && be.calls.install === 1, 'install happens only on the explicit installNow call');
  await u.installNow();
  ok(be.calls.install === 1, 'install cannot be triggered twice');
}
{ // development / test mode
  const boom = { check: async () => { throw new Error('must not be called'); }, download: async () => { throw new Error('must not be called'); }, install() { throw new Error('must not be called'); } };
  const { u, sched } = make({ distribution: { kind: 'dev', mode: 'disabled', reason: 'development' }, backend: boom });
  ok(u.getState().status === 'disabled' && u.getState().disabledReason === 'development' && !u.getState().canCheck, 'development: updater is disabled and says why');
  const s = await u.checkForUpdates({ manual: true });
  await u.downloadUpdate(); await u.installNow();
  u.start();
  ok(s.status === 'disabled' && sched.tasks.length === 0, 'development: no check, no download, no install, no timers scheduled');
}
{ // configuration problems do not crash
  let factoryCalls = 0;
  const { u } = make({ backend: async () => { factoryCalls += 1; if (factoryCalls === 1) throw new Error('electron-updater could not be loaded'); return fakeBackend({ checks: [none] }); } });
  const s = await u.checkForUpdates({ manual: true });
  ok(s.status === 'error' && s.error.phase === 'check', 'backend load failure: reported as an error, app keeps running');
  const s2 = await u.checkForUpdates({ manual: true });
  ok(s2.status === 'up-to-date' && factoryCalls === 2, 'backend load failure: a later attempt can recover');
  const noBackend = make({ backend: null });
  const s3 = await noBackend.u.checkForUpdates({ manual: true });
  ok(s3.status === 'error' && s3.error.code === 'config', 'no backend/repository configured: "config" error, no crash');
}

{ // the PUSHED snapshots (what the renderer gets) must already allow the next action
  const mk = (checks, downloads) => make({ backend: fakeBackend({ checks, downloads }) });
  let m = mk([none]);
  await m.u.checkForUpdates({ manual: true });
  ok(m.snaps.at(-1).status === 'up-to-date' && m.snaps.at(-1).canCheck === true, 'pushed state after a finished check: "Check for updates" is enabled again');
  ok(m.snaps.find((s) => s.status === 'checking').canCheck === false, 'pushed state while checking: the button is disabled');
  m = mk([new Error('ECONNRESET')]);
  await m.u.checkForUpdates({ manual: true });
  ok(m.snaps.at(-1).status === 'error' && m.snaps.at(-1).canCheck === true, 'pushed state after a failed check: Retry is enabled');
  m = mk([newer()], [new Error('sha512 checksum mismatch')]);
  await m.u.checkForUpdates({ manual: true });
  ok(m.snaps.at(-1).status === 'available' && m.snaps.at(-1).canDownload === true, 'pushed state: "Download" is enabled once an update is found');
  await m.u.downloadUpdate();
  ok(m.snaps.at(-1).status === 'error' && m.snaps.at(-1).canRetryDownload === true && m.snaps.at(-1).canCheck === true, 'pushed state after a failed download: retry is enabled');
  m = mk([newer()], [undefined]);
  await m.u.checkForUpdates({ manual: true });
  await m.u.downloadUpdate();
  ok(m.snaps.at(-1).status === 'ready' && m.snaps.at(-1).canInstall === true, 'pushed state after a finished download: "Install and restart" is enabled');
  const bg = mk([new Error('ECONNRESET')]);
  await bg.u.checkForUpdates({ manual: false });
  ok(bg.snaps.at(-1).status === 'idle' && bg.snaps.at(-1).canCheck === true, 'pushed state after a silent background failure: the manual check stays enabled');
}

// ================================================================== 3. scheduling
{
  const be = fakeBackend({ checks: [none] });
  let prefs = { autoCheckAppUpdates: true };
  const { u, sched } = make({ backend: be, getPrefs: async () => prefs, startupDelayMs: 45000, intervalMs: 21600000 });
  u.start(); u.start();
  ok(sched.tasks.length === 1 && sched.tasks[0].ms === 45000, 'schedule: one delayed startup check (45s), start() is idempotent');
  ok(be.calls.check === 0, 'schedule: nothing is checked synchronously at startup');
  await sched.fire();
  ok(be.calls.check === 1 && sched.tasks.length === 2 && sched.tasks[1].ms === 21600000, 'schedule: after the check the next one is planned 6h later');
  prefs = { autoCheckAppUpdates: false };
  await sched.fire();
  ok(be.calls.check === 1 && sched.tasks.length === 3, 'schedule: turning automatic checks off skips the check but keeps the timer (re-enable works without restart)');
  prefs = { autoCheckAppUpdates: true };
  await sched.fire();
  ok(be.calls.check === 2, 'schedule: automatic checks resume when re-enabled');
  u.stop();
  ok(sched.pending().length === 0, 'schedule: stop() cancels the pending timer');
}
{ // no overlapping or runaway checks
  let release; const gate = new Promise((r) => { release = r; });
  const be = { calls: { check: 0 }, check: async () => { be.calls.check += 1; await gate; return none; }, download: async () => {}, install() {} };
  const { u, sched } = make({ backend: be });
  u.start();
  const run = sched.fire();
  await flush();
  const manual = u.checkForUpdates({ manual: true });
  await flush();
  ok(be.calls.check === 1 && sched.tasks.length === 1, 'no overlap: a manual check during a running check reuses it, and the next run is not planned yet');
  release();
  await run; await manual;
  ok(sched.tasks.length === 2 && be.calls.check === 1, 'no overlap: next run planned only after the check finished');
}
{ // failing background checks never loop
  const be = fakeBackend({ checks: [new Error('net::ERR_INTERNET_DISCONNECTED')] });
  const { u, sched } = make({ backend: be });
  u.start();
  await sched.fire();
  ok(be.calls.check === 1 && sched.tasks.length === 2 && sched.tasks[1].ms === 6 * 3600 * 1000, 'failure backoff: a failed background check waits the full interval before the next');
}

// ================================================================== 4. manual mode (portable) + GitHub backend
{
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, init }); return res(200, release('v0.2.0')); };
  const be = ghBackend(fetch);
  const { u, opened } = make({ distribution: PORTABLE, backend: be });
  const s = await u.checkForUpdates({ manual: true });
  ok(s.status === 'available' && s.mode === 'manual' && !s.canDownload && !s.canInstall && s.canOpenDownload, 'portable: update detected, only "open download" offered (no self-install)');
  ok(s.assetName === 'Honya-Desktop-Portable-0.2.0.exe' && s.downloadUrl.endsWith('/v0.2.0/Honya-Desktop-Portable-0.2.0.exe') && s.releaseNotes.includes('Notes'), 'portable: correct portable asset and release notes');
  ok(calls[0].url === 'https://api.github.com/repos/o/r/releases/latest' && calls[0].init.headers['User-Agent'] && !('Authorization' in calls[0].init.headers), 'portable: calls the public releases/latest endpoint, no credentials');
  ok((await u.downloadUpdate()).status === 'available' && (await u.installNow()).ok === false, 'portable: download/install requests are no-ops (never replaces the running exe)');
  ok((await u.openDownload()) === true && opened.at(-1) === s.downloadUrl, 'portable: the download link opens in the browser');
}
{
  const noAsset = release('v0.2.0', { assets: [{ name: 'latest.yml', browser_download_url: 'https://github.com/o/r/releases/download/v0.2.0/latest.yml' }] });
  const { u, opened } = make({ distribution: PORTABLE, backend: ghBackend(async () => res(200, noAsset)) });
  const s = await u.checkForUpdates({ manual: true });
  ok(s.status === 'available' && s.missingAsset && !s.canOpenDownload && s.downloadUrl === null, 'portable, release without portable file: flagged "missing asset", no fake download');
  ok((await u.openReleases()) === true && opened[0] === 'https://github.com/o/r/releases/tag/v0.2.0', 'portable, missing asset: links to the release page instead');
  ok((await u.openDownload()) === false, 'portable, missing asset: openDownload does nothing');
}
{
  const evil = release('v0.2.0', { assets: [{ name: 'Honya-Desktop-Portable-0.2.0.exe', browser_download_url: 'https://evil.example/Honya-Desktop-Portable-0.2.0.exe' }], html_url: 'https://evil.example/x' });
  const { u, opened } = make({ distribution: PORTABLE, backend: ghBackend(async () => res(200, evil)) });
  const s = await u.checkForUpdates({ manual: true });
  ok(s.missingAsset && s.downloadUrl === null && s.releaseUrl === 'https://github.com/o/r/releases', 'portable: an asset or page URL outside the project\'s releases is ignored');
  ok((await u.openDownload()) === false && opened.length === 0, 'portable: no foreign link is ever opened');
  const direct = make({ distribution: PORTABLE, backend: { check: async () => ({ available: true, version: '0.2.0', asset: { name: 'a', url: 'https://evil.example/a.exe' } }), download: async () => {}, install() {} } });
  await direct.u.checkForUpdates({ manual: true });
  ok((await direct.u.openDownload()) === false && direct.opened.length === 0, 'portable: the updater itself re-validates download links before opening');
}
{
  const cases = [
    ['same version', res(200, release('v0.1.0')), (r) => r.available === false],
    ['older version', res(200, release('v0.0.9')), (r) => r.available === false],
    ['prerelease flag', res(200, release('v0.2.0', { prerelease: true })), (r) => r.available === false],
    ['draft flag', res(200, release('v0.2.0', { draft: true })), (r) => r.available === false],
  ];
  for (const [name, response, check] of cases) ok(check(await ghBackend(async () => response).check()), `github backend: ${name} -> no update`);
  const errs = [
    ['404', res(404, {}), 'no-release'],
    ['403 rate limit', res(403, {}, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' }), 'rate-limited'],
    ['429', res(429, {}), 'rate-limited'],
    ['403 other', res(403, {}), 'unknown'],
    ['500', res(500, {}), 'server'],
    ['invalid JSON', res(200, undefined), 'bad-response'],
    ['no tag', res(200, { assets: [] }), 'bad-response'],
    ['non-version tag', res(200, release('nightly')), 'bad-response'],
    ['prerelease tag name', res(200, release('v0.2.0-beta.1')), 'bad-response'],
  ];
  for (const [name, response, code] of errs) {
    const e = await rejectsWith(() => ghBackend(async () => response).check());
    ok(e?.code === code, `github backend: ${name} -> ${code}`);
  }
  const rl = await rejectsWith(() => ghBackend(async () => res(403, {}, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' })).check());
  ok(rl.resetAt === 1800000000000, 'github backend: rate limit reports when it resets');
  ok((await rejectsWith(() => ghBackend(async () => { throw new TypeError('fetch failed'); }).check()))?.code === 'offline', 'github backend: network failure -> offline');
  const slow = ghBackend((url, init) => new Promise((_r, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))), { timeoutMs: 20 });
  ok((await rejectsWith(() => slow.check()))?.code === 'offline', 'github backend: a hung request times out instead of blocking forever');
  const noRepo = createGithubReleaseBackend({ repo: null, fetch: async () => res(200, {}), currentVersion: '0.1.0', kind: 'portable' });
  ok((await rejectsWith(() => noRepo.check()))?.code === 'config', 'github backend: missing repository configuration -> config error');
}
{ // rate limit surfaced through the updater without breaking the app
  const { u } = make({ distribution: PORTABLE, backend: ghBackend(async () => res(403, {}, { 'x-ratelimit-remaining': '0' })) });
  const s = await u.checkForUpdates({ manual: true });
  ok(s.status === 'error' && s.error.code === 'rate-limited' && s.canCheck, 'rate limit: reported to the user, retry stays possible');
}

// ================================================================== 5. electron-updater adapter
{
  class FakeUpdater extends EventEmitter {
    calls = [];
    checkResult = { isUpdateAvailable: true, updateInfo: { version: '0.2.0', releaseNotes: '<p>n</p>', releaseDate: 'd' } };
    async checkForUpdates() { this.calls.push('check'); return this.checkResult; }
    async downloadUpdate() { this.calls.push('download'); this.emit('download-progress', { percent: 25.5, transferred: 1, total: 4, bytesPerSecond: 9 }); }
    quitAndInstall(...a) { this.calls.push(['install', ...a]); }
  }
  const au = new FakeUpdater();
  const be = createElectronUpdaterBackend(au);
  ok(au.autoDownload === false && au.autoInstallOnAppQuit === false && au.allowPrerelease === false && au.allowDowngrade === false && au.fullChangelog === false, 'electron-updater: no auto download, no install-on-quit, no prereleases, no downgrades');
  let threw = false;
  try { au.emit('error', new Error('boom')); } catch { threw = true; }
  ok(!threw, 'electron-updater: an "error" event cannot crash the main process');
  const r = await be.check();
  ok(r.available === true && r.version === '0.2.0' && r.releaseNotes.includes('n'), 'electron-updater: check result mapped');
  au.checkResult = { isUpdateAvailable: false, updateInfo: { version: '0.1.0' } };
  ok((await be.check()).available === false, 'electron-updater: no update mapped');
  au.checkResult = null;
  ok((await rejectsWith(() => be.check()))?.code === 'config', 'electron-updater: null result (not configured) -> config error');
  const seen = [];
  await be.download((p) => seen.push(p));
  ok(seen[0].percent === 25.5 && au.listenerCount('download-progress') === 0, 'electron-updater: progress forwarded and the listener is removed afterwards');
  be.install();
  same(au.calls.at(-1), ['install', true, true], 'electron-updater: install = quitAndInstall(silent wizard, relaunch)');
  ok(au.calls.filter((c) => Array.isArray(c)).length === 1, 'electron-updater: quitAndInstall was called exactly once, and only because install() was called');
}

// ================================================================== 6. UI helpers + translations
{
  const s = (o) => ({ currentVersion: '0.1.0', ...o });
  ok(shouldNotify(s({ status: 'available', version: '0.2.0' }), { postponedVersion: '', dismissed: [] }) === true, 'notice: shown for a new version');
  ok(shouldNotify(s({ status: 'available', version: '0.2.0' }), { postponedVersion: '0.2.0' }) === false, 'notice: not shown for a postponed version ("Later")');
  ok(shouldNotify(s({ status: 'available', version: '0.3.0' }), { postponedVersion: '0.2.0' }) === true, 'notice: a newer version than the postponed one notifies again');
  ok(shouldNotify(s({ status: 'available', version: '0.2.0' }), { dismissed: ['0.2.0'] }) === false, 'notice: shown only once per version per session');
  ok(shouldNotify(s({ status: 'ready', version: '0.2.0' }), { postponedVersion: '0.2.0' }) === true && shouldNotify(s({ status: 'ready', version: '0.2.0' }), { dismissed: ['0.2.0'] }) === false, 'notice: a downloaded update still offers install until dismissed');
  ok(!shouldNotify(s({ status: 'up-to-date' })) && !shouldNotify(s({ status: 'error', version: '0.2.0' })) && !shouldNotify(s({ status: 'downloading', version: '0.2.0' })) && !shouldNotify(null), 'notice: nothing for up-to-date, errors, downloads in progress, or no state');

  const locales = { en: { ...en, ...desktop.en }, ar: { ...ar, ...desktop.ar }, fr: { ...fr, ...desktop.fr }, de: { ...de, ...desktop.de }, it: { ...it, ...desktop.it } };
  const states = [
    { status: 'disabled' }, { status: 'idle' }, { status: 'checking' }, { status: 'up-to-date' },
    { status: 'available', version: '0.2.0' }, { status: 'available', version: '0.2.0', missingAsset: true },
    { status: 'downloading', version: '0.2.0' }, { status: 'ready', version: '0.2.0' },
    ...Object.keys(ERROR_KEYS).map((code) => ({ status: 'error', error: { code } })),
  ].map((x) => ({ currentVersion: '0.1.0', ...x }));
  let bad = [];
  for (const st of states) {
    const v = statusView(st);
    for (const [lang, dict] of Object.entries(locales)) {
      const str = dict[v.key];
      if (typeof str !== 'string') { bad.push(`${lang}:${v.key} missing`); continue; }
      for (const m of str.matchAll(/\{\{(\w+)\}\}/g)) if (!(m[1] in v.params)) bad.push(`${lang}:${v.key} needs {{${m[1]}}}`);
    }
  }
  ok(bad.length === 0, `every status/error message exists in all 5 languages with its placeholders supplied ${bad.join('; ')}`);
  const panelKeys = ['update.title', 'update.checkForUpdates', 'update.checking', 'update.downloadUpdate', 'update.later', 'update.retry', 'update.whatsNewTitle', 'update.downloadPercent', 'update.downloadProgress', 'update.currentVersion', 'update.available', 'update.updateReady',
    'appUpdate.hint', 'appUpdate.autoCheck', 'appUpdate.autoCheckHint', 'appUpdate.installRestart', 'appUpdate.installHint', 'appUpdate.releaseNotes', 'appUpdate.noNotes', 'appUpdate.openReleases', 'appUpdate.downloadFromGithub', 'appUpdate.manualHint', 'appUpdate.bannerBody', 'appUpdate.details'];
  const missing = panelKeys.flatMap((k) => Object.entries(locales).filter(([, d]) => typeof d[k] !== 'string').map(([l]) => `${l}:${k}`));
  ok(missing.length === 0, `every UI string used by the update panel/banner exists in all 5 languages ${missing.join(', ')}`);
  const codes = ['offline', 'rate-limited', 'no-release', 'missing-assets', 'checksum', 'signature', 'server', 'config', 'bad-response', 'unknown'];
  ok(codes.every((c) => ERROR_KEYS[c]) && Object.keys(ERROR_KEYS).length === codes.length, 'every error code the updater can produce has a translated message');
}

// ================================================================== 7. configuration + wiring consistency
{
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
  const yml = read('electron-builder.yml');
  const repo = parseRepository(pkg);
  ok(!!repo && repo.owner === 'TheDeadShadow47' && repo.repo === 'Honya-Desktop-', 'config: package.json "repository" points at the real GitHub repo');
  const pub = yml.match(/^publish:\n((?:[ \t]+.*\n?)+)/m)?.[1] ?? '';
  const field = (k) => pub.match(new RegExp(`^\\s+${k}:\\s*([^\\s#]+)`, 'm'))?.[1];
  ok(field('provider') === 'github' && field('owner') === repo.owner && field('repo') === repo.repo && field('releaseType') === 'release', 'config: electron-builder publish block matches package.json (github, same owner/repo, releases only)');
  ok(/^\d+\.\d+\.\d+$/.test(pkg.version) && compareVersions(pkg.version, '0.0.0') === 1, `config: package.json version is a plain semver (${pkg.version})`);
  const art = (block) => yml.match(new RegExp(`^${block}:\\n(?:[ \\t]+.*\\n)*?[ \\t]+artifactName:\\s*(\\S+)`, 'm'))?.[1];
  const render = (t) => t.replace('${version}', pkg.version).replace('${ext}', 'exe');
  ok(assetPatternFor('portable', pkg.version).test(render(art('portable'))), 'config: portable artifactName matches the file name the updater looks for');
  ok(assetPatternFor('unconfigured', pkg.version).test(render(art('nsis'))), 'config: NSIS artifactName matches the setup file name');
  ok(!/\s/.test(render(art('nsis'))) && !/\s/.test(render(art('portable'))), 'config: artifact names contain no spaces (GitHub would rename the asset and break latest.yml)');
  ok(/^nsis:\n(?:[ \t]+.*\n)*?[ \t]+oneClick:\s*false/m.test(yml) && /^nsis:\n(?:[ \t]+.*\n)*?[ \t]+perMachine:\s*false/m.test(yml) && /^nsis:\n(?:[ \t]+.*\n)*?[ \t]+deleteAppDataOnUninstall:\s*false/m.test(yml), 'config: installer stays per-user and never deletes user data');
  ok(/appId:\s*app\.honya\.desktop/.test(yml), 'config: appId unchanged (changing it would break in-place upgrades)');
  ok(!!pkg.devDependencies['electron-updater'] || !!pkg.dependencies?.['electron-updater'], 'config: electron-updater is declared');
  const lock = JSON.parse(read('package-lock.json'));
  ok(!!lock.packages['node_modules/electron-updater'] && lock.packages[''].devDependencies['electron-updater'] === pkg.devDependencies['electron-updater'], 'config: lockfile contains electron-updater consistently with package.json');
  for (const k of ['dist', 'dist:installer', 'dist:portable']) ok(/--publish never/.test(pkg.scripts[k]), `config: "${k}" never publishes by itself`);

  const mainSrc = read('electron/main.js');
  const apiSrc = read('src/lib/api.js');
  const channels = [...apiSrc.matchAll(/invoke\('(appUpdate:[A-Za-z]+)'\)/g)].map((m) => m[1]);
  ok(channels.length === 6, 'wiring: the renderer exposes 6 appUpdate channels');
  ok(channels.every((c) => new RegExp(`'${c}': \\(\\) =>`).test(mainSrc)), 'wiring: every channel has a main-process handler that takes NO renderer arguments');
  ok(/send\('honya:appUpdateState'/.test(mainSrc) && /onAppUpdateState: on\('honya:appUpdateState'\)/.test(read('electron/preload.js')), 'wiring: state push channel matches between main and preload');
  ok(!/app:openExternal/.test(read('src/components/AppUpdatePanel.jsx')) && !/openExternal\(/.test(read('src/components/AppUpdatePanel.jsx')), 'wiring: the update UI cannot open arbitrary URLs (only the validated appUpdate channels)');
  ok(!/dangerouslySetInnerHTML/.test(read('src/components/AppUpdatePanel.jsx') + read('src/components/AppUpdateBanner.jsx')), 'security: release notes are never rendered as HTML');
  ok(/isPackaged/.test(mainSrc) && /distribution = \{ kind: 'dev', mode: 'disabled', reason: 'test' \}/.test(mainSrc), 'wiring: development and smoke/test runs disable the updater');
  ok(!/app\.setPath|rmSync|rmdir|unlink/.test(read('services/appUpdater.js')), 'user data: the updater contains no file deletion or path changes');

  ok(DEFAULTS.autoCheckAppUpdates === true && DEFAULTS.postponedUpdateVersion === '', 'prefs: new defaults (auto-check on, nothing postponed)');
  const safe = pickSafePrefs({ autoCheckAppUpdates: false, postponedUpdateVersion: '0.2.0', junk: 1 });
  ok(safe.autoCheckAppUpdates === false && safe.postponedUpdateVersion === '0.2.0' && !('junk' in safe), 'prefs: backup restore accepts the new keys with the right types');
}

// ================================================================== 8. release asset format + "missing update files" (real electron-updater GitHub provider)
// What an installed copy really does: electron-updater resolves the latest release tag, then downloads
// <repo>/releases/download/<tag>/latest.yml. The release is therefore only updatable if it carries the files below.
// A release with notes + GitHub's auto-generated source archives (or only the .exe files) is NOT enough.
{
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
  const yml = read('electron-builder.yml');
  const repo = parseRepository(pkg);
  const artTpl = (block) => yml.match(new RegExp(`^${block}:\\n(?:[ \\t]+.*\\n)*?[ \\t]+artifactName:\\s*(\\S+)`, 'm'))?.[1];
  const render = (t, v) => t.replace('${version}', v).replace('${ext}', 'exe');
  const expectedAssets = (v) => {
    const installer = render(artTpl('nsis'), v);
    return { channel: 'latest.yml', installer, blockmap: `${installer}.blockmap`, portable: render(artTpl('portable'), v) };
  };

  // ---- the documented release asset format, independent of how the config is parsed
  const want = expectedAssets(pkg.version);
  same(
    [want.channel, want.installer, want.blockmap, want.portable],
    ['latest.yml', `Honya-Desktop-Setup-${pkg.version}.exe`, `Honya-Desktop-Setup-${pkg.version}.exe.blockmap`, `Honya-Desktop-Portable-${pkg.version}.exe`],
    'release format: a release must carry latest.yml + installer + installer .blockmap + portable exe, named exactly like this',
  );
  const docs = read('docs/UPDATES.md');
  const docNames = Object.values(expectedAssets('<version>'));
  ok(docNames.every((n) => docs.includes(`\`${n}\``)), `release format: docs/UPDATES.md checklist lists every required asset (${docNames.join(', ')})`);
  ok(/tag \*\*must be `v` \+ that version\*\*/.test(docs), 'release format: docs state that the tag must be v<package.json version>');

  // ---- a fake github.com that serves exactly the assets given (everything else is a real-looking 404)
  const base = `/${repo.owner}/${repo.repo}/releases`;
  const fakeGithub = ({ tag, assets, notes = 'Release notes' }) => {
    const requests = [];
    const executor = {
      async request(o) {
        const url = `${o.protocol}//${o.hostname}${o.port ? `:${o.port}` : ''}${o.path}`;
        requests.push(url);
        const p = new URL(url).pathname;
        if (p === `${base}.atom`) {
          return `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>tag:github.com,2008:Repository/1/${tag}</id><link rel="alternate" type="text/html" href="https://github.com${base}/tag/${tag}"/><title>Honya Desktop ${tag}</title><content type="html">${notes}</content></entry></feed>`;
        }
        if (p === `${base}/latest`) return JSON.stringify({ tag_name: tag });
        const prefix = `${base}/download/${tag}/`;
        const file = p.startsWith(prefix) ? decodeURIComponent(p.slice(prefix.length)) : null;
        if (file !== null && Object.prototype.hasOwnProperty.call(assets, file)) return assets[file];
        throw new HttpError(404);
      },
    };
    return { executor, requests };
  };
  const makeProvider = (executor) =>
    new GitHubProvider(
      { provider: 'github', owner: repo.owner, repo: repo.repo },
      { channel: null, allowPrerelease: false, fullChangelog: false, currentVersion: { raw: pkg.version } },
      { executor, platform: 'win32', isUseMultipleRangeRequest: false },
    );
  // The shape electron-builder writes to latest.yml for the NSIS installer.
  const latestYml = (v) => {
    const a = expectedAssets(v);
    const hash = `${'A'.repeat(86)}==`;
    return `version: ${v}\nfiles:\n  - url: ${a.installer}\n    sha512: ${hash}\n    size: 123456789\npath: ${a.installer}\nsha512: ${hash}\nreleaseDate: '2026-10-12T12:00:00.000Z'\n`;
  };
  const fullRelease = (v) => {
    const a = expectedAssets(v);
    return { 'latest.yml': latestYml(v), [a.installer]: 'exe', [a.blockmap]: 'blockmap', [a.portable]: 'exe' };
  };
  // The app's own installer backend + state machine, fed by the real provider (only the isUpdateAvailable decision is local).
  const appOver = (provider) => {
    const autoUpdater = Object.assign(new EventEmitter(), {
      async checkForUpdates() {
        const info = await provider.getLatestVersion();
        return { updateInfo: info, isUpdateAvailable: compareVersions(info.version, pkg.version) === 1 };
      },
    });
    return createAppUpdater({ currentVersion: pkg.version, repo, distribution: { kind: 'installer', mode: 'auto' }, backend: createElectronUpdaterBackend(autoUpdater) });
  };
  const failure = async (p) => {
    try {
      await p();
    } catch (e) {
      return e;
    }
    return null;
  };

  // 1. The real published state: the only release is v0.1.0 (Setup + Portable .exe, no latest.yml), installed copy is newer.
  {
    const tag = 'v0.1.0';
    const gh = fakeGithub({ tag, assets: { 'Honya-Desktop-Setup-0.1.0.exe': 'exe', 'Honya-Desktop-Portable-0.1.0.exe': 'exe' } });
    const err = await failure(() => makeProvider(gh.executor).getLatestVersion());
    ok(err?.code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' && err.message.includes(`${base}/download/${tag}/latest.yml`), 'missing assets (real v0.1.0): electron-updater fails on releases/download/v0.1.0/latest.yml with ERR_UPDATER_CHANNEL_FILE_NOT_FOUND');
    same(gh.requests.map((u) => new URL(u).pathname), [`${base}.atom`, `${base}/latest`, `${base}/download/${tag}/latest.yml`], 'missing assets: the updater only ever asks for the release feed, the latest tag and latest.yml (source archives never count)');
    const s = await appOver(makeProvider(fakeGithub({ tag, assets: { 'Honya-Desktop-Setup-0.1.0.exe': 'exe' } }).executor)).checkForUpdates({ manual: true });
    ok(s.status === 'error' && s.error.code === 'missing-assets' && s.error.phase === 'check' && s.releasesUrl === `https://github.com${base}`, 'missing assets (real v0.1.0): Settings shows the "missing update files" error and links to the releases page');
    ok(desktop.en[ERROR_KEYS[s.error.code]] === 'The release is missing its update files, so it cannot be installed automatically.', 'missing assets: this error code is the exact message shown in Settings -> Updates');
  }

  // 2. A release that has only notes (no assets at all) for the current version.
  {
    const gh = fakeGithub({ tag: `v${pkg.version}`, assets: {} });
    const err = await failure(() => makeProvider(gh.executor).getLatestVersion());
    ok(err?.code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' && err.message.includes(`/download/v${pkg.version}/latest.yml`), `missing assets: v${pkg.version} published with release notes only -> latest.yml not found`);
  }

  // 3. Installer + blockmap + portable uploaded, but latest.yml forgotten: still not installable.
  {
    const assets = fullRelease(pkg.version);
    delete assets['latest.yml'];
    const s = await appOver(makeProvider(fakeGithub({ tag: `v${pkg.version}`, assets }).executor)).checkForUpdates({ manual: true });
    ok(s.status === 'error' && s.error.code === 'missing-assets', 'missing assets: installer without latest.yml is not enough (still "missing update files")');
  }

  // 4. A complete release for the installed version: no error, "up to date", and every URL the updater derives exists.
  {
    const tag = `v${pkg.version}`;
    const gh = fakeGithub({ tag, assets: fullRelease(pkg.version) });
    const provider = makeProvider(gh.executor);
    const info = await provider.getLatestVersion();
    const [file] = provider.resolveFiles(info);
    ok(info.version === pkg.version && info.path === want.installer && info.files[0].url === want.installer, 'complete release: latest.yml names the installer exactly as electron-builder.yml artifactName');
    ok(file.url.href === `https://github.com${base}/download/${tag}/${want.installer}`, 'complete release: installer download URL is releases/download/v<version>/<installer>');
    const [, newBlockmap] = provider.getBlockMapFiles(file.url, '0.0.1', pkg.version);
    ok(newBlockmap.pathname.endsWith(`/${want.blockmap}`), 'complete release: the blockmap the updater looks for is <installer>.blockmap');
    const s = await appOver(makeProvider(fakeGithub({ tag, assets: fullRelease(pkg.version) }).executor)).checkForUpdates({ manual: true });
    ok(s.status === 'up-to-date' && s.error === null, 'complete release: installed copy reports "up to date", no error');
  }

  // 5. A complete newer release is offered for download.
  {
    const next = '0.2.1';
    const s = await appOver(makeProvider(fakeGithub({ tag: `v${next}`, assets: fullRelease(next), notes: 'Fixes' }).executor)).checkForUpdates({ manual: true });
    ok(s.status === 'available' && s.version === next && s.canDownload && s.error === null, 'complete newer release (v0.2.1): update is offered and can be downloaded');
  }
}

console.log(`APP UPDATER UNIT PASSED (${checks} checks)`);

// Drives the REAL Electron app (real main-process updater, real renderer UI) against a local FAKE GitHub Releases API.
// The test hook that points the updater at the fake server exists only in smoke mode (HONYA_SMOKE=1 + HONYA_UPDATE_TEST_API).
// Scenarios: newer release, "Later" persisted across a restart, a newer-than-postponed release, up to date, rate limit,
// GitHub unreachable, release without its download file, development/test mode (updater disabled).
// Verified on Linux (uses xvfb-run when there is no DISPLAY). Uses temporary data directories only.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { root } from './lib/bundle.mjs';
import './build-electron.mjs';

const require = createRequire(import.meta.url);
const electron = require('electron');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const OWNER_REPO = 'TheDeadShadow47/Honya-Desktop-';
const CURRENT = pkg.version;
const NEWER = '99.0.0';
const NEWEST = '100.0.0';
const linuxHeadless = process.platform === 'linux' && !process.env.DISPLAY;

// ---------------------------------------------------------------- fake GitHub API
const releaseJson = (version, { withAsset = true } = {}) => ({
  tag_name: `v${version}`,
  draft: false,
  prerelease: false,
  published_at: '2026-10-01T00:00:00Z',
  html_url: `https://github.com/${OWNER_REPO}/releases/tag/v${version}`,
  body: `<h2>What's new</h2><p>Fixed things &amp; added reader polish.</p><img src=x onerror="document.title='pwned'"><script>document.title='pwned'</script><ul><li>one</li><li>two</li></ul>`,
  assets: withAsset
    ? [
        { name: `Honya-Desktop-Setup-${version}.exe`, browser_download_url: `https://github.com/${OWNER_REPO}/releases/download/v${version}/Honya-Desktop-Setup-${version}.exe`, size: 1000 },
        { name: `Honya-Desktop-Portable-${version}.exe`, browser_download_url: `https://github.com/${OWNER_REPO}/releases/download/v${version}/Honya-Desktop-Portable-${version}.exe`, size: 2000 },
      ]
    : [{ name: 'latest.yml', browser_download_url: `https://github.com/${OWNER_REPO}/releases/download/v${version}/latest.yml`, size: 10 }],
});
const server = { mode: 'newer', hits: 0, userAgents: [] };
const api = http.createServer((req, res) => {
  if (req.url !== `/repos/${OWNER_REPO}/releases/latest`) {
    res.writeHead(404).end('{}');
    return;
  }
  server.hits += 1;
  server.userAgents.push(req.headers['user-agent']);
  const send = (code, body, headers = {}) => res.writeHead(code, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
  if (server.mode === 'ratelimit') return send(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1900000000' });
  if (server.mode === 'same') return send(200, releaseJson(CURRENT));
  if (server.mode === 'newest') return send(200, releaseJson(NEWEST));
  if (server.mode === 'noasset') return send(200, releaseJson(NEWER, { withAsset: false }));
  return send(200, releaseJson(NEWER));
});
await new Promise((r) => api.listen(0, '127.0.0.1', r));
const apiBase = `http://127.0.0.1:${api.address().port}`;

// ---------------------------------------------------------------- renderer scripts (evaluated in the app window)
const PRELUDE = `
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, label, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await wait(100); } throw new Error('timeout: ' + label); };
  const byText = (sel, txt) => [...document.querySelectorAll(sel)].find((b) => b.textContent.trim().startsWith(txt));
  const out = {};
  const openSettings = async () => { location.hash = '#/settings'; await waitFor(() => document.querySelector('.upd-panel'), 'update panel'); await wait(300); };
  const status = () => document.querySelector('.upd-panel .upd-status')?.textContent ?? null;
  const prefs = async () => (await window.honya.invoke('db:getKV', 'prefs')) ?? {};
`;
const wrap = (body) => `(async () => { ${PRELUDE} try { ${body} } catch (e) { out.error = String(e && e.message || e); try { const st = await window.honya.invoke('appUpdate:getState'); out.debug = { status: st.status, error: st.error, buttons: [...document.querySelectorAll('.dialog button, .upd-panel button')].map((b) => b.textContent.trim() + (b.disabled ? ' [disabled]' : '')), text: document.querySelector('.dialog .upd-status, .upd-panel .upd-status')?.textContent }; } catch {} } return out; })()`;

const SCRIPTS = {
  // newer release: notice -> details dialog (plain-text notes) -> download link -> Later (persisted)
  newer: wrap(`
    const banner = await waitFor(() => document.querySelector('.upd-banner'), 'update notice');
    out.bannerText = banner.innerText;
    byText('.upd-banner button', 'Details').click();
    const dlg = await waitFor(() => document.querySelector('.dialog .upd-panel'), 'details dialog');
    const notes = dlg.querySelector('.upd-notes');
    out.notes = notes.textContent;
    out.noteChildElements = notes.querySelectorAll('*').length;
    out.injectedNodes = document.querySelectorAll('.dialog img, .dialog script').length;
    out.titleAfterNotes = document.title;
    out.hasDownloadButton = !!byText('.dialog button', 'Download from GitHub');
    out.hasInstallButton = !!byText('.dialog button', 'Install and restart');
    byText('.dialog button', 'Download from GitHub').click();
    await wait(400);
    byText('.dialog button', 'Later').click();
    await waitFor(() => !document.querySelector('.upd-banner') && !document.querySelector('.dialog'), 'notice dismissed');
    await wait(700);
    out.prefs = await prefs();
    await openSettings();
    out.settingsStatus = status();
    out.state = await window.honya.invoke('appUpdate:getState');
  `),
  // restart: the postponed version must not be announced again, but stays visible in Settings
  postponed: wrap(`
    await wait(2500);
    out.bannerShown = !!document.querySelector('.upd-banner');
    out.prefs = await prefs();
    await openSettings();
    out.settingsStatus = status();
    out.state = await window.honya.invoke('appUpdate:getState');
  `),
  // a version newer than the postponed one notifies again
  newest: wrap(`
    const banner = await waitFor(() => document.querySelector('.upd-banner'), 'notice for newer version');
    out.bannerText = banner.innerText;
    out.prefs = await prefs();
  `),
  same: wrap(`
    await wait(1500);
    out.bannerShown = !!document.querySelector('.upd-banner');
    await openSettings();
    out.settingsStatus = status();
    byText('.upd-panel button', 'Check for updates').click();
    await waitFor(() => status() && !/Checking/.test(status()), 'manual check finished');
    await wait(300);
    out.afterManualCheck = status();
  `),
  ratelimit: wrap(`
    await openSettings();
    byText('.upd-panel button', 'Check for updates').click();
    await waitFor(() => /limiting/.test(status() ?? ''), 'rate limit message');
    out.settingsStatus = status();
    out.hasRetry = !!byText('.upd-panel button', 'Retry');
    location.hash = '#/library';
    await wait(700);
    out.stillUsable = /Library/.test(document.body.innerText);
  `),
  offline: wrap(`
    await openSettings();
    byText('.upd-panel button', 'Check for updates').click();
    await waitFor(() => /Could not reach GitHub/.test(status() ?? ''), 'offline message');
    out.settingsStatus = status();
    location.hash = '#/library';
    await wait(700);
    out.stillUsable = /Library/.test(document.body.innerText);
  `),
  noasset: wrap(`
    const banner = await waitFor(() => document.querySelector('.upd-banner'), 'notice');
    out.bannerText = banner.innerText;
    await openSettings();
    out.settingsStatus = status();
    out.hasDownloadButton = !!byText('.upd-panel button', 'Download from GitHub');
    out.hasReleasesButton = !!byText('.upd-panel button', 'Open GitHub Releases');
    byText('.upd-panel button', 'Open GitHub Releases').click();
    await wait(400);
  `),
  // installer flow (scripted backend): download with progress -> checksum failure -> Retry -> ready -> Later -> Install
  auto: wrap(`
    const banner = await waitFor(() => document.querySelector('.upd-banner'), 'notice');
    out.bannerText = banner.innerText;
    byText('.upd-banner button', 'Details').click();
    const dlg = await waitFor(() => document.querySelector('.dialog .upd-panel'), 'details dialog');
    out.hasDownloadUpdate = !!byText('.dialog button', 'Download update');
    out.hasGithubDownload = !!byText('.dialog button', 'Download from GitHub');
    byText('.dialog button', 'Download update').click();
    await waitFor(() => document.querySelector('.dialog .upd-bar'), 'progress bar');
    out.progressStatus = document.querySelector('.dialog .upd-status').textContent;
    await waitFor(() => Number(document.querySelector('.dialog .upd-bar')?.getAttribute('aria-valuenow')) >= 20, 'progress moves');
    out.progressNow = Number(document.querySelector('.dialog .upd-bar').getAttribute('aria-valuenow'));
    out.noLaterWhileDownloading = !byText('.dialog button', 'Later');
    await waitFor(() => /integrity check/.test(document.querySelector('.dialog .upd-status')?.textContent ?? ''), 'checksum failure shown');
    out.failureStatus = document.querySelector('.dialog .upd-status').textContent;
    out.hasInstallAfterFailure = !!byText('.dialog button', 'Install and restart');
    out.hasRetry = !!byText('.dialog button', 'Retry');
    const retry = await waitFor(() => { const b = byText('.dialog button', 'Retry'); return b && !b.disabled && b; }, 'enabled Retry button');
    retry.click();
    await waitFor(() => byText('.dialog button', 'Install and restart'), 'ready to install');
    out.readyStatus = document.querySelector('.dialog .upd-status').textContent;
    out.installHint = /close, install the update and reopen/.test(document.querySelector('.dialog').innerText);
    byText('.dialog button', 'Later').click();
    await waitFor(() => !document.querySelector('.dialog'), 'dialog closed');
    await wait(1500);
    out.bannerAfterLater = !!document.querySelector('.upd-banner');
    out.stateAfterLater = (await window.honya.invoke('appUpdate:getState')).status;
    await openSettings();
    out.settingsHasInstall = !!byText('.upd-panel button', 'Install and restart');
    byText('.upd-panel button', 'Install and restart').click();
    await wait(800);
  `),
  disabled: wrap(`
    await openSettings();
    out.settingsStatus = status();
    out.hasCheckButton = !!byText('.upd-panel button', 'Check for updates');
    out.state = await window.honya.invoke('appUpdate:getState');
  `),
};

// ---------------------------------------------------------------- runner
const dirs = [];
const run = (scenario, dataDir, { useApi = true, apiUrl = apiBase, env: extraEnv = {} } = {}) =>
  new Promise((resolve) => {
    const scriptFile = path.join(dataDir, `${scenario}.script.js`);
    fs.writeFileSync(scriptFile, SCRIPTS[scenario]);
    const env = {
      ...process.env,
      HONYA_SMOKE: '1',
      HONYA_DATA_DIR: dataDir,
      HONYA_SMOKE_SCRIPT: scriptFile,
      HONYA_SMOKE_OUT: path.join(dataDir, 'shots'),
      ...(useApi ? { HONYA_UPDATE_TEST_API: apiUrl } : {}),
      ...extraEnv,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const args = [root, ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : [])];
    const [cmd, argv] = linuxHeadless ? ['xvfb-run', ['-a', electron, ...args]] : [electron, args];
    const p = spawn(cmd, argv, { env });
    let buf = '';
    p.stdout.on('data', (d) => (buf += d));
    p.stderr.on('data', () => {});
    const timer = setTimeout(() => p.kill('SIGKILL'), 90000);
    p.on('exit', () => {
      clearTimeout(timer);
      const raw = buf.split('\n').find((l) => l.startsWith('SMOKE_RESULT'))?.slice(13);
      resolve({ result: raw ? JSON.parse(raw) : null, installCalls: buf.split('\n').filter((l) => l.startsWith('INSTALL_CALLED')).length, opened: buf.split('\n').filter((l) => l.startsWith('OPEN_EXTERNAL ')).map((l) => l.slice(14).trim()) });
    });
  });

let failed = 0;
const check = (cond, msg) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} - ${msg}`);
  if (!cond) failed += 1;
};
const phase = async (label, scenario, mode, dataDir, opts) => {
  console.log(`\n### ${label}`);
  server.mode = mode;
  const before = server.hits;
  const { result, opened, installCalls } = await run(scenario, dataDir, opts);
  const hits = server.hits - before;
  if (!result) {
    check(false, 'the app produced a result');
    return { r: {}, opened, hits, stdoutInstallCalls: installCalls };
  }
  check(result.errors.length === 0, `no renderer errors${result.errors.length ? ': ' + result.errors.join(' | ') : ''}`);
  check(!result.report.script.error && !result.report.script.scriptError, `UI flow completed${result.report.script.error ? ': ' + result.report.script.error : ''}`);
  if (result.report.script.error && result.report.script.debug) console.log('     UI state at failure:', JSON.stringify(result.report.script.debug));
  return { r: result.report.script, opened, hits, stdoutInstallCalls: installCalls };
};
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'honya-e2e-upd-'));
  dirs.push(d);
  return d;
};

try {
  const data = tmp();
  const assetUrl = `https://github.com/${OWNER_REPO}/releases/download/v${NEWER}/Honya-Desktop-Portable-${NEWER}.exe`;

  let { r, opened, hits } = await phase('Newer release found (portable/manual build), "Later" chosen', 'newer', 'newer', data);
  check(new RegExp(`${NEWER.replace(/\./g, '\\.')} is available`).test(r.bannerText ?? ''), `notice announces version ${NEWER}`);
  check(/Fixed things & added reader polish\./.test(r.notes ?? '') && /• one/.test(r.notes ?? ''), 'release notes are shown (as plain text)');
  check(r.noteChildElements === 0 && r.injectedNodes === 0 && r.titleAfterNotes !== 'pwned', 'release notes cannot inject HTML/script into the page');
  check(r.hasDownloadButton === true && r.hasInstallButton === false, 'manual build offers "Download from GitHub", never "Install and restart"');
  check(opened.length === 1 && opened[0] === assetUrl, `Download button opens the release file in the browser (${opened[0] ?? 'nothing opened'})`);
  check(r.prefs?.postponedUpdateVersion === NEWER && r.prefs?.autoCheckAppUpdates === true, '"Later" is saved in the existing preferences (postponedUpdateVersion)');
  check(new RegExp(`${NEWER.replace(/\./g, '\\.')} is available`).test(r.settingsStatus ?? '') && r.state?.status === 'available', 'Settings still shows the postponed update');
  check(hits === 1 && /^Honya-Desktop\//.test(server.userAgents.at(-1) ?? ''), `exactly one startup check was made, with a Honya user agent (hits=${hits})`);

  ({ r, hits } = await phase('Restart: the postponed version is not announced again', 'postponed', 'newer', data));
  check(r.bannerShown === false, 'no notice for the postponed version after restart');
  check(r.prefs?.postponedUpdateVersion === NEWER && r.state?.status === 'available' && new RegExp(NEWER.replace(/\./g, '\\.')).test(r.settingsStatus ?? ''), 'it is still available from Settings');
  check(hits === 1, `no check loop (hits=${hits})`);

  ({ r } = await phase('A release newer than the postponed one notifies again', 'newest', 'newest', data));
  check(new RegExp(`${NEWEST.replace(/\./g, '\\.')} is available`).test(r.bannerText ?? ''), `notice announces ${NEWEST}`);

  ({ r, hits } = await phase('Up to date', 'same', 'same', data));
  check(r.bannerShown === false && /latest version/.test(r.settingsStatus ?? '') && r.settingsStatus.includes(CURRENT), `Settings says "up to date" (${r.settingsStatus})`);
  check(/latest version/.test(r.afterManualCheck ?? '') && hits === 2, `manual "Check for updates" works and checks once more (hits=${hits})`);

  ({ r } = await phase('GitHub rate limit', 'ratelimit', 'ratelimit', tmp()));
  check(/limiting requests/.test(r.settingsStatus ?? '') && r.hasRetry === true, 'rate limit: clear message and a Retry button');
  check(r.stillUsable === true, 'rate limit: the rest of the app stays usable');

  ({ r } = await phase('GitHub unreachable', 'offline', 'newer', tmp(), { apiUrl: 'http://127.0.0.1:1' }));
  check(/Could not reach GitHub/.test(r.settingsStatus ?? '') && r.stillUsable === true, 'offline: clear message, app stays usable');

  ({ r, opened } = await phase('Release without its download file', 'noasset', 'noasset', tmp()));
  check(/download file is missing/.test(r.settingsStatus ?? ''), `missing file explained (${r.settingsStatus})`);
  check(r.hasDownloadButton === false && r.hasReleasesButton === true, 'no fake "download": offers the GitHub Releases page instead');
  check(opened.length === 1 && opened[0] === `https://github.com/${OWNER_REPO}/releases/tag/v${NEWER}`, `releases link opens the project's release page (${opened[0] ?? 'nothing'})`);

  let auto;
  ({ r, auto } = await (async () => {
    const x = await phase('Installer build (scripted backend): download, failure, retry, ready, Later, install', 'auto', 'newer', tmp(), { useApi: false, env: { HONYA_UPDATE_TEST_AUTO: '1' } });
    return { r: x.r, auto: x };
  })());
  check(/99\.0\.0 is available/.test(r.bannerText ?? '') && r.hasDownloadUpdate === true && r.hasGithubDownload === false, 'installer build offers "Download update" (not the manual GitHub download)');
  check(/Downloading Honya 99\.0\.0/.test(r.progressStatus ?? '') && r.progressNow >= 20 && r.noLaterWhileDownloading === true, `progress bar shows while downloading (${r.progressNow}%)`);
  check(/integrity check/.test(r.failureStatus ?? '') && r.hasRetry === true && r.hasInstallAfterFailure === false, 'failed download: explained, Retry offered, install NOT offered');
  check(/has been downloaded/.test(r.readyStatus ?? '') && r.installHint === true, 'after retry: "ready", with the "Install and restart" explanation');
  check(r.bannerAfterLater === false && r.stateAfterLater === 'ready' && r.settingsHasInstall === true, '"Later": the downloaded update waits (not discarded, not installed) and stays installable from Settings');
  const installCalls = auto.stdoutInstallCalls;
  check(installCalls === 1, `install is triggered exactly once, only by the "Install and restart" click (calls=${installCalls})`);

  ({ r } = await phase('Development / test build: updater disabled', 'disabled', 'newer', tmp(), { useApi: false }));
  check(/disabled in development and test builds/.test(r.settingsStatus ?? '') && r.hasCheckButton === false && r.state?.status === 'disabled', 'disabled: says why, no check button, no network use');
} finally {
  api.close();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}
console.log(failed ? `\nAPP UPDATE UI FAILED (${failed})` : '\nAPP UPDATE UI PASSED');
process.exit(failed ? 1 : 0);

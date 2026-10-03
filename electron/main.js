import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import * as db from '../core/db/database.js';
import { createHost } from '../plugin-host/PluginHost.js';
import { createPluginService } from '../plugin-host/pluginService.js';
import { createDownloadService } from '../services/downloadService.js';
import { createLibraryUpdate } from '../services/libraryUpdate.js';
import { createReadingSessionBus } from '../services/readingSession.js';
import { attachDiscord } from '../integrations/discord/index.js';
import * as backup from '../core/backup/backup.js';
import { DEFAULTS } from '../core/settings/defaults.js';

// __dirname is provided by the CJS bundle (see scripts/build-electron.mjs).
const DEV_URL = (!app.isPackaged && process.env.HONYA_DEV_URL) || null; // a packaged app never talks to a dev server
const SMOKE = process.env.HONYA_SMOKE === '1';

// User data lives in the per-user app-data folder (%APPDATA%\Honya Desktop on Windows), never next to the
// executable, so installing/updating/uninstalling the app does not touch it. The folder is pinned explicitly so
// dev runs, the installed app and the portable build all share one location.
const LEGACY_USER_DATA = path.join(app.getPath('appData'), 'honya-desktop');
if (!process.env.HONYA_DATA_DIR) app.setPath('userData', path.join(app.getPath('appData'), 'Honya Desktop'));
const DATA_DIR = process.env.HONYA_DATA_DIR || path.join(app.getPath('userData'), 'data');
globalThis.__HONYA_DATA_DIR__ = DATA_DIR;

// Earlier dev builds stored data under the package name ("honya-desktop"). Copy it over once (the old folder is
// left untouched) so existing libraries survive the move.
if (!process.env.HONYA_DATA_DIR) {
  try {
    const legacyData = path.join(LEGACY_USER_DATA, 'data');
    if (fs.existsSync(legacyData) && !fs.existsSync(DATA_DIR)) fs.cpSync(legacyData, DATA_DIR, { recursive: true });
  } catch (e) {
    console.warn('[data] legacy data copy skipped:', e?.message);
  }
}

// One running instance per user: two instances would open the same SQLite files.
const gotLock = SMOKE || process.env.HONYA_DATA_DIR ? true : app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

const host = createHost();
const pluginService = createPluginService({ db, host });
const session = createReadingSessionBus();

// Preferences live in the SQLite kv table; services read them through this accessor so a change in
// the renderer takes effect without a restart.
let prefsCache = null;
const prefs = {
  async get() {
    if (!prefsCache) {
      try {
        prefsCache = (await db.getKV('prefs')) ?? {};
      } catch {
        prefsCache = {};
      }
    }
    return prefsCache;
  },
  invalidate() {
    prefsCache = null;
  },
};

// Discord Rich Presence (optional; see integrations/discord). It only listens to the reading-session bus.
const discord = attachDiscord(session, { getPrefs: () => prefs.get() });

const downloadService = createDownloadService({ db, host, prefs });
const libraryUpdate = createLibraryUpdate({
  db,
  host,
  onChange: (payload) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('honya:libraryUpdate', payload);
  },
  onResult: (payload) => {
    void notifyLibraryUpdate(payload);
  },
});

// Test hook (smoke mode ONLY): HONYA_TEST_HOST_MAP="https://www.royalroad.com=http://127.0.0.1:PORT" redirects plugin
// network calls to a local fixture server. Never active in normal runs.
if (SMOKE && process.env.HONYA_TEST_HOST_MAP) {
  const map = Object.fromEntries(process.env.HONYA_TEST_HOST_MAP.split(',').map((p) => p.split('=')));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    const origin = Object.keys(map).find((o) => url.startsWith(o));
    if (!origin) return realFetch(input, init);
    const res = await realFetch(map[origin] + url.slice(origin.length), init);
    Object.defineProperty(res, 'url', { value: url }); // keep the original URL, like a real response would
    return res;
  };
}

const BACKUP_FILE_EXTENSION = 'honyabackup';

function backupFileName(at = Date.now()) {
  const d = new Date(at);
  const p = (n) => String(n).padStart(2, '0');
  return `honya-backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.${BACKUP_FILE_EXTENSION}`;
}

/** Full backup payload, matching the mobile format so backups are interchangeable. */
async function buildBackupPayload() {
  return backup.buildBackupPayload(db, { appVersion: app.getVersion() });
}

async function restoreBackupPayload(payload) {
  const meta = await backup.restoreBackupPayload(db, payload, { defaults: DEFAULTS });
  prefs.invalidate();
  return meta;
}

async function importBackup(win) {
  const res = await dialog.showOpenDialog(win, {
    title: 'Import Honya backup',
    filters: [{ name: 'Honya backup', extensions: ['json', BACKUP_FILE_EXTENSION] }],
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths[0]) return { canceled: true };
  const raw = JSON.parse(await fs.promises.readFile(res.filePaths[0], 'utf8'));
  const meta = await restoreBackupPayload(raw);
  return { canceled: false, ...meta };
}

async function exportBackup(win) {
  const payload = await buildBackupPayload();
  const res = await dialog.showSaveDialog(win, {
    title: 'Save Honya backup',
    defaultPath: backupFileName(),
    filters: [{ name: 'Honya backup', extensions: ['json'] }],
  });
  if (res.canceled || !res.filePath) return { canceled: true };
  const json = JSON.stringify(payload, null, 2);
  await fs.promises.writeFile(res.filePath, json, 'utf8');
  return { canceled: false, path: res.filePath, name: path.basename(res.filePath), size: json.length, novels: payload.data.novels.length };
}

async function showNotification({ title, body }) {
  try {
    const { Notification } = await import('electron');
    if (Notification.isSupported()) new Notification({ title, body }).show();
  } catch {}
}

async function notifyLibraryUpdate(payload) {
  const p = await prefs.get();
  if (p?.notificationsEnabled === false) return;
  if (payload.type === 'cancelled') return;
  const s = payload.summary;
  if (!s) return;
  if (s.newChapters > 0) {
    if (p?.notifyNewChaptersFound !== false) {
      await showNotification({
        title: 'New chapters found',
        body: `${payload.updatedTitles?.length ?? 0} novels updated · ${s.newChapters} new chapters`,
      });
    }
  }
  if (s.failed.length && p?.notifyUpdateFailed !== false) {
    await showNotification({ title: 'Library update complete', body: `${s.checked} checked · ${s.failed.length} failed` });
  }
}

/** Search every installed source at once, mirroring store.globalSearch on mobile. */
async function globalSearch(query, { pluginIds = null } = {}) {
  const q = String(query ?? '').trim();
  if (!q) return { results: [], errors: [] };
  const installed = await db.getPlugins();
  const targets = pluginIds?.length ? installed.filter((p) => pluginIds.includes(p.id)) : installed;
  const results = [];
  const errors = [];
  await Promise.all(
    targets.map(async (p) => {
      try {
        const novels = await Promise.race([
          pluginService.search(p.id, q, 1),
          new Promise((_r, rej) => setTimeout(() => rej(new Error('Search timed out after 20s')), 20000)),
        ]);
        for (const n of novels ?? []) {
          results.push({
            pluginId: p.id,
            pluginName: p.name,
            id: `${p.id}::${n.path ?? n.url ?? n.name}`,
            path: n.path ?? n.url ?? null,
            title: n.name ?? n.title ?? 'Untitled',
            cover: n.cover ?? n.coverUrl ?? null,
          });
        }
      } catch (e) {
        errors.push({ pluginId: p.id, pluginName: p.name, message: e?.message ?? String(e) });
      }
    }),
  );
  return { results, errors };
}

const dbHandlers = Object.fromEntries(
  Object.entries(db)
    .filter(([name, fn]) => typeof fn === 'function' && name !== 'getDb')
    .map(([name, fn]) => [`db:${name}`, fn]),
);

let mainWindow = null;

const handlers = {
  ...dbHandlers,
  'plugins:hostInfo': pluginService.hostInfo,
  'plugins:listInstalled': pluginService.listInstalled,
  'plugins:fetchRepository': pluginService.fetchRepository,
  'plugins:install': pluginService.install,
  'plugins:uninstall': pluginService.uninstall,
  'plugins:popular': pluginService.popular,
  'plugins:latest': pluginService.latest,
  'plugins:search': pluginService.search,
  'plugins:novel': pluginService.novel,
  'plugins:chapter': pluginService.chapter,
  'downloads:getQueue': downloadService.getSnapshot,
  'downloads:getSnapshot': downloadService.getSnapshot,
  'downloads:enqueue': downloadService.enqueue,
  'downloads:cancel': downloadService.cancel,
  'downloads:cancelAll': downloadService.cancelAll,
  'downloads:pause': downloadService.pause,
  'downloads:resume': downloadService.resume,
  'downloads:retryFailed': downloadService.retryFailed,
  'downloads:clearCompleted': downloadService.clearCompleted,
  'downloads:clearFailed': downloadService.clearFailed,
  'downloads:removeEntry': downloadService.removeEntry,
  'downloads:removeByNovel': downloadService.removeByNovel,
  'updates:run': () => libraryUpdate.runLibraryUpdate(),
  'updates:cancel': () => libraryUpdate.cancelLibraryUpdate(),
  'updates:summary': () => libraryUpdate.loadPersistedSummary(),
  'updates:maybeRunAuto': async () => {
    const p = await prefs.get();
    return libraryUpdate.maybeRunAutoUpdate(p?.autoUpdateInterval);
  },
  'search:global': globalSearch,
  'prefs:invalidate': async () => {
    prefs.invalidate();
    discord.refresh();
    return true;
  },
  'discord:status': () => discord.status(),
  'session:start': session.start,
  'session:chapter': session.chapter,
  'session:progress': session.progress,
  'session:end': session.end,
  'session:screen': session.screen,
  'app:info': () => ({
    name: 'Honya Desktop',
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    dataDir: DATA_DIR,
    platform: process.platform,
  }),
  'app:importBackup': () => importBackup(BrowserWindow.getAllWindows()[0]),
  'app:exportBackup': () => exportBackup(BrowserWindow.getAllWindows()[0]),
  'app:storageStats': async () => {
    const [stats, downloaded] = await Promise.all([db.getStorageStats(), db.getDownloadedBytes()]);
    return { ...stats, ...downloaded };
  },
  'app:openExternal': (url) => {
    if (!/^https?:\/\//i.test(String(url))) throw new Error('Only http(s) links can be opened');
    return shell.openExternal(url);
  },
};

const isTrustedSender = (e) => {
  const url = e.senderFrame?.url ?? '';
  return DEV_URL ? url.startsWith(DEV_URL) : url.startsWith('file://');
};

ipcMain.handle('honya:invoke', async (e, channel, args = []) => {
  if (!isTrustedSender(e)) throw new Error('Untrusted sender');
  const handler = handlers[channel];
  if (!handler) throw new Error(`Unknown channel "${channel}"`);
  return handler(...args);
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'Honya',
    backgroundColor: '#101014',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    autoHideMenuBar: true,
    show: !SMOKE,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  // Renderer may only navigate within the app; external links open in the OS browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!(DEV_URL && url.startsWith(DEV_URL)) && !url.startsWith('file://')) e.preventDefault();
  });

  if (DEV_URL) mainWindow.loadURL(DEV_URL);
  else mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));

  if (SMOKE) runSmoke(mainWindow);
}

// Headless self-test: visit every route, collect renderer errors, save screenshots, exit with a status code.
async function runSmoke(win) {
  const outDir = process.env.HONYA_SMOKE_OUT || path.join(DATA_DIR, 'smoke');
  fs.mkdirSync(outDir, { recursive: true });
  const errors = [];
  win.webContents.on('console-message', (e) => {
    const level = e.level ?? e;
    if (level === 'error' || level === 3) errors.push(e.message ?? '');
  });
  win.webContents.on('render-process-gone', (_e, d) => errors.push(`renderer gone: ${d.reason}`));
  win.webContents.on('did-fail-load', (_e, code, desc) => errors.push(`load failed ${code} ${desc}`));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const routes = (process.env.HONYA_SMOKE_ROUTES || 'library,updates,history,catalogs,downloads,settings').split(',');
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  await wait(1200);
  const report = {};
  if (process.env.HONYA_SMOKE_SCRIPT) {
    const script = fs.readFileSync(process.env.HONYA_SMOKE_SCRIPT, 'utf8');
    let out;
    try { out = await win.webContents.executeJavaScript(script); }
    catch (e) { out = { scriptError: String(e?.message ?? e) }; errors.push(`script: ${out.scriptError}`); }
    out = { ...out, bodyText: (await win.webContents.executeJavaScript('document.body.innerText.slice(0,500)')).replace(/\s+/g, ' ') };
    report.script = out;
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, 'script-final.png'), img.toPNG());
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ errors, report }, null, 2));
    console.log('SMOKE_RESULT', JSON.stringify({ errors, report }));
    return app.exit(errors.length ? 1 : 0);
  }
  for (const r of routes) {
    await win.webContents.executeJavaScript(`location.hash = '#/${r}'`);
    await wait(700);
    const text = await win.webContents.executeJavaScript('document.body.innerText.slice(0,400)');
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, `${r.replace(/\W+/g, '_')}.png`), img.toPNG());
    report[r] = text.replace(/\s+/g, ' ').slice(0, 160);
  }
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ errors, report }, null, 2));
  console.log('SMOKE_RESULT', JSON.stringify({ errors, report }));
  app.exit(errors.length ? 1 : 0);
}

app.whenReady().then(async () => {
  if (!gotLock) return; // a second instance is quitting; the first one keeps the database
  try {
    await db.initDatabase();
  } catch (e) {
    dialog.showErrorBox('Honya could not open its database', String(e?.stack ?? e));
    app.exit(1);
    return;
  }
  // The queue resumes whatever was persisted before the last exit (including rows demoted from
  // 'downloading'), exactly like the mobile module's initDownloadQueue().
  await downloadService.init().catch(() => {});
  downloadService.onChange((snapshot) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('honya:downloadState', snapshot);
  });
  const p = await prefs.get().catch(() => ({}));
  if (p?.autoUpdateInterval && p.autoUpdateInterval !== 'never') {
    libraryUpdate.maybeRunAutoUpdate(p.autoUpdateInterval).catch(() => {});
  }
  discord.refresh();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  session.end();
  discord.shutdown();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

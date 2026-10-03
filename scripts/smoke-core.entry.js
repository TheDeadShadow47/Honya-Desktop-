// Node-side smoke test of the main-process core (SQLite adapter + db module + plugin service).
import http from 'node:http';
import * as db from '../core/db/database.js';
import { createHost } from '../plugin-host/PluginHost.js';
import { createPluginService } from '../plugin-host/pluginService.js';
import { buildBackupPayload, restoreBackupPayload, validateBackupPayload, BackupError } from '../core/backup/backup.js';
import { DEFAULTS, pickSafePrefs } from '../core/settings/defaults.js';

const phase = process.argv[2];
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } console.log('ok  -', m); };

await db.initDatabase();

if (phase === 'write') {
  await db.upsertNovel({ id: 'demo::/n/1', pluginId: 'demo', path: '/n/1', title: 'Test Novel', author: 'A', genres: ['x', 'y'], inLibrary: true });
  await db.replaceChapters('demo::/n/1', [1, 2, 3].map((i) => ({ id: `demo::/n/1::/c/${i}`, path: `/c/${i}`, name: `Chapter ${i}` })));
  await db.saveChapterText('demo::/n/1::/c/1', 'Hello offline world');
  await db.saveChapterProgress('demo::/n/1::/c/1', 0.6);
  await db.markChapterRead('demo::/n/1::/c/2', true);
  const lib = await db.getLibrary();
  ok(lib.length === 1 && lib[0].totalChapters === 3 && lib[0].readChapters === 1, 'library counts (3 chapters, 1 read)');
  ok(Array.isArray(lib[0].genres) && lib[0].genres[1] === 'y', 'genres JSON round-trip');

  // Plugin service with a fake LNReader-style bundle served from a local server.
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url.startsWith('/chapter')) res.end('<div id="c"><p>Para one</p><p>Para two</p></div>');
    else res.end('<ul><li><a href="/n/9">Nine</a></li></ul>');
  }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const code = `
    const cheerio = require('cheerio'); const { fetchApi } = require('@libs/fetch'); const { NovelStatus } = require('@libs/novelStatus');
    class P { id='demo'; name='Demo'; version='1.0.0'; site='${base}';
      async popularNovels(page){ const $=cheerio.load(await (await fetchApi('${base}/list')).text()); return $('li a').map((i,a)=>({name:$(a).text(),path:$(a).attr('href'),cover:''})).get(); }
      async searchNovels(q){ return [{name:'S:'+q,path:'/s',cover:''}]; }
      async parseNovel(p){ return {path:p,name:'N',status:NovelStatus.Ongoing,chapters:[{name:'C1',path:'/chapter/1'}]}; }
      async parseChapter(p){ const $=cheerio.load(await (await fetchApi('${base}'+p)).text()); return $('#c').html(); } }
    exports.default = new P();`;
  const svc = createPluginService({ db, host: createHost() });
  await svc.installFromCode({ id: 'demo', name: 'Demo', version: '1.0.0', lang: 'en' }, code);
  ok((await svc.listInstalled()).length === 1 && !('code' in (await svc.listInstalled())[0]), 'plugin installed; code not exposed in listing');
  const pop = await svc.popular('demo');
  ok(pop[0]?.name === 'Nine', 'plugin popular: cheerio + @libs/fetch over network');
  ok((await svc.search('demo', 'abc'))[0].name === 'S:abc', 'plugin search');
  ok((await svc.novel('demo', '/n/1')).status === 'Ongoing', 'plugin novel (NovelStatus shim)');
  ok(/Para two/.test(await svc.chapter('demo', '/chapter/1')), 'plugin chapter content');
  let missing = false; try { await svc.popular('nope'); } catch { missing = true; }
  ok(missing, 'unknown plugin rejects cleanly');
  server.close();

  // Backup: build a real payload, then prove restore rebuilds library state from it alone.
  await db.setKV('prefs', { theme: 'dark', repositories: ['https://example.test/repo.json'] });
  await db.setKV('chapterPrefs', { 'demo::/n/1': { sortKey: 'numberDesc' } });
  await db.addBookmark({ id: 'demo::/n/1::/c/1::0', novelId: 'demo::/n/1', chapterId: 'demo::/n/1::/c/1', paragraph: 0, snippet: 'Hello' });
  const payload = await buildBackupPayload(db, { appVersion: '9.9.9' });
  ok(payload.format === 'honya-backup' && payload.version === 1, 'backup envelope');
  ok(payload.data.novels.length === 1 && payload.data.novels[0].chapters.length === 3, 'backup carries library + chapters');
  ok(payload.data.novels[0].chapters.every((c) => !('downloadedText' in c)), 'backup excludes downloaded text');
  ok(payload.data.extensions.some((e) => e.id === 'demo' && !('code' in e)), 'backup carries plugin metadata but no source');
  ok(payload.data.prefs.theme === 'dark' && payload.data.repositories.length === 1, 'backup carries prefs + repositories');

  // Simulate drift rather than deleting: the user drops the novel from the library and clears prefs,
  // but keeps their offline copy. An import must restore membership without clobbering local bodies.
  await db.setKV('prefs', {});
  await db.setKV('chapterPrefs', {});
  await db.setInLibrary('demo::/n/1', false);
  await db.removeBookmark('demo::/n/1::/c/1::0');
  ok((await db.getLibrary()).length === 0, 'novel dropped from library before restore');
  ok((await db.getChapter('demo::/n/1::/c/1')).downloadedText === 'Hello offline world', 'offline copy still local before restore');

  const meta = await restoreBackupPayload(db, JSON.parse(JSON.stringify(payload)), { defaults: DEFAULTS });
  ok(meta.novelCount === 1 && meta.chapterCount === 3, 'restore meta reports counts');
  const restored = await db.getLibrary();
  ok(restored.length === 1 && restored[0].title === 'Test Novel' && restored[0].inLibrary, 'library membership restored from backup');
  ok((await db.getChapters('demo::/n/1')).length === 3, 'chapters restored from backup');
  ok((await db.getChapter('demo::/n/1::/c/1')).downloadedText === 'Hello offline world', 'offline text survives import');
  ok((await db.getKV('prefs')).theme === 'dark', 'prefs restored from backup');
  ok((await db.getKV('chapterPrefs'))['demo::/n/1']?.sortKey === 'numberDesc', 'chapter prefs restored');

  let rejected = 0;
  try { await restoreBackupPayload(db, { format: 'something-else', version: 1, data: {} }, { defaults: DEFAULTS }); } catch (e) { rejected = e instanceof BackupError ? 1 : 0; }
  ok(rejected === 1, 'foreign backup format rejected');
  let tooNew = 0;
  try { await restoreBackupPayload(db, { ...payload, version: 99 }, { defaults: DEFAULTS }); } catch (e) { tooNew = e instanceof BackupError ? 1 : 0; }
  ok(tooNew === 1, 'newer backup version rejected');
  const cleaned = validateBackupPayload({ ...payload, data: { ...payload.data, novels: [{ id: 7 }, { id: 'ok::1', title: 'Keep' }], repositories: ['javascript:alert(1)'] } });
  ok(cleaned.novels.length === 1 && cleaned.novels[0].title === 'Keep' && cleaned.repositories.length === 0, 'malformed entries dropped, bad repos rejected');

  // prefs allow-list: unknown keys and wrong types from an untrusted file must not land
  const safe = pickSafePrefs({ theme: 'dark', gridColumns: 3, bogus: 1, notificationsEnabled: 'yes', reader: { fontSize: 22, junk: true } });
  ok(safe.theme === 'dark' && safe.gridColumns === 3 && safe.reader.fontSize === 22, 'known keys with matching types accepted');
  ok(!('bogus' in safe) && !('notificationsEnabled' in safe) && !('junk' in safe.reader), 'unknown keys and wrong types rejected');
  await restoreBackupPayload(db, { ...payload, data: { ...payload.data, prefs: { bogus: 1, theme: 'light' } } }, { defaults: DEFAULTS });
  const afterJunk = await db.getKV('prefs');
  ok(!('bogus' in afterJunk) && afterJunk.theme === 'light' && afterJunk.reader.fontSize === DEFAULTS.reader.fontSize, 'junk prefs dropped, defaults filled in');
} else {
  const lib = await db.getLibrary();
  ok(lib.length === 1 && lib[0].title === 'Test Novel', 'library persisted after restart');
  const ch = await db.getChapter('demo::/n/1::/c/1');
  ok(ch.downloadedText === 'Hello offline world' && Math.abs(ch.progress - 0.6) < 1e-9, 'downloaded text + progress persisted');
  ok((await db.getPlugins()).length === 1, 'installed plugin persisted');
  ok((await db.getHistory()).length >= 1, 'history reflects reads');
  const stats = await db.getStorageStats();
  ok(stats.novels === 1 && stats.chapters === 3 && stats.downloaded === 1 && stats.plugins === 1, 'storage stats counts match the database');
}
process.exit(0);

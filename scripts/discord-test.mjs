// Protocol + behaviour test for the Discord integration against a fake Discord IPC server (no Discord needed).
// Run: node scripts/discord-test.mjs
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'honya-discord-'));
process.env.XDG_RUNTIME_DIR = dir;
process.env.TMPDIR = dir;
const { createDiscordManager } = await import('../integrations/discord/index.js');
const { buildActivity, chapterLabel, buildScreenActivity } = await import('../integrations/discord/activity.js');
const { ipcPaths, DiscordRpc } = await import('../integrations/discord/rpc.js');

const frame = (op, obj) => {
  const b = Buffer.from(JSON.stringify(obj));
  const h = Buffer.alloc(8);
  h.writeInt32LE(op, 0);
  h.writeInt32LE(b.length, 4);
  return Buffer.concat([h, b]);
};

function fakeDiscord() {
  const log = { handshakes: [], activities: [] };
  const sockets = new Set();
  // Windows cannot listen on a filesystem path, and the default pipe names belong to a real Discord client. Use a
  // private named pipe there and point the test managers at it; on macOS/Linux keep the unix socket in the temp dir.
  const listenPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\honya-discord-test-${process.pid}-${Date.now()}`
      : path.join(dir, 'discord-ipc-0');
  const server = net.createServer((s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
    s.on('error', () => {});
    let buf = Buffer.alloc(0);
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 8) {
        const op = buf.readInt32LE(0), len = buf.readInt32LE(4);
        if (buf.length < 8 + len) return;
        const msg = JSON.parse(buf.subarray(8, 8 + len).toString() || '{}');
        buf = buf.subarray(8 + len);
        if (op === 0) {
          log.handshakes.push(msg);
          s.write(frame(1, { cmd: 'DISPATCH', evt: 'READY', data: { v: 1 } }));
        } else if (op === 1 && msg.cmd === 'SET_ACTIVITY') {
          log.activities.push(msg.args.activity ?? null);
          s.write(frame(1, { cmd: 'SET_ACTIVITY', evt: null, data: {}, nonce: msg.nonce }));
        }
      }
    });
  });
  return {
    log,
    path: listenPath,
    start: () => new Promise((r) => server.listen(listenPath, r)),
    stop: () =>
      new Promise((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => {
          if (process.platform !== 'win32') {
            try {
              fs.unlinkSync(listenPath);
            } catch {}
          }
          r();
        });
      }),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return; await sleep(20); } throw new Error(`timeout: ${what}`); };
let n = 0;
const ok = (name) => console.log(`ok ${++n} - ${name}`);

// ---- pure builder ----
assert.equal(chapterLabel({ name: 'Chapter 86: Fate', number: 86 }), 'Chapter 86: Fate'); ok('name containing the number is used as-is');
assert.equal(chapterLabel({ name: 'Prologue', number: 1 }), 'Chapter 1 · Prologue'); ok('number is prefixed when the title lacks it');
assert.equal(chapterLabel({ name: undefined, number: 86 }), 'Chapter 86'); ok('number only');
assert.equal(chapterLabel({ name: 'undefined', number: 0 }), ''); ok('placeholder strings and 0 are dropped');
const bad = buildActivity({ novel: { title: null }, chapter: { name: '[object Object]', number: 'null' } }, {}, undefined);
assert.equal(bad.details, 'Reading a novel');
assert.ok(!('state' in bad) && !('timestamps' in bad)); assert.ok(!JSON.stringify(bad).match(/undefined|null|Unknown|\[object/)); ok('no undefined/null leaks into the activity');
const hidden = buildActivity({ novel: { title: 'X Novel' }, chapter: { number: 5 } }, { showTitle: false, showChapter: false, showTime: false }, 1000);
assert.deepEqual([hidden.details, hidden.state, hidden.timestamps], ['Reading a novel', undefined, undefined]); ok('privacy toggles are respected');
assert.equal(ipcPaths('win32', {})[0], '\\\\?\\pipe\\discord-ipc-0'); ok('Windows named pipe path');


// ---- novel cover as the large image ----
{
  const HONYA = 'honya';
  const img = (cover, opts) =>
    buildActivity({ novel: { title: 'X', cover }, chapter: { number: 1 } }, opts, 1000).assets.large_image;
  const COVER = 'https://cdn.example.com/covers/123.webp';
  assert.equal(img(COVER), COVER);
  assert.equal(img('https://images.example.co.uk/a.jpg?w=300&h=400'), 'https://images.example.co.uk/a.jpg?w=300&h=400');
  assert.equal(img('https://8.8.8.8/a.jpg'), 'https://8.8.8.8/a.jpg');
  assert.equal(img('https://[2606:4700:4700::1111]/a.jpg'), 'https://[2606:4700:4700::1111]/a.jpg');
  ok('a public HTTPS cover becomes large_image (with query, IPv4 and public IPv6)');

  // Regression: the Shadow Slave cover is a public HTTPS URL and must be passed through unchanged. This covers Honya's
  // validator and activity payload only; Discord fetches the image with its own servers, which novelfire can still block
  // with its Cloudflare challenge. Bypassing that would need a proxy or rehosting, both deliberately not done here.
  const SHADOW = 'https://novelfire.net/server-1/shadow-slave.jpg';
  assert.equal(img(SHADOW), SHADOW);
  ok('Shadow Slave cover (novelfire.net/server-1/shadow-slave.jpg) becomes assets.large_image');

  for (const junk of [undefined, null, '', '   ', 42, {}, [], 'not a url', 'https://', 'https://exa mple.com/a.jpg']) {
    assert.equal(img(junk), HONYA, `expected fallback for ${JSON.stringify(junk)}`);
  }
  for (const rel of ['/covers/1.jpg', 'covers/1.jpg', './1.jpg', '//cdn.example.com/a.jpg']) {
    assert.equal(img(rel), HONYA, `expected fallback for ${rel}`);
  }
  ok('missing, empty, non-string, malformed and relative covers fall back to honya');

  const prefix = 'https://cdn.example.com/';
  assert.equal(img(prefix + 'a'.repeat(313 - prefix.length)), prefix + 'a'.repeat(313 - prefix.length));
  assert.equal(img(prefix + 'a'.repeat(314 - prefix.length)), HONYA);
  ok('313-character cover is accepted, 314 characters is not');

  for (const bad of [
    'http://cdn.example.com/a.jpg',
    'file:///C:/covers/1.jpg',
    'data:image/png;base64,iVBORw0KGgo=',
    'ftp://cdn.example.com/a.jpg',
  ]) {
    assert.equal(img(bad), HONYA, `expected fallback for ${bad}`);
  }
  ok('http, file, data and other schemes fall back to honya');

  for (const cred of [
    'https://user:pw@cdn.example.com/a.jpg',
    'https://user@cdn.example.com/a.jpg',
    'https://:pw@cdn.example.com/a.jpg',
  ]) {
    assert.equal(img(cred), HONYA, `expected fallback for ${cred}`);
  }
  ok('covers with embedded credentials fall back to honya');

  for (const local of [
    'https://localhost/a.jpg',
    'https://LOCALHOST/a.jpg',
    'https://localhost./a.jpg',
    'https://foo.localhost/a.jpg',
    'https://nas.local/a.jpg',
    'https://127.0.0.1/a.jpg',
    'https://127.1.2.3/a.jpg',
    'https://0.0.0.0/a.jpg',
    'https://10.1.2.3/a.jpg',
    'https://172.16.0.5/a.jpg',
    'https://172.31.255.255/a.jpg',
    'https://192.168.0.1/a.jpg',
    'https://169.254.1.1/a.jpg',
    'https://100.64.0.1/a.jpg',
    'https://[::1]/a.jpg',
    'https://[::]/a.jpg',
    'https://[fe80::1]/a.jpg',
    'https://[fc00::1]/a.jpg',
    'https://[fd12:3456::1]/a.jpg',
    'https://[::ffff:127.0.0.1]/a.jpg',
    'https://[::ffff:10.0.0.1]/a.jpg',
  ]) {
    assert.equal(img(local), HONYA, `expected fallback for ${local}`);
  }
  ok('localhost, .local, loopback, private/link-local IPv4 and private IPv6 fall back to honya');

  for (const publicish of [
    'https://10.example.com/a.jpg',
    'https://127.example.com/a.jpg',
    'https://192.168.example.com/a.jpg',
    'https://mylocal.com/a.jpg',
    'https://localhost.example.com/a.jpg',
    'https://notlocal.example/a.jpg',
  ]) {
    assert.equal(img(publicish), publicish, `public host ${publicish} must not be mistaken for private`);
  }
  ok('public hosts that merely look private are still accepted');

  assert.equal(img('https://github.com/LNReader/lnreader-plugins/blob/master/public/static/coverNotAvailable.webp?raw=true'), HONYA);
  assert.equal(img('https://raw.githubusercontent.com/LNReader/lnreader-plugins/master/public/static/coverNotAvailable.webp'), HONYA);
  assert.equal(img('https://github.com/LNReader/lnreader-plugins/blob/master/public/static/cover.webp?raw=true'), 'https://github.com/LNReader/lnreader-plugins/blob/master/public/static/cover.webp?raw=true');
  ok('the LNReader placeholder is skipped, but real covers on the same host are kept');

  const full = buildActivity({ novel: { title: 'X', cover: COVER }, chapter: { number: 1 } }, { showTitle: false }, 1000);
  assert.equal(full.assets.large_image, HONYA); ok('showTitle off: the cover is not sent either');
  assert.equal(img(COVER, { showTitle: true }), COVER); ok('showTitle on: the cover is sent');

  const leak = buildActivity(
    {
      novel: { id: 'plugin-secret-id', title: 'X', cover: COVER, summary: 'private blurb', path: '/srv/private' },
      chapter: { id: 'ch-1', name: 'Chapter 1', number: 1, url: 'https://source.example/ch/1', path: '/srv/x' },
    },
    {},
    1000,
  );
  const serialized = JSON.stringify(leak);
  assert.equal(serialized.match(/https:\/\//g).length, 1);
  assert.ok(serialized.includes(COVER));
  for (const secret of ['plugin-secret-id', 'ch-1', 'source.example', '/srv/', 'private blurb', 'chapter/1']) {
    assert.ok(!serialized.includes(secret), `activity leaked ${secret}`);
  }
  ok('only the validated cover URL reaches the activity: no ids, chapter URL, source URL or extra novel fields');

  assert.equal(buildScreenActivity({ name: 'novel', title: 'X', cover: COVER }, {}, 1000).assets.large_image, HONYA);
  ok('browsing presence keeps the honya asset (covers are a reading-only feature)');
}


// ---- browsing presence (screens outside the reader) ----
{
  const t0 = Date.now();
  assert.equal(buildScreenActivity({ name: 'library' }, {}, t0).details, 'Browsing the library');
  assert.equal(buildScreenActivity({ name: 'search' }, {}, t0).details, 'Searching for a novel');
  assert.equal(buildScreenActivity({ name: 'browse' }, {}, t0).details, 'Browsing a source');
  assert.equal(buildScreenActivity({ name: 'catalogs' }, {}, t0).details, 'Browsing catalogs');
  assert.equal(buildScreenActivity({ name: 'updates' }, {}, t0).details, 'Checking for new chapters');
  assert.equal(buildScreenActivity({ name: 'history' }, {}, t0).details, 'Looking through reading history');
  assert.equal(buildScreenActivity({ name: 'downloads' }, {}, t0).details, 'Managing downloads');
  assert.equal(buildScreenActivity({ name: 'settings' }, {}, t0).details, 'Adjusting settings'); ok('every screen has a presence line');
  assert.equal(buildScreenActivity({ name: 'novel', title: 'Lord of the Mysteries' }, {}, t0).details, 'Viewing Lord of the Mysteries');
  assert.equal(buildScreenActivity({ name: 'novel', title: 'Lord of the Mysteries' }, { showTitle: false }, t0).details, 'Viewing a novel');
  assert.equal(buildScreenActivity({ name: 'novel' }, {}, t0).details, 'Viewing a novel'); ok('novel page shows the title only when allowed');
  assert.equal(buildScreenActivity({ name: 'library', secret: 'x', query: 'my private search' }, {}, t0).details, 'Browsing the library');
  assert.ok(!JSON.stringify(buildScreenActivity({ name: 'search', query: 'my private search', path: '/a' }, {}, t0)).includes('private'));
  assert.equal(buildScreenActivity({ name: 'nope' }, {}, t0), null);
  assert.ok(!('timestamps' in buildScreenActivity({ name: 'library' }, { showTime: false }, t0))); ok('no search text leaks, unknown screens ignored, timer toggle respected');
}

// ---- manager vs fake Discord ----
const fake = fakeDiscord();
// Every manager dials the fake server explicitly, so a real Discord client is never contacted by this test.
const fakeRpc = () => new DiscordRpc({ paths: [fake.path] });
let prefs = { discord: { enabled: true, showTitle: true, showChapter: true, showTime: true } };
const mgr = createDiscordManager({
  getPrefs: async () => prefs,
  clientId: '123456789012345678',
  createRpc: fakeRpc,
  timing: { debounce: 30, minInterval: 60, endGrace: 150, retry: [80, 80] },
  log: () => {},
});

mgr.refresh();
await sleep(150);
assert.equal(mgr.status().state, 'waiting');
mgr.update({ novel: { title: 'Renegade Immortal' }, chapter: { name: 'Chapter 85', number: 85 } }); // must not throw
ok('Discord not running: no crash, status waiting');

await fake.start();
await until(() => fake.log.activities.length === 1, 'presence after Discord starts later');
assert.equal(fake.log.handshakes[0].client_id, '123456789012345678');
assert.equal(fake.log.activities[0].details, 'Reading Renegade Immortal');
assert.equal(fake.log.activities[0].state, 'Chapter 85');
assert.ok(fake.log.activities[0].timestamps.start > 1e9);
assert.equal(mgr.status().state, 'connected'); ok('Discord started after Honya: connects and shows novel + chapter');
const t0 = fake.log.activities[0].timestamps.start;

// chapter navigation = end() immediately followed by update() (what Reader does) -> no clear, timer kept
mgr.end(); await sleep(20);
mgr.update({ novel: { title: 'Renegade Immortal' }, chapter: { name: 'Chapter 86', number: 86 } });
await until(() => fake.log.activities.length === 2, 'chapter update');
assert.equal(fake.log.activities[1].state, 'Chapter 86');
assert.equal(fake.log.activities[1].timestamps.start, t0);
assert.ok(fake.log.activities.every((a) => a !== null)); ok('chapter change updates presence, no flicker, elapsed time preserved');

mgr.update({ novel: { title: 'Lord of the Mysteries' }, chapter: { name: 'Chapter 120', number: 120 } });
await until(() => fake.log.activities.length === 3, 'novel update');
assert.equal(fake.log.activities[2].details, 'Reading Lord of the Mysteries');
assert.equal(fake.log.activities[2].state, 'Chapter 120'); ok('changing novel updates presence');

mgr.end();
await until(() => fake.log.activities.length === 4, 'clear after leaving reader');
assert.equal(fake.log.activities[3], null); ok('leaving the reader clears presence');

// Discord closes while Honya runs, then comes back
mgr.update({ novel: { title: 'Lord of the Mysteries' }, chapter: { name: 'Chapter 121', number: 121 } });
await until(() => fake.log.activities.length === 5, 'presence again');
await fake.stop();
await until(() => mgr.status().state === 'waiting', 'detect Discord closing');
const before = fake.log.activities.length;
await fake.start();
await until(() => fake.log.activities.length === before + 1, 'reconnect + resend');
assert.equal(fake.log.activities.at(-1).state, 'Chapter 121'); ok('Discord closing/restarting: reconnects and restores presence');

// Disabling in Settings clears and disconnects
prefs = { discord: { ...prefs.discord, enabled: false } };
mgr.refresh();
await until(() => mgr.status().state === 'off', 'disabled');
ok('disabling stops the integration');


// ---- browsing presence through the manager ----
let prefs2 = { discord: { enabled: true, showTitle: true, showChapter: true, showTime: true, showBrowsing: true } };
const mgr2 = createDiscordManager({
  getPrefs: async () => prefs2, clientId: '123456789012345678', createRpc: fakeRpc,
  timing: { debounce: 30, minInterval: 60, endGrace: 150, retry: [80, 80] }, log: () => {},
});
const A = fake.log.activities;
let base = A.length;
const nextAct = async (what) => { base += 1; await until(() => A.length === base, what); return A[base - 1]; };
mgr2.refresh();
mgr2.screen({ name: 'library' });
let a = await nextAct('library presence');
assert.equal(a.details, 'Browsing the library'); assert.ok(a.timestamps.start > 1e9); ok('browsing the library shows "Browsing the library"');
const browseT0 = a.timestamps.start;
mgr2.screen({ name: 'search' });
a = await nextAct('search presence'); assert.equal(a.details, 'Searching for a novel'); ok('searching shows "Searching for a novel"');
mgr2.screen({ name: 'novel', title: 'Lord of the Mysteries' });
a = await nextAct('novel presence');
assert.equal(a.details, 'Viewing Lord of the Mysteries'); assert.equal(a.timestamps.start, browseT0); ok('novel page shows its title; the browsing timer is kept across screens');
mgr2.update({ novel: { title: 'Renegade Immortal' }, chapter: { name: 'Chapter 85', number: 85 } });
a = await nextAct('reading presence'); assert.equal(a.details, 'Reading Renegade Immortal'); assert.equal(a.state, 'Chapter 85'); ok('opening the reader switches to reading presence');
mgr2.end(); await sleep(20); mgr2.screen({ name: 'library' });
a = await nextAct('back to library'); assert.equal(a.details, 'Browsing the library');
assert.ok(A.slice(base - 2).every((x) => x !== null)); ok('closing the reader goes straight to browsing (no grace delay, no blank gap)');
mgr2.update({ novel: { title: 'Renegade Immortal' }, chapter: { name: 'Chapter 86', number: 86 } });
await nextAct('reading again');
mgr2.end(); // no screen event (e.g. window state lost): after the grace period it falls back to the last screen, not to nothing
a = await nextAct('fallback after grace'); assert.equal(a.details, 'Browsing the library'); ok('reader ended without a screen event: falls back to the last known screen');
prefs2 = { discord: { ...prefs2.discord, showBrowsing: false } };
mgr2.refresh();
a = await nextAct('cleared when browsing is off'); assert.equal(a, null); ok('"show what I do outside the reader" off: browsing presence is cleared');
mgr2.screen({ name: 'settings' }); await sleep(250);
assert.equal(A.length, base); ok('...and stays hidden while navigating');
mgr2.update({ novel: { title: 'Renegade Immortal' }, chapter: { name: 'Chapter 87', number: 87 } });
a = await nextAct('reading still shown'); assert.equal(a.details, 'Reading Renegade Immortal'); ok('reading presence still works with browsing switched off');
mgr2.shutdown();

// ---- novel cover through the manager ----
{
  let prefs3 = { discord: { enabled: true, showTitle: true, showChapter: true, showTime: true } };
  const mgr3 = createDiscordManager({
    getPrefs: async () => prefs3,
    clientId: '123456789012345678',
    createRpc: fakeRpc,
    timing: { debounce: 30, minInterval: 60, endGrace: 150, retry: [80, 80] },
    log: () => {},
  });
  const acts = fake.log.activities;
  let b = acts.length;
  const nextAct3 = async (what) => {
    b += 1;
    await until(() => acts.length === b, what);
    return acts[b - 1];
  };
  const coverA = 'https://cdn.example.com/covers/a.webp';
  const coverB = 'https://cdn.example.com/covers/b.webp';

  mgr3.refresh();
  mgr3.update({
    novel: { id: 'plugin-a', title: 'Novel A', cover: coverA, summary: 'private' },
    chapter: { id: 'ch-a1', name: 'Chapter 1', number: 1, url: 'https://source.example/novel-a/1' },
  });
  let act = await nextAct3('cover presence A');
  assert.equal(act.details, 'Reading Novel A');
  assert.equal(act.state, 'Chapter 1');
  assert.equal(act.assets.large_image, coverA);
  const once = JSON.stringify(act);
  assert.ok(!once.includes('plugin-a') && !once.includes('ch-a1') && !once.includes('source.example') && !once.includes('private'));
  ok('reading a novel publishes its cover as large_image, and nothing else');

  mgr3.update({ novel: { title: 'Novel B', cover: coverB }, chapter: { name: 'Chapter 2', number: 2 } });
  act = await nextAct3('cover presence B');
  assert.equal(act.assets.large_image, coverB);
  ok('switching novels replaces the previous cover');

  const beforeDup = acts.length;
  mgr3.update({ novel: { title: 'Novel B', cover: coverB }, chapter: { name: 'Chapter 2', number: 2 } });
  await sleep(250);
  assert.equal(acts.length, beforeDup);
  ok('an identical activity (same cover) is still deduplicated');

  prefs3 = { discord: { ...prefs3.discord, showTitle: false } };
  mgr3.refresh();
  act = await nextAct3('cover hidden when title sharing is off');
  assert.equal(act.assets.large_image, 'honya');
  assert.equal(act.details, 'Reading a novel');
  ok('showTitle off: the cover URL is not published');

  prefs3 = { discord: { ...prefs3.discord, showTitle: true, enabled: false } };
  mgr3.refresh();
  await until(() => mgr3.status().state === 'off', 'cover manager disabled');
  const beforeOff = acts.length;
  mgr3.update({ novel: { title: 'Novel C', cover: 'https://cdn.example.com/covers/c.webp' }, chapter: { number: 3 } });
  await sleep(300);
  assert.equal(acts.length, beforeOff);
  ok('discord.enabled false: no activity is published, cover or otherwise');

  mgr3.shutdown();
}

mgr.shutdown();
await fake.stop();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${n} checks passed`);
process.exit(0);

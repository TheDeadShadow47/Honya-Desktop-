// Renderer-side script for scripts/e2e-reader.mjs (the runner prepends `const PHASE = '...'`).
// Drives the REAL app UI: continuous scrolling across chapter boundaries, dedupe, progress save/restore, memory
// bounding, online fetch + error + retry, offline-first, navigation, popover settings, legacy (non-continuous) mode.
// NB the test window is hidden, so the browser does not emit scroll events by itself: we dispatch them explicitly.
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, label, ms = 15000) => {
    const start = Date.now();
    while (Date.now() - start < ms) { const v = await fn(); if (v) return v; await wait(60); }
    throw new Error('timeout: ' + label);
  };
  const inv = (c, ...a) => window.honya.invoke(c, ...a);
  const out = { phase: PHASE, checks: [] };
  const check = (name, ok, detail) => out.checks.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  const enc = encodeURIComponent;
  const sc = () => document.querySelector('.reader-scroll');
  const segEl = (id) => [...document.querySelectorAll('.reader-seg')].find((e) => e.dataset.seg === id);
  const segIds = () => [...document.querySelectorAll('.reader-seg')].map((e) => e.dataset.seg);
  const fire = async (y, ms = 150) => { const s = sc(); if (y != null) s.scrollTop = y; s.dispatchEvent(new Event('scroll')); await wait(ms); };
  const toEnd = (margin = 300) => fire(sc().scrollHeight - sc().clientHeight - margin);
  const barBtn = (label) => [...document.querySelectorAll('.reader-bar .icon-btn')].find((b) => b.getAttribute('aria-label') === label);
  const key = (k) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  const open = async (id) => {
    location.hash = '#/reader/' + enc(id);
    await waitFor(() => segEl(id)?.querySelector('p'), 'reader opens ' + id);
    await wait(250);
  };
  const title = () => document.querySelector('.reader-title')?.textContent ?? '';
  const hashId = () => decodeURIComponent(location.hash.split('/')[2] ?? '');
  const segP = (id) => { const s = sc(), w = segEl(id); const span = w.offsetHeight - s.clientHeight; return span <= 1 ? 1 : Math.max(0, Math.min(1, (s.scrollTop - w.offsetTop) / span)); };
  const setVal = (el, v) => {
    Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  };
  const calls = async () => { const t = await inv('plugins:chapter', 'synth', '/__calls'); return JSON.parse(String(t).match(/\{.*\}/s)[0]); };
  const LOREM = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam quis nostrud.';
  const body = (tag, n) => Array.from({ length: n }, (_, i) => `${tag} paragraph ${i + 1}. ${LOREM}`).join('\n\n');
  const id = (novel, path) => `synth::${novel}::${path}`;

  try {
    if (PHASE === 'seed') {
      const PLUGIN = `
        const state = { calls: {} };
        const html = (tag, n) => { let s = ''; for (let i = 1; i <= n; i++) s += '<p>' + tag + ' paragraph ' + i + '. ${LOREM}</p>'; return s; };
        const plugin = {
          id: 'synth', name: 'Synthetic', version: '1.0.0', site: 'https://synthetic.invalid',
          popularNovels: async () => [], parseNovel: async (p) => ({ path: p, name: 'x', chapters: [] }),
          parseChapter: async (path) => {
            state.calls[path] = (state.calls[path] || 0) + 1;
            if (path === '/__calls') return '<p>' + JSON.stringify(state.calls) + '</p>';
            if (path === '/flaky' && state.calls[path] === 1) throw new Error('Simulated source outage');
            if (path === '/dead') throw new Error('Source is down');
            return html('online' + path.replace('/', '-'), 25);
          },
        };`;
      await inv('db:savePlugin', { id: 'synth', name: 'Synthetic', version: '1.0.0', lang: 'en', site: 'https://synthetic.invalid', code: PLUGIN });
      const mk = async (nid, ttl, items) => {
        await inv('db:upsertNovel', { id: `synth::${nid}`, pluginId: 'synth', path: `/${nid}`, title: ttl, author: 'Tester', genres: ['Test'], inLibrary: true });
        await inv('db:replaceChapters', `synth::${nid}`, items.map(([path, name]) => ({ path, name })));
      };
      // 14 offline chapters (45 long paragraphs each) -> long enough to need scrolling, many enough to exercise memory release
      await mk('offline', 'Offline Saga', Array.from({ length: 14 }, (_, i) => [`/off${i + 1}`, `Offline Chapter ${i + 1}`]));
      for (let i = 1; i <= 14; i++) await inv('db:saveChapterText', id('offline', `/off${i}`), body(`saga-${i}`, 45));
      await mk('online', 'Online Saga', [['/on1', 'Online Chapter 1'], ['/on2', 'Online Chapter 2'], ['/flaky', 'Online Chapter 3'], ['/on4', 'Online Chapter 4']]);
      await inv('db:saveChapterText', id('online', '/on2'), body('saga-on2', 25));
      await mk('dead', 'Dead Source Saga', [['/d1', 'Dead Chapter 1'], ['/dead', 'Dead Chapter 2']]);
      await mk('resume', 'Resume Saga', [['/r1', 'Resume Chapter 1'], ['/r2', 'Resume Chapter 2'], ['/r3', 'Resume Chapter 3']]);
      for (let i = 1; i <= 3; i++) await inv('db:saveChapterText', id('resume', `/r${i}`), body(`resume-${i}`, 45));
      const prefs = (await inv('db:getKV', 'prefs')) ?? {};
      await inv('db:setKV', 'prefs', { ...prefs, discord: { enabled: true, showTitle: true, showChapter: true, showTime: true } });
      check('seeded novels', (await inv('db:getLibrary')).length === 4);
    }

    if (PHASE === 'a') {
      const prefs = await inv('db:getKV', 'prefs');
      check('continuous scrolling is on by default (pref absent/true)', prefs?.reader?.continuous !== false);
      const off = (n) => id('offline', `/off${n}`);

      /* ---- 1. continuous scrolling across a boundary (offline text) ---- */
      await open(off(1));
      check('opens on chapter 1 with exactly one chapter loaded', segIds().length === 1, segIds().length);
      check('title bar shows chapter 1', title().includes('Offline Chapter 1'), title());
      await wait(5500); // let Discord publish "Chapter 1" before we move on
      await toEnd(400);
      for (let i = 0; i < 40; i++) sc().dispatchEvent(new Event('scroll')); // burst: must not double-append
      await waitFor(() => segIds().length >= 2, 'chapter 2 appended');
      await wait(600);
      check('next chapter appended near the end (no click needed)', segIds().includes(off(2)), segIds());
      check('burst of scroll events appended it exactly once', segIds().length === 2 && new Set(segIds()).size === 2, segIds());
      check('chapter order is 1,2', segIds().join('|') === [off(1), off(2)].join('|'));
      // the end of chapter 1 reaches the bottom, then ch.2 passes the probe line
      const w2 = segEl(off(2));
      await fire(w2.offsetTop - sc().clientHeight + 10);
      await fire(w2.offsetTop + 20);
      await wait(1300);
      check('title bar follows the active chapter (now chapter 2)', title().includes('Offline Chapter 2'), title());
      check('URL hash follows the active chapter without remounting the reader', hashId() === off(2), hashId());
      check('still the same single scroller (no remount): chapter 1 is still in the DOM', !!segEl(off(1)));
      const c1 = await inv('db:getChapter', off(1));
      check('chapter 1 finished by scrolling past it: saved as read, progress 1', c1.read === true && c1.progress === 1, `${c1.read}/${c1.progress}`);
      // partway into chapter 2
      const w2b = segEl(off(2));
      await fire(w2b.offsetTop + 0.5 * (w2b.offsetHeight - sc().clientHeight));
      await wait(1300);
      const c2 = await inv('db:getChapter', off(2));
      check('progress of the ACTIVE chapter saved (~0.5)', Math.abs(c2.progress - 0.5) < 0.06, c2.progress);
      check('chapter 2 not marked read yet', c2.read === false);
      await wait(5200); // Discord: chapter 2 published

      /* ---- 2. bookmark + search belong to the chapter they are in ---- */
      barBtn('Bookmark this paragraph').click();
      await waitFor(async () => (await inv('db:getBookmarks')).length === 1, 'bookmark saved');
      const bm = (await inv('db:getBookmarks'))[0];
      check('bookmark stored against chapter 2 (the one on screen)', bm.chapterId === off(2), bm.chapterId);
      check('bookmarked paragraph marked in chapter 2 only', document.querySelectorAll('.reader p.marked').length === 1 && !!segEl(off(2)).querySelector('p.marked'));
      barBtn('Search in chapter').click();
      await wait(200);
      setVal(document.querySelector('.reader-search input'), 'saga-2 paragraph 7.');
      await wait(500);
      check('in-chapter search finds the match in chapter 2', segEl(off(2)).querySelectorAll('mark').length === 1 && segEl(off(1)).querySelectorAll('mark').length === 0);
      document.querySelector('.reader-search .icon-btn[aria-label="Close"]').click();
      await wait(150);

      /* ---- 3. offline chapters never touch the source ---- */
      const k0 = await calls();
      check('offline chapters were read without calling the source plugin', !Object.keys(k0).some((p) => p.startsWith('/off')), JSON.stringify(k0));

      /* ---- 4. navigation: buttons, keys, jump ---- */
      await fire(segEl(off(2)).offsetTop + 30); await wait(300);
      barBtn('Next chapter').click();
      await waitFor(() => segEl(off(3)), 'chapter 3 present'); await wait(1200);
      check('Next button moves to the next chapter (relative to the ACTIVE one)', title().includes('Offline Chapter 3') || hashId() === off(3), title() + ' ' + hashId());
      key('k'); await wait(900);
      check('K goes back one chapter', title().includes('Offline Chapter 2'), title());
      key('j'); await wait(900);
      check('J goes forward one chapter', title().includes('Offline Chapter 3'), title());
      const preY = sc().scrollTop; key('ArrowDown');
      await wait(300);
      check('in continuous mode ArrowDown scrolls instead of jumping chapters', hashId() === off(3), hashId());
      key('Home'); await wait(300);
      check('Home goes to the top of the active chapter', Math.abs(sc().scrollTop - segEl(off(3)).offsetTop) < 3, `${sc().scrollTop} vs ${segEl(off(3)).offsetTop}`);
      const sel = document.querySelector('.reader-jump');
      check('jump list contains all 14 chapters', sel.options.length === 14, sel.options.length);
      setVal(sel, off(12));
      await waitFor(() => segEl(off(12)) && !segEl(off(2)), 'jump to far chapter reopens reader there');
      await wait(300);
      check('jump to a far chapter opens it fresh (window reset)', hashId() === off(12) && title().includes('Offline Chapter 12'), title());
      setVal(document.querySelector('.reader-jump-num'), '3');
      document.querySelector('.reader-jump-num').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await waitFor(() => segEl(off(3)) && !segEl(off(12)), 'jump by number');
      check('jump by chapter number works', hashId() === off(3), hashId());

      /* ---- 5. memory: read through all 14 chapters ---- */
      await open(off(3));
      let guard = 0;
      while (!segIds().includes(off(14)) && guard++ < 40) {
        const n = segIds().length;
        await toEnd(300);
        await fire(null, 50);
        await waitFor(() => segIds().length > n, 'append #' + guard, 8000).catch(() => {});
        await wait(120);
        await toEnd(300); // move onto the newly appended chapter
      }
      await wait(500);
      const ids = segIds();
      check('read continuously from chapter 3 to the last chapter', ids[0] === off(3) && ids[ids.length - 1] === off(14) && ids.length === 12, ids.length);
      check('no chapter was loaded twice', new Set(ids).size === ids.length);
      const mountedArticles = document.querySelectorAll('.reader article').length;
      const paras = document.querySelectorAll('.reader article p').length;
      check('DOM stays bounded: at most 5 chapters rendered of 12 loaded', mountedArticles <= 5 && mountedArticles >= 1, `${mountedArticles} articles / ${document.querySelectorAll('.reader-seg').length} segments`);
      check('paragraph nodes bounded (<= 5 x 45)', paras <= 225, paras);
      check('collapsed chapters keep a real height (scroll bar stays honest)', [...document.querySelectorAll('.reader-seg[data-collapsed]')].every((e) => e.offsetHeight > 500));
      out.heap = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) + ' MB' : 'n/a';
      const readN = (await inv('db:getChapters', 'synth::offline')).filter((c) => c.read).length;
      check('chapters read through are marked read (not just the last)', readN >= 10, readN);

      /* ---- 6. scrolling back up: stable position, text comes back ---- */
      let jumps = 0, worst = 0;
      for (let i = 0; i < 30; i++) {
        const probe = [...document.querySelectorAll('.reader article p')].find((p) => { const r = p.getBoundingClientRect(); return r.top > 200 && r.bottom < 600; });
        if (!probe) { await fire(sc().scrollTop - 600, 120); continue; }
        const before = probe.getBoundingClientRect().top;
        await fire(sc().scrollTop - 600, 160);
        if (probe.isConnected) { const d = Math.abs(probe.getBoundingClientRect().top - before - 600); worst = Math.max(worst, d); if (d > 3) jumps++; }
      }
      check('scrolling up through collapsing/re-hydrating chapters never shifts the page', jumps === 0, `worst deviation ${worst.toFixed(1)}px`);
      await fire(segEl(off(3)).offsetTop + 10); await wait(800);
      check('earlier chapter is readable again after returning (text re-loaded if it was released)', !!segEl(off(3)).querySelector('p'));

      /* ---- 7. online chapters, error, retry, no retry loop ---- */
      const on = (p) => id('online', p);
      await open(on('/on1'));
      check('online chapter text came from the source plugin', segEl(on('/on1')).querySelector('p').textContent.startsWith('online-on1 paragraph 1.'));
      await toEnd(300);
      await waitFor(() => segEl(on('/on2')), 'on2 appended');
      check('next chapter that is downloaded is read from SQLite', segEl(on('/on2')).querySelector('p')?.textContent.startsWith('saga-on2'));
      await toEnd(300);
      await waitFor(() => segEl(on('/flaky'))?.querySelector('.reader-error'), 'flaky chapter shows an error');
      check('failed chapter shows an inline error with a message', /Simulated source outage/.test(segEl(on('/flaky')).textContent));
      for (let i = 0; i < 12; i++) { await fire(sc().scrollTop, 80); }
      await wait(1200);
      check('a failed chapter is NOT retried in a loop (1 attempt after many scroll events)', (await calls())['/flaky'] === 1, JSON.stringify(await calls()));
      check('reading above the failed chapter is unaffected', !!segEl(on('/on1')).querySelector('p'));
      segEl(on('/flaky')).querySelector('.reader-error button').click();
      await waitFor(() => segEl(on('/flaky'))?.querySelector('p') && !segEl(on('/flaky')).querySelector('.reader-error'), 'retry succeeds');
      check('Retry loads the chapter (source recovered)', (await calls())['/flaky'] === 2);
      await toEnd(300);
      await waitFor(() => segEl(on('/on4')), 'on4 appended after retry');
      await toEnd(100); await wait(500);
      check('after the last chapter the end-of-book notice shows', /End of available chapters/.test(document.querySelector('.reader-tail')?.textContent ?? ''));
      check('online novel list is exactly 1,2,3,4 with no duplicates', segIds().join('|') === ['/on1', '/on2', '/flaky', '/on4'].map(on).join('|'), segIds());

      await open(id('dead', '/d1'));
      await toEnd(300);
      await waitFor(() => segEl(id('dead', '/dead'))?.querySelector('.reader-error'), 'dead source error');
      for (let i = 0; i < 10; i++) await fire(sc().scrollTop, 60);
      await wait(1000);
      check('permanently failing chapter: 1 attempt, no loop', (await calls())['/dead'] === 1);
      segEl(id('dead', '/dead')).querySelector('.reader-error button').click();
      await wait(1500);
      check('Retry on a still-dead source shows the error again (2nd attempt)', (await calls())['/dead'] === 2 && !!segEl(id('dead', '/dead')).querySelector('.reader-error'));

      /* ---- 8. reader popover settings ---- */
      await open(id('resume', '/r1'));
      barBtn('Reader settings').click();
      await waitFor(() => document.querySelector('.reader-pop'), 'popover');
      const font = document.querySelector('.reader-pop input[type=range]');
      setVal(font, '25');
      await wait(300);
      check('font size slider re-typesets the open chapter', document.querySelector('.reader article').style.fontSize === '25px', document.querySelector('.reader article').style.fontSize);
      const bg0 = getComputedStyle(document.querySelector('.reader')).backgroundColor;
      [...document.querySelectorAll('.reader-bgchip')].find((b) => !b.classList.contains('on')).click();
      await wait(300);
      check('background chip changes the reader background', getComputedStyle(document.querySelector('.reader')).backgroundColor !== bg0);
      check('popover offers the continuous-scrolling switch (checked)', !!document.querySelector('.reader-pop input[type=checkbox]')?.checked);
      await wait(700);
      check('typography change is persisted to preferences', (await inv('db:getKV', 'prefs')).reader.fontSize === 25);
      key('Escape'); await wait(200);
      check('Escape closes the popover first (stays in the reader)', !document.querySelector('.reader-pop') && location.hash.includes('reader'));

      /* ---- 9. a partly-read chapter, for the restart test ---- */
      await open(id('resume', '/r2'));
      const wr = segEl(id('resume', '/r2'));
      await fire(wr.offsetTop + 0.6 * (wr.offsetHeight - sc().clientHeight));
      await wait(1500);
      out.resumeProgress = (await inv('db:getChapter', id('resume', '/r2'))).progress;
      check('resume chapter progress saved before restart', Math.abs(out.resumeProgress - 0.6) < 0.06, out.resumeProgress);
      // leave quickly after a last scroll: progress must still be written (flush on exit)
      const wr2 = segEl(id('resume', '/r2'));
      await fire(wr2.offsetTop + 0.8 * (wr2.offsetHeight - sc().clientHeight), 20);
      location.hash = '#/library';
      await wait(900);
      const after = (await inv('db:getChapter', id('resume', '/r2'))).progress;
      check('leaving within 500ms of a scroll still saves that position', Math.abs(after - 0.8) < 0.06, after);
      out.resumeProgress = after;

      /* ---- 10. Discord follows the user outside the reader (asserted by the runner against the fake Discord) ---- */
      await wait(5500);                                   // "Browsing the library" (reader just closed)
      location.hash = '#/novel/' + enc('synth::offline'); // "Viewing Offline Saga"
      await waitFor(() => document.querySelector('.chapter-row'), 'novel page');
      await wait(5500);
      location.hash = '#/browse/synth';                   // "Browsing a source"
      await wait(5500);
      const box = document.querySelector('main input[type=search], main input.input, main .search-box input');
      if (box) { setVal(box, 'dragon'); await wait(5500); } // "Searching for a novel" (the text itself is never sent)
      out.searchBoxFound = !!box;
      check('found the source search box', !!box);
      location.hash = '#/library'; await wait(5500);
    }

    if (PHASE === 'b') {
      const r2 = id('resume', '/r2');
      /* after a full app restart the DB is the only memory */
      const saved = (await inv('db:getChapter', r2)).progress;
      await open(r2);
      await wait(400);
      check('after restart the chapter reopens at the saved position', Math.abs(segP(r2) - saved) < 0.05, `saved ${saved.toFixed(2)} got ${segP(r2).toFixed(2)}`);
      await open(id('resume', '/r1'));
      check('an unread chapter opens at the top', sc().scrollTop === 0, sc().scrollTop);
      check('typography setting survived restart (font 25)', document.querySelector('.reader article').style.fontSize === '25px');
      const off = (n) => id('offline', `/off${n}`);
      check('chapter read state survived restart', (await inv('db:getChapter', off(1))).read === true);
      const bms = await inv('db:getBookmarks');
      check('bookmark survived restart', bms.length === 1 && bms[0].chapterId === off(2));
      await open(off(2));
      check('bookmarked paragraph still marked in its own chapter', document.querySelectorAll('.reader p.marked').length === 1);
      const prefs = await inv('db:getKV', 'prefs');
      check('existing prefs preserved across restart (discord enabled, font 25)', prefs.discord.enabled === true && prefs.reader.fontSize === 25);
      await inv('db:setKV', 'prefs', { ...prefs, reader: { ...prefs.reader, continuous: false } });
    }

    if (PHASE === 'c') {
      const prefs = await inv('db:getKV', 'prefs');
      check('legacy mode preference persisted', prefs.reader.continuous === false);
      const r = (n) => id('resume', `/r${n}`);
      await open(r(1));
      check('legacy: one chapter per page', segIds().length === 1);
      check('legacy: "Next chapter" button at the end of the page', !!document.querySelector('.reader-end button.primary'));
      await toEnd(300); await wait(300);
      check('legacy: nothing is appended while scrolling', segIds().length === 1);
      key('ArrowDown'); await wait(700);
      check('legacy: ArrowDown still jumps to the next chapter (original behaviour)', hashId() === r(2), hashId());
      await waitFor(() => segEl(r(2))?.querySelector('p'), 'legacy r2');
      key('ArrowUp'); await wait(700);
      check('legacy: ArrowUp goes back', hashId() === r(1), hashId());
      await waitFor(() => segEl(r(1))?.querySelector('p'), 'legacy r1');
      await wait(300);
      await fire(sc().scrollHeight);
      await wait(1500);
      check('legacy: reaching the end marks read and continues to the next chapter (original ttsAutoNext behaviour)', hashId() === r(2) && (await inv('db:getChapter', r(1))).read === true, hashId());
    }
  } catch (e) {
    out.error = String(e?.message ?? e);
    out.hash = location.hash;
  }
  return out;
})();

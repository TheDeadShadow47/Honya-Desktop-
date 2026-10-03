// Phase 2: fresh launch on the SAME data dir. Everything phase 1 created must still be there,
// and the persisted plugin must serve a chapter with no re-install.
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, label, ms = 20000) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const v = await fn();
      if (v) return v;
      await wait(120);
    }
    throw new Error('timeout: ' + label);
  };
  const inv = (c, ...a) => window.honya.invoke(c, ...a);
  const byText = (sel, txt) =>
    [...document.querySelectorAll(sel)].find((b) => b.textContent.trim().startsWith(txt));
  const btn = (txt) => byText('button', txt);
  const out = {};

  try {
    out.pluginsAfterRestart = (await inv('plugins:listInstalled')).map((p) => `${p.id}@${p.version}`);

    location.hash = '#/catalogs';
    await wait(600);
    out.catalogsUiShowsInstalled = [...document.querySelectorAll('.row-item')].some(
      (r) => /Royal Road/.test(r.textContent) && /Uninstall/.test(r.textContent),
    );
    out.repoRemembered = (await inv('db:getKV', 'prefs'))?.repositories?.some((u) => /plugins\.min\.json/.test(u)) === true;
    out.catalogsReloadsSavedRepo = await waitFor(() => document.querySelectorAll('[data-plugin]').length > 100, 'saved repo auto-loads').then(() => true, () => false);

    location.hash = '#/library';
    await wait(600);
    await waitFor(() => document.querySelector('.card'), 'library card');
    out.libraryCards = [...document.querySelectorAll('.card-title')].map((e) => e.textContent);
    out.continueStrip = [...document.querySelectorAll('.continue-card')].length;

    document.querySelector('.card').click();
    await waitFor(() => document.querySelectorAll('.chapter-row').length > 0, 'novel page');
    out.chaptersAfterRestart = document.querySelectorAll('.chapter-row').length;
    out.readStateAfterRestart = [...document.querySelectorAll('.chapter-row')].map((r) =>
      r.classList.contains('read') ? 'read' : r.classList.contains('reading') ? 'reading' : 'unread',
    );

    // chapter-list preferences persist across restart
    document.querySelector('.chapter-toolbar select').value = 'numberDesc';
    document.querySelector('.chapter-toolbar select').dispatchEvent(new Event('change', { bubbles: true }));
    await wait(500);
    const rowsDesc = [...document.querySelectorAll('.chapter-row .chapter-name')].map((e) => e.textContent);
    out.sortDescApplied = rowsDesc.length > 1 && rowsDesc[0] !== rowsDesc[1];
    await wait(400);
    out.chapterPrefsPersisted = JSON.stringify((await inv('db:getKV', 'chapterPrefs')) ?? {});
    document.querySelector('.chapter-toolbar select').value = 'numberAsc';
    document.querySelector('.chapter-toolbar select').dispatchEvent(new Event('change', { bubbles: true }));
    await wait(300);

    // the bookmark created in phase 1 is still here
    out.bookmarksAfterRestart = (await inv('db:getBookmarks')).length;

    // read chapter 2 through the persisted plugin (no re-install)
    const novelHash = location.hash;
    const rows = [...document.querySelectorAll('.chapter-row')];

    // the bookmark created in phase 1 must render in the reader panel of ITS OWN chapter
    const bm = (await inv('db:getBookmarks'))[0];
    location.hash = `#/reader/${encodeURIComponent(bm.chapterId)}`;
    await waitFor(() => document.querySelector('.reader article p'), 'reader with bookmark');
    // NB: the bar has both "Bookmark this paragraph" and "Bookmarks" - match the panel toggle exactly
    const openMarks = [...document.querySelectorAll('.reader-bar .icon-btn')].find(
      (b) => b.getAttribute('aria-label') === 'Bookmarks',
    );
    const addMark = [...document.querySelectorAll('.reader-bar .icon-btn')].find(
      (b) => b.getAttribute('aria-label') === 'Bookmark this paragraph',
    );
    out.readerIconButtons = [...document.querySelectorAll('.reader-bar .icon-btn')]
      .map((b) => b.getAttribute('aria-label'))
      .join(',');
    openMarks.click();
    await wait(400);
    out.bookmarkPanel = {
      rows: document.querySelectorAll('.reader-panel .reader-mark').length,
      hasEmptyState: /no bookmark/i.test(document.querySelector('.reader-panel')?.innerText ?? ''),
      markedParagraphs: document.querySelectorAll('.reader p.marked').length,
    };

    // remove it from the panel, then re-add it with the reader shortcut: full round trip
    document.querySelector('.reader-panel .reader-mark .icon-btn').click();
    await waitFor(async () => (await inv('db:getBookmarks')).length === 0, 'bookmark removed');
    out.bookmarksAfterPanelRemove = (await inv('db:getBookmarks')).length;
    addMark.click();
    await waitFor(async () => (await inv('db:getBookmarks')).length === 1, 'bookmark re-added');
    out.bookmarksAfterReAdd = (await inv('db:getBookmarks')).length;
    out.markedAfterReAdd = document.querySelectorAll('.reader p.marked').length;
    openMarks.click();
    await wait(200);

    // back to the novel page, then open an unread chapter
    location.hash = novelHash;
    await waitFor(() => document.querySelectorAll('.chapter-row').length > 0, 'novel page again');
    const rows2 = [...document.querySelectorAll('.chapter-row')];
    const target = rows2.find((r) => !r.classList.contains('read')) ?? rows2[0];
    target.querySelector('.chapter-open').click();
    await waitFor(() => document.querySelector('.reader article p'), 'reader');
    out.chapter2 = {
      title: document.querySelector('.reader h2').textContent,
      firstPara: document.querySelector('.reader article p').textContent.slice(0, 60),
    };

    // save offline, then confirm the text is persisted in SQLite
    const save = btn('Save offline');
    if (save) {
      save.click();
      await waitFor(() => !!btn('Remove offline copy'), 'offline saved');
      const id = decodeURIComponent(location.hash.split('/')[2]);
      const ch = await inv('db:getChapter', id);
      out.savedOfflineChars = ch.downloadedText?.length ?? 0;
      out.readerShowsOffline = !!btn('Remove offline copy');
    }

    // downloads + updates screens must render from real data
    location.hash = '#/downloads';
    await wait(700);
    out.downloadsText = document.body.innerText.replace(/\s+/g, ' ').slice(0, 120);

    // enqueue the unread chapters through the real main-process queue, then wait for the
    // worker to fetch them via the installed plugin and write downloadedText to SQLite.
    location.hash = '#/library';
    await wait(500);
    document.querySelector('.card').click();
    await waitFor(() => document.querySelectorAll('.chapter-row').length > 0, 'novel for download');
    const selBtn = byText('button', 'Select');
    out.selectButtonFound = !!selBtn;
    selBtn.click();
    await wait(300);
    const boxes = [...document.querySelectorAll('.chapter-row input[type=checkbox]')];
    out.checkboxCount = boxes.length;
    for (const box of boxes) box.click();
    await wait(200);
    // scope to the selection bar: the sidebar "Downloads" nav item also starts with "Download"
    const bar = document.querySelector('.selection-bar');
    const dlBtn = [...bar.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Download'));
    out.downloadButtonFound = !!dlBtn;
    out.selectionBarText = bar.innerText.replace(/\s+/g, ' ').slice(0, 120);
    dlBtn.click();
    await waitFor(async () => (await inv('db:getDownloadQueue')).length > 0, 'queue receives items', 15000);
    out.enqueued = (await inv('db:getDownloadQueue')).map((d) => d.status).join(',');
    await waitFor(
      async () => (await inv('db:getDownloadQueue')).every((d) => ['completed', 'failed'].includes(d.status)),
      'queue drains',
      60000,
    );
    const queue = await inv('db:getDownloadQueue');
    const libNow = await inv('db:getLibrary');
    const chsNow = await inv('db:getChapters', libNow[0].id);
    out.queue = queue.map((q) => `${q.status}:${q.chapterName}`).join(' | ');
    // getChapters omits the body on purpose; pull each full row to prove the plugin text landed.
    const texts = [];
    for (const c of chsNow) texts.push((await inv('db:getChapter', c.id))?.downloadedText?.length ?? 0);
    out.downloadedTextLengths = chsNow.map((c, i) => `${c.number}:${c.downloaded ? texts[i] : 'no'}`).join(',');
    out.downloadedBytes = (await inv('db:getDownloadedBytes')).bytes > 0;
    out.historyAfterDownloads = (await inv('db:getHistory', 50)).length;
    out.batch = JSON.stringify(await inv('db:getKV', 'downloadBatch'));

    location.hash = '#/downloads';
    await wait(900);
    out.downloadsAfter = document.body.innerText.replace(/\s+/g, ' ').slice(0, 160);

    location.hash = '#/updates';
    await wait(700);
    out.updatesText = document.body.innerText.replace(/\s+/g, ' ').slice(0, 120);
    location.hash = '#/history';
    await wait(700);
    out.historyRows = document.querySelectorAll('.history-row').length;
    location.hash = '#/settings';
    await wait(900);
    out.settingsText = document.body.innerText.replace(/\s+/g, ' ').slice(0, 140);
    // storage stats must reflect the real database, including the bookmark count
    out.storageStats = await inv('app:storageStats');
    out.settingsStatLine = [...document.querySelectorAll('.stat-list li')]
      .map((li) => li.textContent.replace(/\s+/g, ' ').trim())
      .join(' | ');
  } catch (e) {
    out.error = `${e.message}`;
    out.hash = location.hash;
  }
  return out;
})();

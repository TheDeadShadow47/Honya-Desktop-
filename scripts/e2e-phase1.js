// Phase 1: real LNReader repository -> install a real source -> browse -> search -> open novel ->
// read a chapter -> scroll (progress persisted) -> save offline. Driven through the real UI.
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, label, ms = 20000) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const v = fn();
      if (v) return v;
      await wait(120);
    }
    throw new Error('timeout: ' + label);
  };
  const inv = (c, ...a) => window.honya.invoke(c, ...a);
  const setVal = (el, v) => {
    Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  };
  const byText = (sel, txt) =>
    [...document.querySelectorAll(sel)].find((b) => b.textContent.trim().startsWith(txt));
  const btn = (txt) => byText('button', txt);
  const out = { steps: [] };
  const REPO = 'https://raw.githubusercontent.com/LNReader/lnreader-plugins/plugins/v3.0.0/.dist/plugins.min.json';

  try {
    // 1. real repository -> install the real royalroad source through the UI
    // repositories are added in Settings; Catalogs then lists everything saved there
    location.hash = '#/settings';
    await wait(600);
    setVal(document.querySelector('input[aria-label="Repository URL"]'), REPO);
    btn('Add').click();
    await waitFor(() => [...document.querySelectorAll('.repo-url')].some((e) => e.textContent === REPO), 'repo saved');
    location.hash = '#/catalogs';
    await waitFor(() => document.querySelectorAll('[data-plugin]').length > 100, 'repo list');
    out.repoCount = document.querySelectorAll('[data-plugin]').length;
    setVal(document.querySelector('input[aria-label="Filter sources"]'), 'royalroad');
    await wait(300);
    document.querySelector('[data-install="royalroad"]').click();
    await waitFor(() => /Reinstall/.test(document.querySelector('[data-install="royalroad"]')?.textContent || ''), 'install');
    out.steps.push('installed royalroad from the real LNReader repository');

    // 2. popular list through the real plugin bundle
    location.hash = '#/browse/royalroad';
    await wait(400);
    await waitFor(() => document.querySelectorAll('.card').length > 0, 'popular');
    out.popular = [...document.querySelectorAll('.card-title')].map((e) => e.textContent);
    out.popularCovers = [...document.querySelectorAll('.cover')].map((e) => e.getAttribute('src'));

    // 3. search within the source
    const searchBox = document.querySelector('input[aria-label="Search this source"]');
    setVal(searchBox, 'wandering');
    searchBox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await waitFor(() => document.querySelectorAll('.card').length === 1, 'search');
    out.search = [...document.querySelectorAll('.card-title')].map((e) => e.textContent);

    // 4. open the novel: details, genres, summary and chapter list
    document.querySelector('.card').click();
    await waitFor(() => location.hash.startsWith('#/novel/'), 'novel route');
    await waitFor(() => !!btn('Refresh'), 'novel page');
    btn('Refresh').click();
    await waitFor(() => document.querySelectorAll('.chapter-row').length > 0, 'chapters');
    out.novel = {
      title: document.querySelector('.novel-info h1').textContent,
      meta: document.querySelector('.novel-info .muted').textContent,
      genres: [...document.querySelectorAll('.chips .chip')].map((c) => c.textContent.trim()),
      summary: document.querySelector('.summary').textContent.slice(0, 70),
      chapters: document.querySelectorAll('.chapter-row').length,
      chips: [...document.querySelectorAll('.chapter-toolbar .muted')].map((c) => c.textContent.trim()),
    };
    out.steps.push('novel detail + chapter list loaded from the source');

    // add to library, then confirm the button flips
    btn('Add to library').click();
    await waitFor(() => !!btn('Remove from library'), 'in library');
    out.inLibrary = true;

    // 5. read chapter 1 through the plugin, then scroll -> progress is written to SQLite
    btn('Start reading').click();
    await waitFor(() => document.querySelector('.reader article p'), 'reader text');
    out.reader = {
      title: document.querySelector('.reader h2').textContent,
      paragraphs: document.querySelectorAll('.reader article p').length,
      firstPara: document.querySelector('.reader article p').textContent.slice(0, 60),
      offline: !!btn('Save offline'),
    };
    const sc = document.querySelector('.reader-scroll');
    sc.style.height = '120px';
    // continuous reader: scroll to the end of the FIRST chapter (the old 99999 jump would land on whatever chapters had
    // chain-loaded below it, which is correct behaviour but no longer the step this test describes)
    const firstSeg = sc.querySelector('.reader-seg');
    sc.scrollTop = firstSeg.offsetTop + firstSeg.offsetHeight - sc.clientHeight;
    sc.dispatchEvent(new Event('scroll'));
    await wait(1400);

    // bookmark the current paragraph (SQLite-backed)
    document.querySelector('button[aria-label="Bookmark this paragraph"]').click();
    await wait(600);
    out.bookmarks = (await inv('db:getBookmarks')).length;

    const lib = await inv('db:getLibrary');
    const chs = await inv('db:getChapters', lib[0].id);
    out.db = {
      library: lib.map((n) => `${n.title} (${n.totalChapters} ch, ${n.readChapters} read)`),
      read: chs.filter((c) => c.read).length,
      progress: chs.map((c) => Number(c.progress ?? 0).toFixed(2)).join(','),
    };
    out.finalHash = location.hash;
    await wait(2500);
    out.hashAfter2s = location.hash;
    out.plugins = (await inv('plugins:listInstalled')).map((p) => `${p.id}@${p.version}`);
  } catch (e) {
    out.error = `${e.message}`;
    out.hash = location.hash;
  }
  return out;
})();

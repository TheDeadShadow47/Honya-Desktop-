// Desktop port of Honya Android's lib/libraryUpdate.js.
//
// Strictly serial refresh across the library, comparing the set of chapter ids the source returns
// against what is already stored. Results are written through db.replaceChapters, which preserves
// read state, progress and downloaded text, so the "new chapters" count is always real.

const SUMMARY_KEY = 'updateSummary';
const INTERVAL_MS = { '6h': 6 * 60 * 60 * 1000, '12h': 12 * 60 * 60 * 1000, daily: 24 * 60 * 60 * 1000 };

export const intervalMs = (key) => INTERVAL_MS[key] ?? null;

export function createLibraryUpdate({ db, host, onChange = () => {}, onResult = () => {} }) {
  let running = false;
  let cancelled = false;
  let lastPersisted = null;

  const listeners = new Set();
  const emit = (payload, force = false) => {
    for (const fn of [...listeners]) {
      try {
        fn(payload);
      } catch {}
    }
    try {
      onChange(payload, force);
    } catch {}
  };

  const notify = (payload) => {
    try {
      onResult(payload);
    } catch {}
  };

  const chapterId = (novelId, c, i) => c.id ?? `${novelId}::${c.path ?? c.name ?? i}`;

  /** Checks one novel and applies the changes. Returns the count of genuinely new chapters. */
  async function checkNovel(novel) {
    const pluginRecord = novel.pluginId ? await db.getPlugin(novel.pluginId) : null;
    if (!pluginRecord) throw new Error('Source extension not installed');
    if (!novel.path) throw new Error('Novel is missing a source path');

    const detail = await host.call(pluginRecord, 'novel', [novel.path]);

    await db.upsertNovel({
      ...novel,
      title: detail?.name ?? detail?.title ?? novel.title,
      author: detail?.author ?? novel.author,
      cover: detail?.cover ?? novel.cover,
      status: detail?.status ?? novel.status,
      summary: detail?.summary ?? detail?.description ?? novel.summary,
      genres: Array.isArray(detail?.genres)
        ? detail.genres
        : typeof detail?.genres === 'string'
          ? detail.genres.split(/,\s*/)
          : novel.genres,
      inLibrary: novel.inLibrary,
    });

    const incoming = Array.isArray(detail?.chapters) ? detail.chapters : [];
    if (!incoming.length) return 0; // an empty list is not evidence of any chapter change

    const existing = await db.getChapters(novel.id);
    const known = new Set(existing.map((c) => c.id));
    const withIds = incoming.map((c, i) => ({ ...c, id: chapterId(novel.id, c, i) }));
    const newCount = withIds.filter((c) => !known.has(c.id)).length;

    await db.replaceChapters(novel.id, withIds);
    return newCount;
  }

  function cancelLibraryUpdate() {
    cancelled = true;
  }

  async function runLibraryUpdate() {
    if (running) return { skipped: true };
    running = true;
    cancelled = false;

    const library = await db.getUpdatableNovels();
    const total = library.length;
    const failed = [];
    const updatedTitles = [];
    let checked = 0;
    let updatedNovels = 0;
    let totalNewChapters = 0;

    emit({ running: true, current: 0, total, novelTitle: null }, true);

    try {
      for (const novel of library) {
        if (cancelled) {
          const summary = { lastUpdateAt: Date.now(), checked, updated: updatedNovels, newChapters: totalNewChapters, failed, cancelled: true };
          await db.setKV(SUMMARY_KEY, summary);
          lastPersisted = summary;
          emit({ running: false, current: checked, total, novelTitle: null }, true);
          emit({ summary }, true);
          notify({ type: 'cancelled', summary });
          return summary;
        }
        checked += 1;
        emit({ running: true, current: checked, total, novelTitle: novel.title }, checked === 1 || checked === total);

        try {
          const newCount = await checkNovel(novel);
          if (newCount > 0) {
            updatedNovels += 1;
            totalNewChapters += newCount;
            updatedTitles.push({ id: novel.id, title: novel.title, newCount });
          }
        } catch (e) {
          failed.push({ novelId: novel.id, title: novel.title, message: e?.message ?? 'Update failed' });
        }
      }

      const summary = { lastUpdateAt: Date.now(), checked, updated: updatedNovels, newChapters: totalNewChapters, failed, cancelled: false };
      await db.setKV(SUMMARY_KEY, summary);
      lastPersisted = summary;
      emit({ running: false, current: total, total, novelTitle: null }, true);
      emit({ summary }, true);
      notify({ type: 'complete', summary, updatedTitles });
      return summary;
    } finally {
      running = false;
    }
  }

  /** Runs only when the auto-update interval has elapsed. Returns null when it skipped. */
  async function maybeRunAutoUpdate(interval) {
    const ms = intervalMs(interval);
    if (!ms) return null;
    const state = (await db.getKV('autoUpdateState')) ?? {};
    if (state.lastRunAt && Date.now() - state.lastRunAt < ms) return null;
    const summary = await runLibraryUpdate();
    if (summary && !summary.cancelled) await db.setKV('autoUpdateState', { lastRunAt: Date.now() });
    return summary;
  }

  return {
    runLibraryUpdate,
    cancelLibraryUpdate,
    maybeRunAutoUpdate,
    isRunning: () => running,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    loadPersistedSummary: async () => lastPersisted ?? ((await db.getKV(SUMMARY_KEY)) ?? null),
  };
}
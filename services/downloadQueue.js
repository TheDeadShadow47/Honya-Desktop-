import { sanitizeChapter } from '../core/text/clean.js';

// Desktop port of Honya Android's lib/downloadQueue.js.
//
// Same states, same persistence, same single-worker pump and same crash recovery. The mobile
// module depended on AsyncStorage (kv table here), expo-notifications (Electron Notification here)
// and a module-level plugin host (passed in here). No behaviour is simulated: every completion
// comes from a real plugin fetch whose text is written to chapters.downloadedText.

const BATCH_KEY = 'downloadBatch';

const EMIT_THROTTLE_MS = 150;

export function createDownloadQueue({ db, host, notify = null }) {
  const items = new Map(); // chapterId -> item
  let order = []; // queued chapterIds, ordered by queuePos
  let nextPos = 0;
  let paused = false;
  let working = false;
  let initialized = false;
  let initPromise = null;
  const cancelRequested = new Set();
  let batchCancelled = false;

  let batchTotal = 0;
  let batchDone = 0;
  let batchFailed = 0;

  const listeners = new Set();
  let lastEmitAt = 0;

  const now = () => Date.now();

  /* --- persistence ------------------------------------------------- */

  const loadBatch = async () => {
    try {
      const raw = await db.getKV(BATCH_KEY);
      if (raw) {
        batchTotal = Number(raw.total) || 0;
        batchDone = Number(raw.done) || 0;
        batchFailed = Number(raw.failed) || 0;
      }
    } catch {
      /* first run */
    }
  };
  const saveBatch = () => db.setKV(BATCH_KEY, { total: batchTotal, done: batchDone, failed: batchFailed });

  const toRow = (it) => ({
    chapterId: it.chapterId,
    novelId: it.novelId,
    status: it.status,
    queuePos: it.queuePos ?? null,
    error: it.error ?? null,
    createdAt: it.createdAt,
    updatedAt: it.updatedAt,
  });

  /* --- snapshots --------------------------------------------------- */

  const byStatus = (s) => [...items.values()].filter((i) => i.status === s);

  const snapshot = () => ({
    paused,
    batchTotal,
    batchDone,
    batchFailed,
    active: [...items.values()].some((i) => i.status === 'downloading'),
    queued: byStatus('queued').sort((a, b) => (a.queuePos ?? 0) - (b.queuePos ?? 0)),
    downloading: byStatus('downloading'),
    failed: byStatus('failed'),
    completed: byStatus('completed').sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)),
    cancelled: byStatus('cancelled'),
    items: [...items.values()].sort((a, b) => {
      const rank = { downloading: 0, queued: 1, failed: 2, completed: 3, cancelled: 4 };
      const d = (rank[a.status] ?? 9) - (rank[b.status] ?? 9);
      return d !== 0 ? d : (a.queuePos ?? 0) - (b.queuePos ?? 0);
    }),
  });

  let emitTimer = null;
  function emit(force = false) {
    const payload = snapshot();
    const at = now();
    if (!force && at - lastEmitAt < EMIT_THROTTLE_MS) {
      // Guarantee a final render even when the throttle swallows this tick.
      if (!emitTimer) {
        emitTimer = setTimeout(() => {
          emitTimer = null;
          emit(true);
        }, EMIT_THROTTLE_MS);
      }
      return;
    }
    lastEmitAt = at;
    push(payload);
  }

  let sink = () => {};
  function push(payload) {
    for (const fn of [...listeners]) {
      try {
        fn(payload);
      } catch {}
    }
    try {
      sink(payload);
    } catch {}
  }

  const onChange = (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };
  const setSink = (fn) => {
    sink = fn;
  };

  /* --- hydration --------------------------------------------------- */

  async function hydrate() {
    const rows = await db.getDownloadQueue();
    for (const row of rows) {
      // A row left as 'downloading' means the app died mid-flight; demote it so it retries.
      const status = row.status === 'downloading' ? 'queued' : row.status;
      const queuePos = row.queuePos ?? nextPos++;
      items.set(row.chapterId, {
        chapterId: row.chapterId,
        novelId: row.novelId,
        status,
        error: row.error ?? null,
        chapterName: row.chapterName,
        chapterNumber: row.chapterNumber,
        novelTitle: row.novelTitle,
        novelCover: row.novelCover,
        queuePos,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });
      if (status === 'queued') order.push(row.chapterId);
      nextPos = Math.max(nextPos, (Number(row.queuePos) || 0) + 1);
    }
    order.sort((a, b) => (items.get(a)?.queuePos ?? 0) - (items.get(b)?.queuePos ?? 0));
    if (order.length) {
      // Persist the demotion so a second crash does not lose these either.
      await db.upsertDownloadQueueItems(order.map((id) => toRow(items.get(id))));
    }
    await loadBatch();
  }

  function initQueue() {
    if (initialized) return Promise.resolve();
    if (initPromise) return initPromise;
    initPromise = (async () => {
      try {
        await hydrate();
        initialized = true;
      } finally {
        initPromise = null;
      }
    })();
    return initPromise;
  }

  const isIdle = () => ![...items.values()].some((i) => i.status === 'queued' || i.status === 'downloading');

  /* --- the unit of work -------------------------------------------- */

  async function downloadItem(it) {
    const chapterId = it.chapterId;
    try {
      const chapterRow = await db.getChapter(chapterId);
      if (!chapterRow) throw new Error('Chapter no longer exists');

      // Text already on disk (crash between the two writes): reconcile instead of refetching.
      if (chapterRow.downloadedText) {
        it.status = 'completed';
        it.updatedAt = now();
        batchDone += 1;
        await db.upsertDownloadQueueItems([toRow(it)]);
        await saveBatch();
        return;
      }

      const novel = await db.getNovel(it.novelId);
      const pluginRecord = novel?.pluginId ? await db.getPlugin(novel.pluginId) : null;
      if (!pluginRecord) throw new Error('The source extension for this novel is not installed');
      if (!chapterRow.path) throw new Error('Chapter is missing a source path');

      const raw = await host.call(pluginRecord, 'chapter', [chapterRow.path]);
      const clean = sanitizeChapter(raw, { title: chapterRow.name });
      if (!clean) throw new Error('The source returned an empty chapter');

      if (cancelRequested.has(chapterId)) {
        cancelRequested.delete(chapterId);
        it.status = 'cancelled';
        it.updatedAt = now();
        items.delete(chapterId);
        await db.removeDownloadQueueItems([chapterId]);
      } else {
        await db.saveChapterText(chapterId, clean);
        it.status = 'completed';
        it.updatedAt = now();
        batchDone += 1;
        await db.upsertDownloadQueueItems([toRow(it)]);
      }
      await saveBatch();
    } catch (e) {
      cancelRequested.delete(chapterId);
      it.status = 'failed';
      it.error = e?.message ?? 'Download failed';
      it.updatedAt = now();
      batchFailed += 1;
      await db.upsertDownloadQueueItems([toRow(it)]);
      await saveBatch();
    }
  }

  /* --- the pump ---------------------------------------------------- */

  async function pump() {
    if (working) return;
    working = true;
    try {
      while (!paused && !batchCancelled && order.length) {
        const chapterId = order.shift();
        const it = items.get(chapterId);
        if (!it || it.status !== 'queued') continue;
        it.status = 'downloading';
        it.updatedAt = now();
        // Deliberately not persisted: the row is already 'queued' in SQLite and a crash demotes
        // 'downloading' back to 'queued' on restart anyway.
        emit();
        notify('progress', { item: it, batchTotal, batchDone, batchFailed });
        await downloadItem(it);
        emit();
      }
    } finally {
      working = false;
    }

    if ((batchCancelled || !paused) && isIdle() && batchTotal > 0) {
      notify('batchEnd', { batchDone, batchFailed, total: batchTotal, cancelled: batchCancelled });
      batchCancelled = false;
      batchTotal = 0;
      batchDone = 0;
      batchFailed = 0;
      await saveBatch();
      emit(true);
    }
  }

  /* --- public surface ---------------------------------------------- */

  async function enqueue(chapters, { novel } = {}) {
    const list = (Array.isArray(chapters) ? chapters : [chapters]).filter(
      (c) => c?.id && !c.downloaded && !items.has(c.id),
    );
    if (!list.length) return { queued: 0 };
    await initQueue();
    const at = now();
    if (isIdle()) {
      batchTotal = 0;
      batchDone = 0;
      batchFailed = 0;
    }
    for (const c of list) {
      items.set(c.id, {
        chapterId: c.id,
        novelId: c.novelId,
        status: 'queued',
        error: null,
        chapterName: c.name ?? null,
        chapterNumber: c.number ?? null,
        novelTitle: novel?.title ?? null,
        novelCover: novel?.cover ?? null,
        queuePos: nextPos++,
        createdAt: at,
        updatedAt: at,
      });
      order.push(c.id);
    }
    batchTotal += list.length;
    await saveBatch();
    await db.upsertDownloadQueueItems(list.map((c) => toRow(items.get(c.id))));
    emit(true);
    pump();
    return { queued: list.length };
  }

  async function cancel(chapterId) {
    await initQueue();
    const it = items.get(chapterId);
    if (!it) {
      await db.removeDownloadQueueItems([chapterId]);
      return;
    }
    if (it.status === 'queued') {
      order = order.filter((id) => id !== chapterId);
      items.delete(chapterId);
      await db.removeDownloadQueueItems([chapterId]);
      emit(true);
    } else if (it.status === 'downloading') {
      // The plugin API is not abortable, so discard the result when the fetch settles.
      cancelRequested.add(chapterId);
    }
  }

  async function cancelAllQueued() {
    await initQueue();
    const ids = order.slice();
    order = [];
    for (const id of ids) items.delete(id);
    if (ids.length) await db.removeDownloadQueueItems(ids);
    emit(true);
  }

  function pauseQueue() {
    paused = true;
    emit(true);
  }
  function resumeQueue() {
    paused = false;
    emit(true);
    pump();
  }

  async function retryFailed() {
    await initQueue();
    const failed = [...items.values()].filter((i) => i.status === 'failed');
    if (!failed.length) return { queued: 0 };
    for (const it of failed) {
      it.status = 'queued';
      it.error = null;
      it.queuePos = nextPos++;
      it.updatedAt = now();
      order.push(it.chapterId);
    }
    batchTotal += failed.length;
    await saveBatch();
    await db.upsertDownloadQueueItems(failed.map(toRow));
    emit(true);
    pump();
    return { queued: failed.length };
  }

  async function clearFailed() {
    await initQueue();
    const ids = [...items.values()].filter((i) => i.status === 'failed').map((i) => i.chapterId);
    for (const id of ids) items.delete(id);
    if (ids.length) await db.removeDownloadQueueItems(ids);
    emit(true);
    return { removed: ids.length };
  }

  async function clearCompleted() {
    await initQueue();
    const ids = [...items.values()].filter((i) => i.status === 'completed').map((i) => i.chapterId);
    for (const id of ids) items.delete(id);
    if (ids.length) await db.removeDownloadQueueItems(ids);
    emit(true);
    return { removed: ids.length };
  }

  async function removeEntry(chapterId) {
    await initQueue();
    order = order.filter((id) => id !== chapterId);
    items.delete(chapterId);
    await db.removeDownloadQueueItems([chapterId]);
    emit(true);
  }

  async function removeByNovel(novelId) {
    await initQueue();
    const ids = [...items.values()]
      .filter((i) => i.novelId === novelId && i.status !== 'downloading')
      .map((i) => i.chapterId);
    order = order.filter((id) => !ids.includes(id));
    for (const id of ids) items.delete(id);
    if (ids.length) await db.removeDownloadQueueItems(ids);
    emit(true);
  }

  async function start() {
    await initQueue();
    emit(true);
    pump();
  }

  return {
    start,
    getSnapshot: async () => {
      await initQueue();
      return snapshot();
    },
    enqueue,
    cancel,
    cancelAllQueued,
    cancelAllQueuedAndStop: () => {
      batchCancelled = true;
      return cancelAllQueued();
    },
    pauseQueue,
    resumeQueue,
    retryFailed,
    clearFailed,
    clearCompleted,
    removeEntry,
    removeByNovel,
    onChange,
    setSink,
    isPaused: () => paused,
  };
}
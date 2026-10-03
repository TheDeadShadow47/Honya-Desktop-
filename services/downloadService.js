import { createDownloadQueue } from './downloadQueue.js';

// Desktop download service boundary:  UI -> IPC -> DownloadQueue -> real plugin fetch + SQLite.
// A faithful port of the mobile lib/downloadQueue.js: same states, same single-worker pump, same
// crash recovery from the persisted `downloads` table, same bulk actions. Nothing is simulated.

const BATCH_LABEL = (done, total) => (total > 99 ? '99+' : String(total));

export function createDownloadService({ db, host, prefs }) {
  let queue = null;

  const setting = (key, fallback) => {
    const p = prefs.get();
    return p?.[key] ?? fallback;
  };

  // Notification fan-out. Gated by the same preference keys Honya Android uses; when the user has
  // turned notifications off nothing is shown and reading is unaffected.
  const notify = async (event, payload) => {
    if (!setting('notificationsEnabled', true)) return;
    if (event === 'progress' && !setting('notifyDownloadStart', true)) return;
    if (event === 'batchEnd' && !setting('notifyDownloadComplete', true)) return;

    if (event === 'progress') {
      const { item, batchDone, batchTotal } = payload;
      if (setting('notifyDownloadStart', true)) {
        const body =
          batchTotal > 1
            ? `${item.novelTitle ?? ''}\n${item.chapterName ?? ''} (${batchDone + 1} / ${batchTotal})`
            : `${item.novelTitle ?? ''}\n${item.chapterName ?? ''}`;
        show({ title: batchTotal > 1 ? `Downloading chapters` : 'Downloading…', body });
      }
      return;
    }

    if (event === 'batchEnd') {
      const { batchDone, batchFailed, cancelled, total } = payload;
      if (cancelled) {
        if (batchDone > 0) show({ title: 'Downloads cancelled', body: `${batchDone} chapters downloaded` });
        return;
      }
      if (batchDone <= 0) return;
      show({ title: 'Downloads complete', body: `${BATCH_LABEL(batchDone, total)} chapters downloaded` });
      if (batchFailed > 0 && setting('notifyDownloadFailed', true)) {
        show({ title: `${batchFailed} failed`, body: 'Open Downloads to retry' });
      }
    }
  };

  const show = async ({ title, body }) => {
    try {
      const { Notification } = await import('electron');
      if (Notification.isSupported()) new Notification({ title, body }).show();
    } catch {}
  };

  const get = () => {
    if (!queue) queue = createDownloadQueue({ db, host, notify });
    return queue;
  };

  return {
    init: async () => {
      await get().start();
    },
    getSnapshot: () => get().getSnapshot(),
    onChange: (fn) => get().onChange(fn),
    enqueue: (chapters, opts) => get().enqueue(chapters, opts ?? {}),
    cancel: (chapterId) => get().cancel(chapterId),
    cancelAll: () => get().cancelAllQueuedAndStop(),
    pause: async () => get().pauseQueue(),
    resume: async () => get().resumeQueue(),
    retryFailed: () => get().retryFailed(),
    clearCompleted: () => get().clearCompleted(),
    clearFailed: () => get().clearFailed(),
    removeEntry: (chapterId) => get().removeEntry(chapterId),
    removeByNovel: (novelId) => get().removeByNovel(novelId),
  };
}
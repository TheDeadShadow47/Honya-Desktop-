import { useCallback, useEffect, useMemo, useState } from 'react';
import { db, downloads, app } from './api';
import { useResource, subscribe } from './store.js';

/** Library novels plus a per-novel progress rollup (latest chapter, read/unread/downloaded counts). */
export function useLibrary() {
  const res = useResource('library', async () => {
    const [novels, progress] = await Promise.all([db.getLibrary(), db.getLibraryProgress()]);
    const byId = new Map(progress.map((p) => [p.novelId, p]));
    return novels.map((n) => {
      const p = byId.get(n.id) ?? {};
      return {
        ...n,
        totalChapters: p.totalChapters ?? n.totalChapters ?? 0,
        readChapters: p.readChapters ?? n.readChapters ?? 0,
        unread: Math.max((p.totalChapters ?? n.totalChapters ?? 0) - (p.readChapters ?? n.readChapters ?? 0), 0),
        downloadedChapters: p.downloadedChapters ?? 0,
        pendingDownloads: p.pendingDownloads ?? 0,
        lastChapterId: p.lastChapterId ?? null,
        lastChapterName: p.lastChapterName ?? null,
        lastChapterNumber: p.lastChapterNumber ?? null,
        lastReadAt: p.lastReadAt ?? null,
      };
    });
  }, [], { cacheKey: 'library' });
  return res;
}

/** The most recently touched chapter of every library novel. */
export function useContinueReading(limit = 12) {
  return useResource(['library', 'history'], () => db.getContinueReading(limit), [limit], { cacheKey: 'continue' });
}

export function useUpdates(limit = 150) {
  return useResource(['updates', 'library'], () => db.getRecentUpdates(limit), [limit], { cacheKey: 'updates' });
}

export function useHistory(limit = 200) {
  return useResource(['history', 'library'], () => db.getHistory(limit), [limit], { cacheKey: 'history' });
}

export function useBookmarks(novelId = null) {
  return useResource('library', () => db.getBookmarks(novelId), [novelId]);
}

/** The persisted download queue, plus live queue state pushed from the main process. */
export function useDownloadQueue() {
  const rows = useResource('downloads', () => downloads.getSnapshot(), []);
  const [live, setLive] = useState(null);

  useEffect(
    () =>
      subscribeDownloadState((snapshot) => {
        setLive(snapshot);
      }),
    [],
  );

  // The IPC query and the push both deliver the queue snapshot object; normalise so callers can
  // always treat `items` as an array even before the first push arrives.
  const snap = live ?? rows.data ?? null;
  const items = snap?.items ?? [];
  return {
    ...rows,
    items,
    paused: snap?.paused ?? false,
    batchTotal: snap?.batchTotal ?? 0,
    batchDone: snap?.batchDone ?? 0,
    batchFailed: snap?.batchFailed ?? 0,
    active: snap?.active ?? false,
  };
}

/** Subscribes to queue snapshots pushed from the Electron main process. */
export function subscribeDownloadState(fn) {
  const off = window.honya?.onDownloadState?.(fn) ?? (() => {});
  return off;
}

/** Sidebar badge counts. Cheap queries, refreshed by the same topics as the screens. */
let lastBadges = { queueCount: 0, unreadChapters: 0 }; // survives the sidebar unmounting (it does in the reader)
export function useUnreadCount() {
  const [state, setState] = useState(lastBadges);
  const load = useCallback(() => {
    Promise.all([db.getDownloadQueue(), db.getUnreadCount(100)])
      .then(([queue, unreadChapters]) => {
        const queueCount = (queue ?? []).filter((d) => d.status === 'queued' || d.status === 'downloading').length;
        lastBadges = { queueCount, unreadChapters };
        setState((s) => (s.queueCount === queueCount && s.unreadChapters === unreadChapters ? s : lastBadges));
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    load();
    return subscribe((topics) => {
      if (topics.has('downloads') || topics.has('library') || topics.has('updates')) load();
    });
  }, [load]);
  return state;
}

/** Progress of the running library update, pushed from the main process. */
export function useLibraryUpdateState() {
  const [state, setState] = useState({ running: false, current: 0, total: 0, novelTitle: null, summary: null });
  useEffect(
    () =>
      window.honya?.onLibraryUpdate?.((s) => setState(s)) ?? (() => {}),
    [],
  );
  return state;
}

export function useAppInfo() {
  return useResource([], () => app.info(), []);
}

/** Persisted per-novel chapter list preferences (filters / sort / display). */
export function useChapterPrefs() {
  const [prefs, setPrefs] = useState({});
  const reload = useCallback(() => {
    db.getKV('chapterPrefs').then((v) => setPrefs(v ?? {})).catch(() => {});
  }, []);
  useEffect(reload, [reload]);
  const save = useCallback(
    async (novelId, next) => {
      setPrefs((all) => {
        const merged = { ...all, [novelId]: next };
        db.setKV('chapterPrefs', merged).catch(() => {});
        return merged;
      });
    },
    [],
  );
  return useMemo(() => ({ prefs, reload, save }), [prefs, reload, save]);
}
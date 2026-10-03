import { db, plugins, downloads, updates } from './api';
import { emit } from './store.js';

// Every state-changing operation lives here so screens stay declarative and the sidebar badges,
// library, updates, history and download views always refetch from SQLite after a write.
// Behaviour mirrors Honya Android (store/useStore.js) rather than inventing new semantics.

const afterLibrary = () => emit('library', 'updates', 'history');
const afterDownloads = () => emit('downloads');

/* --- library ------------------------------------------------------- */

export async function toggleLibrary(novel) {
  await db.setInLibrary(novel.id, !novel.inLibrary);
  afterLibrary();
  return !novel.inLibrary;
}

export async function addToLibrary(novel) {
  // upsertNovel deliberately leaves inLibrary alone on conflict (so browse/search results never
  // eject library members), so adding has to go through setInLibrary explicitly.
  await db.upsertNovel({ ...novel, inLibrary: false });
  await db.setInLibrary(novel.id, true);
  afterLibrary();
}

export async function removeFromLibrary(novel) {
  await db.setInLibrary(novel.id, false);
  afterLibrary();
}

/** Hard delete: chapters, downloaded text, bookmarks and queue rows. */
export async function deleteNovel(novelId) {
  await db.deleteNovel(novelId);
  try {
    await downloads.removeByNovel(novelId);
  } catch {}
  afterLibrary();
  afterDownloads();
}

/**
 * Re-fetches one novel from its source plugin and reconciles the chapter list.
 * Mirrors Android's per-novel refresh: the detail object updates the novel row, and the incoming
 * chapter list is upserted (never destructive), so read state, progress and downloads survive.
 * Returns the number of genuinely new chapters.
 */
export async function refreshNovel(novel, { signal } = {}) {
  if (!novel.pluginId) throw new Error('This novel has no source plugin');
  if (!novel.path) throw new Error('This novel has no source path');
  const detail = await plugins.novel(novel.pluginId, novel.path);
  if (signal?.aborted) return 0;

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
  });

  const incoming = Array.isArray(detail?.chapters) ? detail.chapters : [];
  let newCount = 0;
  if (incoming.length) {
    const existing = await db.getChapters(novel.id);
    const known = new Set(existing.map((c) => c.id));
    const withIds = incoming.map((c, i) => ({ ...c, id: c.id ?? `${novel.id}::${c.path ?? c.name ?? i}` }));
    newCount = withIds.filter((c) => !known.has(c.id)).length;
    await db.replaceChapters(novel.id, withIds);
  }
  afterLibrary();
  return newCount;
}

/** Opens a search/browse result: upserts it (never ejecting a library member) and navigates. */
export async function openNovelResult(pluginId, result) {
  const path = result.path ?? result.url ?? result.name ?? result.title;
  if (!path) throw new Error('This source returned an entry without a path');
  const id = result.id ?? `${pluginId}::${path}`;
  await db.upsertNovel({
    id,
    pluginId,
    path,
    title: result.name ?? result.title ?? 'Untitled',
    author: result.author ?? null,
    cover: result.cover ?? result.coverUrl ?? null,
    summary: null,
    genres: [],
    inLibrary: false,
  });
  return id;
}

/* --- chapters ------------------------------------------------------ */

export async function markRead(chapterIds, read = true) {
  await db.markChaptersRead(chapterIds, read);
  afterLibrary();
}

export async function markAllRead(novelId) {
  await db.markAllChaptersRead(novelId);
  afterLibrary();
}

/* --- downloads ----------------------------------------------------- */

export async function downloadChapters(chapters, novel) {
  const list = (chapters ?? []).filter((c) => c?.id && !c.downloaded);
  if (!list.length) return { queued: 0 };
  const res = await downloads.enqueue(list, { novel: novel ?? null });
  afterDownloads();
  return res ?? { queued: list.length };
}

export const cancelDownload = async (chapterId) => {
  await downloads.cancel(chapterId);
  afterDownloads();
};
export const pauseDownloads = async () => {
  await downloads.pause();
  afterDownloads();
};
export const resumeDownloads = async () => {
  await downloads.resume();
  afterDownloads();
};
export const retryFailedDownloads = async () => {
  await downloads.retryFailed();
  afterDownloads();
};
export const clearCompletedDownloads = async () => {
  await downloads.clearCompleted();
  afterDownloads();
};
export const clearFailedDownloads = async () => {
  await downloads.clearFailed();
  afterDownloads();
};
export const cancelAllQueuedDownloads = async () => {
  await downloads.cancelAll();
  afterDownloads();
};

export async function removeDownload(chapterId) {
  await db.deleteChapterText(chapterId);
  await downloads.removeEntry(chapterId);
  afterDownloads();
  emit('library');
}

export async function clearAllDownloads() {
  await db.clearDownloads();
  try {
    await downloads.clearCompleted();
  } catch {}
  afterDownloads();
  emit('library');
}

/* --- history ------------------------------------------------------- */

export async function removeHistoryEntry(chapterId) {
  await db.removeHistoryEntry(chapterId);
  emit('history');
}

export async function clearHistory() {
  await db.clearHistory();
  emit('history');
}

/* --- plugins ------------------------------------------------------- */

export async function installPlugin(entry) {
  await plugins.install(entry);
  emit('plugins');
}

export async function uninstallPlugin(id) {
  await plugins.uninstall(id);
  emit('plugins', 'library');
}

/* --- library update ------------------------------------------------ */

export async function runLibraryUpdate() {
  emit('updates');
  const summary = await updates.run();
  emit('updates', 'library', 'history');
  return summary;
}

export const cancelLibraryUpdate = () => updates.cancel();
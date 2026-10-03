import * as SQLite from 'expo-sqlite';

let dbPromise;
let queue = Promise.resolve();

/** Expo-sqlite can run overlapping ops without a busy timeout, so serialize all DB calls to avoid SQLITE_BUSY. */
function serialize(task) {
  const result = queue.then(task);
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function getDb() {
  if (!dbPromise) dbPromise = SQLite.openDatabaseAsync('honya.db');
  return dbPromise;
}

export function initDatabase() {
  return serialize(async () => {
    const db = await getDb();
    await db.execAsync(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS novels (
        id TEXT PRIMARY KEY NOT NULL,
        pluginId TEXT,
        path TEXT,
        title TEXT NOT NULL,
        author TEXT,
        cover TEXT,
        status TEXT,
        summary TEXT,
        genres TEXT,
        inLibrary INTEGER DEFAULT 0,
        addedAt INTEGER
      );
      CREATE TABLE IF NOT EXISTS chapters (
        id TEXT PRIMARY KEY NOT NULL,
        novelId TEXT NOT NULL,
        path TEXT,
        name TEXT,
        releaseTime TEXT,
        number INTEGER,
        read INTEGER DEFAULT 0,
        progress REAL DEFAULT 0,
        downloadedText TEXT,
        updatedAt INTEGER
      );
      CREATE TABLE IF NOT EXISTS plugins (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT,
        version TEXT,
        lang TEXT,
        iconUrl TEXT,
        site TEXT,
        repoUrl TEXT,
        code TEXT NOT NULL,
        installedAt INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_chapters_novel ON chapters(novelId);
      CREATE TABLE IF NOT EXISTS downloads (
        chapterId TEXT PRIMARY KEY NOT NULL,
        novelId TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        queuePos INTEGER,
        error TEXT,
        createdAt INTEGER,
        updatedAt INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_downloads_status ON downloads(status);

      -- Desktop additions (behaviour-equivalent ports of the mobile AsyncStorage stores,
      -- moved into SQLite so they are transactional and take part in backup/restore).
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT
      );
      CREATE TABLE IF NOT EXISTS bookmarks (
        id TEXT PRIMARY KEY NOT NULL,
        novelId TEXT NOT NULL,
        chapterId TEXT NOT NULL,
        chapterName TEXT,
        paragraph INTEGER NOT NULL DEFAULT 0,
        progress REAL,
        snippet TEXT,
        createdAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_bookmarks_novel ON bookmarks(novelId);
      CREATE INDEX IF NOT EXISTS idx_bookmarks_chapter ON bookmarks(chapterId);
    `);
    await migrate(db);
    return db;
  });
}

async function migrate(db) {
  const cols = await db.getAllAsync('PRAGMA table_info(chapters)');
  const has = (name) => cols.some((c) => c.name === name);
  if (!has('lastReadAt')) {
    await db.execAsync('ALTER TABLE chapters ADD COLUMN lastReadAt INTEGER');
    await db.execAsync('UPDATE chapters SET lastReadAt = updatedAt WHERE read = 1 AND lastReadAt IS NULL');
  }
  await db.execAsync(
    'CREATE INDEX IF NOT EXISTS idx_chapters_last_read ON chapters(lastReadAt DESC);',
  );
  // These back the per-novel rollups (library progress, continue reading, unread badge). Without them every
  // navigation scanned and sorted thousands of chapter rows inside the main process, stalling every IPC call.
  await db.execAsync(`
    CREATE INDEX IF NOT EXISTS idx_chapters_novel_lastread ON chapters(novelId, lastReadAt DESC);
    CREATE INDEX IF NOT EXISTS idx_chapters_novel_read ON chapters(novelId, read);
    CREATE INDEX IF NOT EXISTS idx_chapters_updated ON chapters(updatedAt DESC);
  `);
}


export function upsertNovel(novel) {
  return serialize(async () => {
    const db = await getDb();
    await db.runAsync(
      `INSERT INTO novels (id, pluginId, path, title, author, cover, status, summary, genres, inLibrary, addedAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         title=excluded.title, author=excluded.author, cover=excluded.cover,
         status=excluded.status, summary=excluded.summary, genres=excluded.genres`,
         // NOTE: inLibrary is intentionally NOT overwritten on conflict, so browse/search upserts don't drop library members.
      [
        novel.id,
        novel.pluginId ?? null,
        novel.path ?? null,
        novel.title ?? 'Untitled',
        novel.author ?? null,
        novel.cover ?? null,
        novel.status ?? null,
        novel.summary ?? null,
        JSON.stringify(novel.genres ?? []),
        novel.inLibrary ? 1 : 0,
        novel.addedAt ?? Date.now(),
      ],
    );
  });
}

export function setInLibrary(novelId, inLibrary) {
  return serialize(async () => {
    const db = await getDb();
    await db.runAsync('UPDATE novels SET inLibrary = ? WHERE id = ?', [inLibrary ? 1 : 0, novelId]);
  });
}

export function deleteNovel(novelId) {
  return serialize(async () => {
    const db = await getDb();
    await db.runAsync('DELETE FROM chapters WHERE novelId = ?', [novelId]);
    await db.runAsync('DELETE FROM novels WHERE id = ?', [novelId]);
    await db.runAsync('DELETE FROM downloads WHERE novelId = ?', [novelId]);
  });
}

function mapNovel(row) {
  if (!row) return null;
  let genres = [];
  try {
    genres = JSON.parse(row.genres || '[]');
  } catch {}
  return { ...row, genres, inLibrary: !!row.inLibrary };
}

export function getNovel(novelId) {
  return serialize(async () => {
    const db = await getDb();
    return mapNovel(await db.getFirstAsync('SELECT * FROM novels WHERE id = ?', [novelId]));
  });
}

export function getLibrary() {
  return serialize(async () => {
    const db = await getDb();
    const rows = await db.getAllAsync(
      `SELECT n.*,
         (SELECT COUNT(*) FROM chapters c WHERE c.novelId = n.id) AS totalChapters,
         (SELECT COUNT(*) FROM chapters c WHERE c.novelId = n.id AND c.read = 1) AS readChapters
       FROM novels n WHERE n.inLibrary = 1 ORDER BY n.title COLLATE NOCASE`,
    );
    return rows.map((r) => {
      const n = mapNovel(r);
      const total = r.totalChapters || 0;
      const read = r.readChapters || 0;
      return { ...n, totalChapters: total, readChapters: read, unread: Math.max(total - read, 0) };
    });
  });
}

export function replaceChapters(novelId, chapters) {
  return serialize(async () => {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      for (let i = 0; i < chapters.length; i += 1) {
        const c = chapters[i];
        const id = c.id ?? `${novelId}::${c.path ?? i}`;
        await db.runAsync(
          `INSERT INTO chapters (id, novelId, path, name, releaseTime, number, updatedAt)
           VALUES (?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET name=excluded.name, releaseTime=excluded.releaseTime, number=excluded.number`,
          [id, novelId, c.path ?? null, c.name ?? `Chapter ${i + 1}`, c.releaseTime ?? null, i + 1, Date.now()],
        );
      }
    });
  });
}

/** Lightweight list fetch: excludes the downloadedText body and exposes a `downloaded` flag; use getChaptersFull when text is needed. */
export function getChapters(novelId) {
  return serialize(async () => {
    const db = await getDb();
    const rows = await db.getAllAsync(
      `SELECT id, novelId, path, name, releaseTime, number, read, progress,
              lastReadAt, updatedAt,
              downloadedText IS NOT NULL AS downloaded
         FROM chapters WHERE novelId = ? ORDER BY number ASC`,
      [novelId],
    );
    return rows.map((r) => ({ ...r, read: !!r.read, downloaded: !!r.downloaded }));
  });
}

/** Full fetch including downloadedText, for the reader and migrations only. */
export function getChaptersFull(novelId) {
  return serialize(async () => {
    const db = await getDb();
    const rows = await db.getAllAsync('SELECT * FROM chapters WHERE novelId = ? ORDER BY number ASC', [novelId]);
    return rows.map((r) => ({ ...r, read: !!r.read }));
  });
}

export function getChapter(chapterId) {
  return serialize(async () => {
    const db = await getDb();
    const row = await db.getFirstAsync('SELECT * FROM chapters WHERE id = ?', [chapterId]);
    return row ? { ...row, read: !!row.read } : null;
  });
}

export function getAdjacentChapters(novelId, number) {
  return serialize(async () => {
    const db = await getDb();
    const prev = await db.getFirstAsync(
      'SELECT * FROM chapters WHERE novelId = ? AND number < ? ORDER BY number DESC LIMIT 1',
      [novelId, number],
    );
    const next = await db.getFirstAsync(
      'SELECT * FROM chapters WHERE novelId = ? AND number > ? ORDER BY number ASC LIMIT 1',
      [novelId, number],
    );
    return { prev: prev ?? null, next: next ?? null };
  });
}

export function markChapterRead(chapterId, read = true) {
  return serialize(async () => {
    const db = await getDb();
    await db.runAsync(
      'UPDATE chapters SET read = ?, progress = ?, lastReadAt = CASE WHEN ? THEN ? ELSE lastReadAt END WHERE id = ?',
      [read ? 1 : 0, read ? 1 : 0, read ? 1 : 0, Date.now(), chapterId],
    );
  });
}

export function markChaptersRead(chapterIds, read = true) {
  const ids = Array.from(new Set((chapterIds ?? []).filter(Boolean)));
  if (!ids.length) return Promise.resolve();
  return serialize(async () => {
    const db = await getDb();
    const now = Date.now();
    await db.withTransactionAsync(async () => {
      for (let i = 0; i < ids.length; i += 1) {
        await db.runAsync(
          'UPDATE chapters SET read = ?, progress = ?, lastReadAt = CASE WHEN ? THEN ? ELSE lastReadAt END WHERE id = ?',
          [read ? 1 : 0, read ? 1 : 0, read ? 1 : 0, now, ids[i]],
        );
      }
    });
  });
}

export function touchChapterRead(chapterId, at = Date.now()) {
  return serialize(async () => {
    const db = await getDb();
    await db.runAsync('UPDATE chapters SET lastReadAt = ? WHERE id = ?', [at, chapterId]);
  });
}

export function saveChapterProgress(chapterId, progress) {
  const clamped = Math.max(0, Math.min(1, Number(progress) || 0));
  return serialize(async () => {
    const db = await getDb();
    await db.runAsync('UPDATE chapters SET progress = MAX(progress, ?), lastReadAt = ? WHERE id = ?', [
      clamped,
      Date.now(),
      chapterId,
    ]);
  });
}

export function getHistory(limit = 200) {
  return serialize(async () => {
    const db = await getDb();
    const rows = await db.getAllAsync(
      `SELECT c.id, c.novelId, c.name, c.number, c.read, c.progress, c.lastReadAt,
              c.downloadedText IS NOT NULL AS downloaded,
              n.title AS novelTitle, n.cover AS novelCover
         FROM chapters c JOIN novels n ON n.id = c.novelId
        WHERE c.lastReadAt IS NOT NULL
        ORDER BY c.lastReadAt DESC
        LIMIT ?`,
      [limit],
    );
    return rows.map((r) => ({ ...r, read: !!r.read, downloaded: !!r.downloaded }));
  });
}

export function removeHistoryEntry(chapterId) {
  return serialize(async () => {
    const db = await getDb();
    await db.runAsync('UPDATE chapters SET lastReadAt = NULL WHERE id = ?', [chapterId]);
  });
}

export function clearHistory() {
  return serialize(async () => {
    const db = await getDb();
    await db.runAsync('UPDATE chapters SET lastReadAt = NULL');
  });
}


export function saveChapterText(chapterId, text) {
  return serialize(async () => {
    const db = await getDb();
    await db.runAsync('UPDATE chapters SET downloadedText = ? WHERE id = ?', [text, chapterId]);
  });
}

export function deleteChapterText(chapterId) {
  return serialize(async () => {
    const db = await getDb();
    await db.runAsync('UPDATE chapters SET downloadedText = NULL WHERE id = ?', [chapterId]);
  });
}

/** Inserts migrated chapters; `state` maps index -> { read, progress, downloadedText, updatedAt }. */
export function insertChaptersWithState(novelId, chapters, state = new Map()) {
  return serialize(async () => {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      for (let i = 0; i < chapters.length; i += 1) {
        const c = chapters[i];
        const st = state.get(i) ?? {};
        await db.runAsync(
          `INSERT INTO chapters (id, novelId, path, name, releaseTime, number, read, progress, downloadedText, updatedAt)
           VALUES (?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             name=excluded.name, releaseTime=excluded.releaseTime, number=excluded.number,
             read=excluded.read, progress=excluded.progress,
             downloadedText=excluded.downloadedText, updatedAt=excluded.updatedAt`,
          [
            c.id,
            novelId,
            c.path ?? null,
            c.name ?? `Chapter ${i + 1}`,
            c.releaseTime ?? null,
            i + 1,
            st.read ? 1 : 0,
            st.progress ?? 0,
            st.downloadedText ?? null,
            st.updatedAt ?? Date.now(),
            st.lastReadAt ?? null,
          ],
        );
      }
    });
  });
}

export function getRecentUpdates(limit = 100) {
  return serialize(async () => {
    const db = await getDb();
    const rows = await db.getAllAsync(
      `SELECT c.id, c.novelId, c.path, c.name, c.releaseTime, c.number, c.read,
              c.progress, c.lastReadAt, c.updatedAt,
              c.downloadedText IS NOT NULL AS downloaded,
              n.title AS novelTitle, n.cover AS novelCover
         FROM chapters c JOIN novels n ON n.id = c.novelId
        WHERE n.inLibrary = 1
        ORDER BY c.updatedAt DESC, c.number DESC
        LIMIT ?`,
      [limit],
    );
    return rows.map((r) => ({ ...r, read: !!r.read, downloaded: !!r.downloaded }));
  });
}

export function savePlugin(plugin) {
  return serialize(async () => {
    const db = await getDb();
    await db.runAsync(
      `INSERT INTO plugins (id, name, version, lang, iconUrl, site, repoUrl, code, installedAt)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, version=excluded.version,
         lang=excluded.lang, iconUrl=excluded.iconUrl, site=excluded.site,
         repoUrl=excluded.repoUrl, code=excluded.code, installedAt=excluded.installedAt`,
      [
        plugin.id,
        plugin.name ?? plugin.id,
        plugin.version ?? '0.0.0',
        plugin.lang ?? 'unknown',
        plugin.iconUrl ?? null,
        plugin.site ?? null,
        plugin.repoUrl ?? null,
        plugin.code,
        Date.now(),
      ],
    );
  });
}

export function getPlugins() {
  return serialize(async () => {
    const db = await getDb();
    return db.getAllAsync('SELECT * FROM plugins ORDER BY name COLLATE NOCASE');
  });
}

export function getPlugin(id) {
  return serialize(async () => {
    const db = await getDb();
    return db.getFirstAsync('SELECT * FROM plugins WHERE id = ?', [id]);
  });
}

export function deletePlugin(id) {
  return serialize(async () => {
    const db = await getDb();
    await db.runAsync('DELETE FROM plugins WHERE id = ?', [id]);
  });
}

export function getStorageStats() {
  return serialize(async () => {
    const db = await getDb();
    const novels = await db.getFirstAsync('SELECT COUNT(*) AS c FROM novels');
    const chapters = await db.getFirstAsync('SELECT COUNT(*) AS c FROM chapters');
    const downloaded = await db.getFirstAsync(
      'SELECT COUNT(*) AS c FROM chapters WHERE downloadedText IS NOT NULL',
    );
    const plugins = await db.getFirstAsync('SELECT COUNT(*) AS c FROM plugins');
    const bookmarks = await db.getFirstAsync('SELECT COUNT(*) AS c FROM bookmarks');
    return {
      novels: novels?.c ?? 0,
      chapters: chapters?.c ?? 0,
      downloaded: downloaded?.c ?? 0,
      plugins: plugins?.c ?? 0,
      bookmarks: bookmarks?.c ?? 0,
    };
  });
}

export function clearDownloads() {
  return serialize(async () => {
    const db = await getDb();
    await db.runAsync('UPDATE chapters SET downloadedText = NULL');
    // Otherwise the Downloads screen would keep listing these as Completed after the content was wiped.
    await db.runAsync('DELETE FROM downloads WHERE status = ?', ['completed']);
  });
}

export function getDownloadQueue() {
  return serialize(async () => {
    const db = await getDb();
    return db.getAllAsync(
      `SELECT d.chapterId, d.novelId, d.status, d.queuePos, d.error, d.createdAt, d.updatedAt,
              c.name AS chapterName, c.number AS chapterNumber,
              n.title AS novelTitle, n.cover AS novelCover
         FROM downloads d
         JOIN chapters c ON c.id = d.chapterId
         JOIN novels n ON n.id = d.novelId
        ORDER BY d.queuePos ASC, d.createdAt ASC`,
    );
  });
}

export function upsertDownloadQueueItems(items) {
  if (!items?.length) return Promise.resolve();
  return serialize(async () => {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      for (const it of items) {
        await db.runAsync(
          `INSERT INTO downloads (chapterId, novelId, status, queuePos, error, createdAt, updatedAt)
           VALUES (?,?,?,?,?,?,?)
           ON CONFLICT(chapterId) DO UPDATE SET
             status=excluded.status, queuePos=excluded.queuePos, error=excluded.error, updatedAt=excluded.updatedAt`,
          [
            it.chapterId,
            it.novelId,
            it.status,
            it.queuePos ?? null,
            it.error ?? null,
            it.createdAt ?? Date.now(),
            it.updatedAt ?? Date.now(),
          ],
        );
      }
    });
  });
}

export function removeDownloadQueueItems(chapterIds) {
  const ids = (chapterIds ?? []).filter(Boolean);
  if (!ids.length) return Promise.resolve();
  return serialize(async () => {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      for (const id of ids) {
        await db.runAsync('DELETE FROM downloads WHERE chapterId = ?', [id]);
      }
    });
  });
}

/** Backup snapshot: library novels plus any with read/history state. downloadedText is intentionally excluded. */
export function getBackupSnapshot() {
  return serialize(async () => {
    const db = await getDb();
    const novels = await db.getAllAsync(
      `SELECT DISTINCT n.* FROM novels n
         LEFT JOIN chapters c ON c.novelId = n.id
        WHERE n.inLibrary = 1 OR c.read = 1 OR c.lastReadAt IS NOT NULL`,
    );
    const out = [];
    for (const row of novels) {
      const novel = mapNovel(row);
      const chapters = await db.getAllAsync(
        `SELECT id, path, name, releaseTime, number, read, progress, lastReadAt, updatedAt
           FROM chapters WHERE novelId = ? ORDER BY number ASC`,
        [novel.id],
      );
      out.push({ ...novel, chapters: chapters.map((c) => ({ ...c, read: !!c.read })) });
    }
    return out;
  });
}

/** Installed-extension metadata only, no `code`. Kept in backups for reference only. */
export function getExtensionsMeta() {
  return serialize(async () => {
    const db = await getDb();
    return db.getAllAsync(
      'SELECT id, name, version, lang, iconUrl, site, repoUrl, installedAt FROM plugins ORDER BY name COLLATE NOCASE',
    );
  });
}

/** Restores a backup atomically; unlike upsertNovel, inLibrary is overwritten and downloadedText is never written. */
export function restoreLibrarySnapshot(novels) {
  return serialize(async () => {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      for (const novel of novels) {
        await db.runAsync(
          `INSERT INTO novels (id, pluginId, path, title, author, cover, status, summary, genres, inLibrary, addedAt)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             pluginId=excluded.pluginId, path=excluded.path, title=excluded.title, author=excluded.author,
             cover=excluded.cover, status=excluded.status, summary=excluded.summary, genres=excluded.genres,
             inLibrary=excluded.inLibrary`,
          [
            novel.id,
            novel.pluginId ?? null,
            novel.path ?? null,
            novel.title ?? 'Untitled',
            novel.author ?? null,
            novel.cover ?? null,
            novel.status ?? null,
            novel.summary ?? null,
            JSON.stringify(novel.genres ?? []),
            novel.inLibrary ? 1 : 0,
            novel.addedAt ?? Date.now(),
          ],
        );
        const chapters = Array.isArray(novel.chapters) ? novel.chapters : [];
        for (let i = 0; i < chapters.length; i += 1) {
          const c = chapters[i];
          if (!c?.id) continue;
          await db.runAsync(
            `INSERT INTO chapters (id, novelId, path, name, releaseTime, number, read, progress, lastReadAt, updatedAt)
             VALUES (?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET
               path=excluded.path, name=excluded.name, releaseTime=excluded.releaseTime, number=excluded.number,
               read=excluded.read, progress=excluded.progress, lastReadAt=excluded.lastReadAt, updatedAt=excluded.updatedAt`,
            [
              c.id,
              novel.id,
              c.path ?? null,
              c.name ?? `Chapter ${i + 1}`,
              c.releaseTime ?? null,
              c.number ?? i + 1,
              c.read ? 1 : 0,
              Number(c.progress) || 0,
              c.lastReadAt ?? null,
              c.updatedAt ?? Date.now(),
            ],
          );
        }
      }
    });
  });
}

/* ------------------------------------------------------------------ *
 * Desktop additions
 * ------------------------------------------------------------------ */

/* --- key/value store (replaces the mobile AsyncStorage maps) ------- */

export function getKV(key) {
  return serialize(async () => {
    const db = await getDb();
    const row = await db.getFirstAsync('SELECT value FROM kv WHERE key = ?', [key]);
    if (!row) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  });
}

export function setKV(key, value) {
  return serialize(async () => {
    const db = await getDb();
    await db.runAsync(
      `INSERT INTO kv (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, JSON.stringify(value ?? null)],
    );
  });
}

export function deleteKV(key) {
  return serialize(async () => {
    const db = await getDb();
    await db.runAsync('DELETE FROM kv WHERE key = ?', [key]);
  });
}

/** All kv rows whose key starts with `prefix`, returned as { suffix: parsedValue }. */
export function getKVPrefix(prefix) {
  return serialize(async () => {
    const db = await getDb();
    const rows = await db.getAllAsync('SELECT key, value FROM kv WHERE key LIKE ?', [`${prefix}%`]);
    const out = {};
    for (const r of rows) {
      try {
        out[r.key.slice(prefix.length)] = JSON.parse(r.value);
      } catch {}
    }
    return out;
  });
}

/* --- bookmarks ----------------------------------------------------- */

/** `novelId` omitted = every bookmark across the library, newest first. */
export function getBookmarks(novelId) {
  return serialize(async () => {
    const db = await getDb();
    const rows = novelId
      ? await db.getAllAsync(
          `SELECT b.*, n.title AS novelTitle, n.cover AS novelCover
             FROM bookmarks b JOIN novels n ON n.id = b.novelId
            WHERE b.novelId = ? ORDER BY b.createdAt DESC`,
          [novelId],
        )
      : await db.getAllAsync(
          `SELECT b.*, n.title AS novelTitle, n.cover AS novelCover
             FROM bookmarks b JOIN novels n ON n.id = b.novelId
            ORDER BY b.createdAt DESC`,
        );
    return rows.map((r) => ({ ...r, progress: r.progress ?? 0 }));
  });
}

export function addBookmark(bookmark) {
  return serialize(async () => {
    const db = await getDb();
    const id = bookmark.id ?? `${bookmark.chapterId}::${bookmark.paragraph ?? 0}`;
    await db.runAsync(
      `INSERT INTO bookmarks (id, novelId, chapterId, chapterName, paragraph, progress, snippet, createdAt)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         snippet = excluded.snippet, progress = excluded.progress`,
      [
        id,
        bookmark.novelId,
        bookmark.chapterId,
        bookmark.chapterName ?? null,
        bookmark.paragraph ?? 0,
        bookmark.progress ?? null,
        bookmark.snippet ?? null,
        bookmark.createdAt ?? Date.now(),
      ],
    );
    return id;
  });
}

export function removeBookmark(id) {
  return serialize(async () => {
    const db = await getDb();
    await db.runAsync('DELETE FROM bookmarks WHERE id = ?', [id]);
  });
}

export function removeBookmarks(ids) {
  const list = (ids ?? []).filter(Boolean);
  if (!list.length) return Promise.resolve();
  return serialize(async () => {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      for (const id of list) await db.runAsync('DELETE FROM bookmarks WHERE id = ?', [id]);
    });
  });
}

export function clearBookmarks(novelId) {
  return serialize(async () => {
    const db = await getDb();
    if (novelId) await db.runAsync('DELETE FROM bookmarks WHERE novelId = ?', [novelId]);
    else await db.runAsync('DELETE FROM bookmarks');
  });
}

/** Bookmark ids for one chapter, for the reader panel. */
export function getChapterBookmarks(chapterId) {
  return serialize(async () => {
    const db = await getDb();
    return db.getAllAsync('SELECT * FROM bookmarks WHERE chapterId = ? ORDER BY paragraph ASC', [chapterId]);
  });
}

/* --- library queries the desktop UI needs --------------------------- */

/** One row per library novel with its most recently touched chapter, for "Continue reading". */
export function getContinueReading(limit = 12) {
  return serialize(async () => {
    const db = await getDb();
    return db.getAllAsync(
      `SELECT n.id AS novelId, n.title AS novelTitle, n.cover AS novelCover,
              c.id AS chapterId, c.name AS chapterName, c.number AS chapterNumber,
              c.progress, c.read, c.lastReadAt,
              c.downloadedText IS NOT NULL AS downloaded
         FROM chapters c
         JOIN novels n ON n.id = c.novelId
        WHERE n.inLibrary = 1 AND c.lastReadAt IS NOT NULL
          AND c.id = (SELECT c2.id FROM chapters c2
                       WHERE c2.novelId = n.id AND c2.lastReadAt IS NOT NULL
                       ORDER BY c2.lastReadAt DESC, c2.number DESC LIMIT 1)
        ORDER BY c.lastReadAt DESC
        LIMIT ?`,
      [limit],
    );
  });
}

/** Per-novel progress rollup used by the library list (latest chapter + read/unread/downloaded counts). */
export function getLibraryProgress() {
  return serialize(async () => {
    const db = await getDb();
    return db.getAllAsync(
      `SELECT n.id AS novelId,
              (SELECT COUNT(*) FROM chapters c WHERE c.novelId = n.id) AS totalChapters,
              (SELECT COUNT(*) FROM chapters c WHERE c.novelId = n.id AND c.read = 1) AS readChapters,
              (SELECT COUNT(*) FROM chapters c WHERE c.novelId = n.id AND c.downloadedText IS NOT NULL) AS downloadedChapters,
              (SELECT COUNT(*) FROM downloads d WHERE d.novelId = n.id AND d.status IN ('queued','downloading')) AS pendingDownloads,
              (SELECT c.id FROM chapters c WHERE c.novelId = n.id AND c.lastReadAt IS NOT NULL
                ORDER BY c.lastReadAt DESC LIMIT 1) AS lastChapterId,
              (SELECT c.name FROM chapters c WHERE c.novelId = n.id AND c.lastReadAt IS NOT NULL
                ORDER BY c.lastReadAt DESC LIMIT 1) AS lastChapterName,
              (SELECT c.number FROM chapters c WHERE c.novelId = n.id AND c.lastReadAt IS NOT NULL
                ORDER BY c.lastReadAt DESC LIMIT 1) AS lastChapterNumber,
              (SELECT MAX(c.lastReadAt) FROM chapters c WHERE c.novelId = n.id) AS lastReadAt
         FROM novels n
        WHERE n.inLibrary = 1`,
    );
  });
}

/** Library novels that still need an update check (source plugin + path present). */
export function getUpdatableNovels() {
  return serialize(async () => {
    const db = await getDb();
    const rows = await db.getAllAsync(
      `SELECT id, pluginId, path, title FROM novels
        WHERE inLibrary = 1 AND pluginId IS NOT NULL AND path IS NOT NULL
        ORDER BY title COLLATE NOCASE`,
    );
    return rows;
  });
}

/** Newest chapters discovered by the most recent update passes, grouped per novel. */
export function getNewChaptersSince(since, limit = 60) {
  return serialize(async () => {
    const db = await getDb();
    return db.getAllAsync(
      `SELECT c.id, c.novelId, c.name, c.number, c.read, c.updatedAt,
              n.title AS novelTitle, n.cover AS novelCover
         FROM chapters c JOIN novels n ON n.id = c.novelId
        WHERE n.inLibrary = 1 AND c.updatedAt >= ?
        ORDER BY c.updatedAt DESC, c.number DESC
        LIMIT ?`,
      [since, limit],
    );
  });
}

export function markAllChaptersRead(novelId) {
  return serialize(async () => {
    const db = await getDb();
    await db.runAsync('UPDATE chapters SET read = 1, progress = 1 WHERE novelId = ?', [novelId]);
  });
}

/** Marks every chapter before `number` as read - "mark previous read". */
export function markChaptersBeforeRead(novelId, number) {
  return serialize(async () => {
    const db = await getDb();
    await db.runAsync('UPDATE chapters SET read = 1, progress = 1 WHERE novelId = ? AND number < ?', [
      novelId,
      number,
    ]);
  });
}

/** Removes a chapter row entirely (hard delete, used when a source drops a chapter). */
export function deleteChapter(chapterId) {
  return serialize(async () => {
    const db = await getDb();
    await db.runAsync('DELETE FROM downloads WHERE chapterId = ?', [chapterId]);
    await db.runAsync('DELETE FROM bookmarks WHERE chapterId = ?', [chapterId]);
    await db.runAsync('DELETE FROM chapters WHERE id = ?', [chapterId]);
  });
}

/** Drop downloaded text for one novel only. */
export function deleteNovelDownloads(novelId) {
  return serialize(async () => {
    const db = await getDb();
    await db.runAsync('UPDATE chapters SET downloadedText = NULL WHERE novelId = ?', [novelId]);
    await db.runAsync(
      'DELETE FROM downloads WHERE novelId = ? AND status = ?',
      [novelId, 'completed'],
    );
  });
}

/** Bookmarks grouped by chapter, for the reader's bookmark panel across a novel. */
export function getNovelBookmarks(novelId) {
  return serialize(async () => {
    const db = await getDb();
    const rows = await db.getAllAsync(
      'SELECT * FROM bookmarks WHERE novelId = ? ORDER BY chapterName, paragraph ASC',
      [novelId],
    );
    const byChapter = new Map();
    for (const r of rows) {
      if (!byChapter.has(r.chapterId)) byChapter.set(r.chapterId, []);
      byChapter.get(r.chapterId).push(r);
    }
    return byChapter;
  });
}

/** Cheap sidebar badge: unread chapters in the library, capped at 100 (the badge shows "99+" anyway). */
export function getUnreadCount(cap = 100) {
  return serialize(async () => {
    const db = await getDb();
    const row = await db.getFirstAsync(
      `SELECT COUNT(*) AS c FROM (
         SELECT 1 FROM chapters c JOIN novels n ON n.id = c.novelId
          WHERE n.inLibrary = 1 AND c.read = 0 LIMIT ?)`,
      [cap],
    );
    return Number(row?.c ?? 0);
  });
}

let bytesCache = null;
/**
 * Approximate on-disk payload of stored chapter text, for the storage screen.
 * LENGTH() has to read every downloaded chapter body, which can take seconds for a big library and (SQLite runs
 * in the main process) freezes the whole app while it does. So the sum is taken in small batches, each its own
 * queue entry, letting navigation queries interleave, and the result is cached briefly.
 */
export async function getDownloadedBytes() {
  if (bytesCache && Date.now() - bytesCache.at < 60_000) return bytesCache.value;
  const ids = await serialize(async () => {
    const db = await getDb();
    return (await db.getAllAsync('SELECT id FROM chapters WHERE downloadedText IS NOT NULL')).map((r) => r.id);
  });
  let bytes = 0;
  for (let i = 0; i < ids.length; i += 25) {
    const batch = ids.slice(i, i + 25);
    bytes += await serialize(async () => {
      const db = await getDb();
      const row = await db.getFirstAsync(
        `SELECT COALESCE(SUM(LENGTH(downloadedText)), 0) AS b FROM chapters WHERE id IN (${batch.map(() => '?').join(',')})`,
        batch,
      );
      return Number(row?.b ?? 0);
    });
    await new Promise((r) => setTimeout(r, 0)); // let the main process handle other work between batches
  }
  bytesCache = { at: Date.now(), value: { bytes, count: ids.length } };
  return bytesCache.value;
}

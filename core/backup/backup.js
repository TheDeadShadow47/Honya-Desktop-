// Honya backup format, shared with the mobile app (lib/backup.js).
//
// { format, version, createdAt, appVersion, data: { prefs, chapterPrefs, repositories,
//   extensions, novels } }
//
// Chapter text and plugin source code are deliberately excluded; both are re-obtainable.

import { pickSafePrefs } from '../settings/defaults.js';

export const BACKUP_FORMAT = 'honya-backup';
export const BACKUP_VERSION = 1;

export class BackupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BackupError';
    this.code = code;
  }
}

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : null);

/**
 * Envelope + entry validation. Malformed individual entries are dropped; only envelope-level
 * problems throw. Returns the coerced payload plus a meta summary for the UI.
 */
export function validateBackupPayload(raw) {
  if (!isPlainObject(raw)) throw new BackupError('invalid', 'This is not a valid Honya backup file.');
  if (raw.format !== BACKUP_FORMAT) throw new BackupError('invalid', 'This is not a valid Honya backup file.');

  const version = Number(raw.version);
  if (!Number.isInteger(version) || version < 1) throw new BackupError('invalid', 'This backup file is corrupted.');
  if (version > BACKUP_VERSION) {
    throw new BackupError('tooNew', 'This backup was created by a newer version of Honya. Update the app to restore it.');
  }
  if (!isPlainObject(raw.data)) throw new BackupError('invalid', 'This backup file is corrupted.');

  const data = raw.data;

  const novels = (Array.isArray(data.novels) ? data.novels : [])
    .filter((n) => isPlainObject(n) && typeof n.id === 'string' && n.id)
    .map((n) => ({
      id: n.id,
      pluginId: str(n.pluginId),
      path: str(n.path),
      title: typeof n.title === 'string' && n.title ? n.title : 'Untitled',
      author: str(n.author),
      cover: str(n.cover),
      status: str(n.status),
      summary: str(n.summary),
      genres: Array.isArray(n.genres) ? n.genres : [],
      inLibrary: !!n.inLibrary,
      addedAt: Number(n.addedAt) || Date.now(),
      chapters: (Array.isArray(n.chapters) ? n.chapters : [])
        .filter((c) => isPlainObject(c) && typeof c.id === 'string' && c.id)
        .map((c) => ({
          id: c.id,
          path: str(c.path),
          name: str(c.name),
          releaseTime: str(c.releaseTime),
          number: Number(c.number) || 0,
          read: !!c.read,
          progress: Number(c.progress) || 0,
          lastReadAt: Number(c.lastReadAt) || null,
          updatedAt: Number(c.updatedAt) || Date.now(),
        })),
    }));

  const repositories = (Array.isArray(data.repositories) ? data.repositories : []).filter((u) => /^https?:\/\//i.test(String(u)));

  // Kept for reference only; extension code is never restored from a backup.
  const extensions = (Array.isArray(data.extensions) ? data.extensions : []).filter(
    (e) => isPlainObject(e) && typeof e.id === 'string' && e.id,
  );

  const prefs = isPlainObject(data.prefs) ? data.prefs : {};
  const chapterPrefs = isPlainObject(data.chapterPrefs) ? data.chapterPrefs : {};

  const chapterCount = novels.reduce((sum, n) => sum + n.chapters.length, 0);

  return {
    novels,
    repositories,
    extensions,
    prefs,
    chapterPrefs,
    meta: {
      createdAt: Number(raw.createdAt) || null,
      appVersion: typeof raw.appVersion === 'string' ? raw.appVersion : null,
      novelCount: novels.length,
      chapterCount,
      extensionCount: extensions.length,
    },
  };
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/* --- payload assembly / restore ---------------------------------------- */

/**
 * Full backup payload, matching the mobile format so backups are interchangeable.
 * `envelope` fills the format/version metadata; the caller supplies appVersion.
 */
export async function buildBackupPayload(db, { appVersion = null, createdAt = Date.now() } = {}) {
  const prefs = (await db.getKV('prefs')) ?? {};
  const data = {
    prefs,
    chapterPrefs: (await db.getKV('chapterPrefs')) ?? {},
    repositories: Array.isArray(prefs.repositories) ? prefs.repositories : [],
    extensions: await db.getExtensionsMeta(),
    novels: await db.getBackupSnapshot(),
  };
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, createdAt, appVersion, data };
}

/**
 * Restore a validated backup.
 *
 * Prefs come from an untrusted file, so only keys the app knows about AND whose type matches the
 * default are applied (Android: store/useStore.js restoreBackup). Repositories are merged, never
 * replaced. restoreLibrarySnapshot overwrites inLibrary (unlike upsertNovel) and never writes
 * downloadedText, so local offline copies survive an import.
 */
export async function restoreBackupPayload(db, payload, { defaults } = {}) {
  const validated = validateBackupPayload(payload);
  const safePrefs = defaults ? pickSafePrefs(validated.prefs, defaults) : {};
  const current = (await db.getKV('prefs')) ?? {};
  const merged = { ...(defaults ?? {}), ...current, ...safePrefs };
  merged.repositories = Array.from(new Set([...(current.repositories ?? []), ...validated.repositories]));
  await db.setKV('prefs', merged);
  await db.setKV('chapterPrefs', { ...((await db.getKV('chapterPrefs')) ?? {}), ...validated.chapterPrefs });
  await db.restoreLibrarySnapshot(validated.novels);
  return validated.meta;
}
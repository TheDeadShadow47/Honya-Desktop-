// Honya Desktop preference defaults. Single source of truth for both processes: the renderer
// settings store and the main-process backup restore both read this file, so a key can never be
// accepted by one and ignored by the other.
//
// Key names follow Honya Android (store/useStore.js DEFAULT_PREFS) wherever the same setting exists,
// so a mobile backup restores with its values intact. Desktop-only additions live in `reader`
// (typography/width/TTS) and keep the flat Android naming for the shared switches.

export const PREFS_KEY = 'prefs';
export const CHAPTER_PREFS_KEY = 'chapterPrefs';

export const DEFAULTS = {
  // Appearance
  theme: 'honya',
  language: 'en',

  // Library presentation
  gridColumns: 4, // legacy (Android) column count, kept for backup compatibility
  coverSize: 160, // desktop: minimum cover width in px; the grid fits as many columns as the window allows
  librarySort: 'title',
  libraryView: 'grid',

  // Reader
  reader: {
    background: 'dark',
    fontSize: 19,
    lineHeight: 1.75,
    fontFamily: 'serif',
    width: 720,
    padding: 32,
    justify: false,
    // Keep scrolling into the next chapter (Honya Android behaviour). Off = one chapter per page, as before.
    continuous: true,
    markReadOnOpen: false,
    ttsRate: 1,
    ttsPitch: 1,
    ttsVoice: '',
    ttsAutoNext: true,
  },

  // Downloads
  downloadConcurrency: 1,
  notifyDownloadStart: true,
  notifyDownloadComplete: true,
  notifyDownloadFailed: true,

  // Updates
  autoUpdateInterval: 'never',
  notifyNewChaptersFound: true,
  notifyUpdateComplete: true,
  notifyUpdateFailed: true,

  // Notifications master switch (mobile: notificationsEnabled)
  notificationsEnabled: true,

  // Per-novel chapter list preferences (mobile: lib/chapterPrefs.js)
  chapterPrefs: {},

  // Repositories live here so backup/restore covers them.
  repositories: [],

  // Discord Rich Presence. showBrowsing: also show what you are doing outside the reader (library, search, ...)
  discord: { enabled: false, showTitle: true, showChapter: true, showTime: true, showBrowsing: true },
};

/** Keys a backup may write, mirroring Android's DEFAULT_PREFS allow-list. */
export const DEFAULT_PREF_KEYS = Object.keys(DEFAULTS);

/**
 * Filter untrusted backup prefs down to keys the app knows about AND whose type matches the
 * default, exactly like Android (store/useStore.js restoreBackup). Nested objects are checked
 * recursively so a hand-edited file cannot smuggle a string where a shape is expected.
 */
export function pickSafePrefs(incoming, defaults = DEFAULTS) {
  const safe = {};
  if (!incoming || typeof incoming !== 'object') return safe;
  for (const key of Object.keys(defaults)) {
    if (!(key in incoming)) continue;
    const want = defaults[key];
    const got = incoming[key];
    if (want !== null && typeof want === 'object' && !Array.isArray(want)) {
      if (!got || typeof got !== 'object' || Array.isArray(got)) continue;
      const nested = pickSafePrefs(got, want);
      // an empty nested result means nothing in the incoming object was recognised
      if (Object.keys(nested).length) safe[key] = { ...want, ...nested };
      continue;
    }
    if (typeof got === typeof want) safe[key] = got;
  }
  return safe;
}

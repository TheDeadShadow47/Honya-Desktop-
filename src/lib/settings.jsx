import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { THEMES, isThemeDark } from '@core/theme/theme.js';
import { setLanguage, applyDirection, getLanguage, isRTL, t } from '@core/i18n/i18n.js';
import { CHAPTER_PREFS_KEY, DEFAULTS, PREFS_KEY } from '@core/settings/defaults.js';
import { db, prefs } from './api';

// Honya Desktop preferences.
//
// Android's AsyncStorage @honya/prefs is replaced by the SQLite `kv` table, so preferences are
// transactional, survive a renderer crash and take part in backup/restore. The defaults live in
// core/settings/defaults.js because the main process needs the same key list for backup restore.

export { PREFS_KEY, CHAPTER_PREFS_KEY, DEFAULTS };

const mergePrefs = (raw) => {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    ...DEFAULTS,
    ...r,
    reader: { ...DEFAULTS.reader, ...(r.reader ?? {}) },
    discord: { ...DEFAULTS.discord, ...(r.discord ?? {}) },
    chapterPrefs: r.chapterPrefs && typeof r.chapterPrefs === 'object' ? r.chapterPrefs : {},
    repositories: Array.isArray(r.repositories) ? r.repositories.filter((u) => typeof u === 'string') : [],
  };
};

// Deep-ish merge for nested objects (reader / discord), arrays replace.
export const applyPrefsPatch = (base, patch) => {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch ?? {})) {
    out[k] =
      v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])
        ? { ...base[k], ...v }
        : v;
  }
  return out;
};

const Ctx = createContext(null);

export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState(() => mergePrefs(null));
  const [ready, setReady] = useState(false);
  const saveTimer = useRef(null);

  // Load persisted preferences from SQLite. Until this resolves the app renders with defaults, which is the same
  // first-frame behaviour as the mobile store's `ready` flag.
  // IMPORTANT: if the read FAILS we must not mark the store ready, otherwise the defaults would be written back over
  // the real preferences (including saved repositories). A failed load is retried; nothing is saved until it succeeds.
  useEffect(() => {
    let alive = true;
    (async () => {
      for (let attempt = 0; attempt < 5 && alive; attempt += 1) {
        try {
          const stored = await db.getKV(PREFS_KEY);
          if (!alive) return;
          setSettings(mergePrefs(stored));
          setReady(true);
          return;
        } catch (e) {
          console.warn('[settings] could not read preferences, retrying', e?.message);
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const theme = THEMES[settings.theme] ?? THEMES.honya;

  // setLanguage must run before children render so their t() calls already return the new strings.
  if (getLanguage() !== settings.language) setLanguage(settings.language);

  // Persist. Slider drags are coalesced (120ms), but a change to the repository list is written immediately, and
  // anything still pending is flushed when the window closes, so adding a repository can never be lost on quit.
  const latest = useRef(settings);
  latest.current = settings;
  const dirty = useRef(false);
  const lastRepos = useRef(null);
  const flush = useCallback(() => {
    clearTimeout(saveTimer.current);
    dirty.current = false;
    // The main process caches prefs (downloads, notifications, Discord); tell it once the new values are on disk.
    return db
      .setKV(PREFS_KEY, latest.current)
      .then(() => prefs.invalidate())
      .catch((e) => {
        dirty.current = true;
        console.warn('[settings] save failed', e?.message);
      });
  }, []);
  useEffect(() => {
    if (!ready) return undefined;
    if (lastRepos.current === null) {
      lastRepos.current = settings.repositories; // first run after load: nothing changed yet, nothing to write
      return undefined;
    }
    dirty.current = true;
    const urgent = lastRepos.current !== settings.repositories;
    lastRepos.current = settings.repositories;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flush, urgent ? 0 : 120);
    return () => clearTimeout(saveTimer.current);
  }, [settings, ready, flush]);
  useEffect(() => {
    const onLeave = () => dirty.current && flush();
    window.addEventListener('pagehide', onLeave);
    window.addEventListener('beforeunload', onLeave);
    return () => {
      window.removeEventListener('pagehide', onLeave);
      window.removeEventListener('beforeunload', onLeave);
    };
  }, [flush]);

  // Honya theme tokens become CSS variables, so the whole UI re-themes with one assignment.
  useEffect(() => {
    const el = document.documentElement;
    for (const [k, v] of Object.entries(theme)) if (typeof v === 'string' && v.startsWith('#')) el.style.setProperty(`--${k}`, v);
    el.style.colorScheme = isThemeDark(theme) ? 'dark' : 'light';
    el.lang = settings.language;
    applyDirection();
    el.dir = isRTL() ? 'rtl' : 'ltr';
  }, [theme, settings.language]);

  const update = useCallback((patch) => setSettings((s) => applyPrefsPatch(s, patch)), []);
  const replaceAll = useCallback((next) => setSettings(mergePrefs(next)), []);

  const value = useMemo(
    () => ({ settings, update, replaceAll, theme, ready, t }),
    [settings, update, replaceAll, theme, ready],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useSettings = () => useContext(Ctx);

/** Translation function bound to the current language. Re-renders on language change. */
export const useI18n = () => useContext(Ctx).t;
export const useT = useI18n;
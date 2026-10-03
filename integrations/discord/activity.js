// Pure builder: reading-session state + user options -> a Discord activity object.
// Only the novel title and chapter label are ever sent (never paths, URLs, plugin ids or history).
import { LARGE_IMAGE_KEY, APP_NAME } from './config.js';

const BAD = /^(undefined|null|unknown|nan|\[object object\])$/i;

/** Trimmed single-line string, or '' for null/undefined/objects and placeholder text. */
export const clean = (v) => {
  if (v === null || v === undefined || typeof v === 'object') return '';
  const s = String(v).replace(/\s+/g, ' ').trim();
  return BAD.test(s) ? '' : s;
};

const clip = (s, max = 128) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/** "Chapter 86", or the chapter's own title when it carries more information. '' when nothing is known. */
export function chapterLabel(chapter) {
  const name = clean(chapter?.name);
  const n = Number(clean(chapter?.number));
  const num = Number.isFinite(n) && n > 0 ? String(n) : '';
  if (name) {
    const hasNum = !num || new RegExp(`(^|\\D)${num.replace('.', '\\.')}(\\D|$)`).test(name);
    return clip(hasNum ? name : `Chapter ${num} · ${name}`);
  }
  return num ? `Chapter ${num}` : '';
}

export function buildActivity(session, opts = {}, startedAt = session?.startedAt) {
  const { showTitle = true, showChapter = true, showTime = true } = opts;
  const title = clean(session?.novel?.title);
  const activity = {
    type: 0,
    details: showTitle && title ? `Reading ${clip(title, 120)}` : 'Reading a novel',
    assets: { large_image: LARGE_IMAGE_KEY, large_text: APP_NAME },
  };
  const label = showChapter ? chapterLabel(session?.chapter) : '';
  if (label.length >= 2) activity.state = label; // Discord rejects 1-character fields
  if (showTime && Number.isFinite(startedAt)) activity.timestamps = { start: Math.floor(startedAt / 1000) };
  return activity;
}

/** What each non-reader screen shows. Generic on purpose: no search text, source names, ids or paths are ever sent. */
export const SCREEN_DETAILS = {
  library: 'Browsing the library',
  updates: 'Checking for new chapters',
  history: 'Looking through reading history',
  catalogs: 'Browsing catalogs',
  browse: 'Browsing a source',
  search: 'Searching for a novel',
  downloads: 'Managing downloads',
  settings: 'Adjusting settings',
  novel: 'Viewing a novel',
};

/** Activity for "not in the reader". `screen` = { name, title? }. Returns null for an unknown screen. */
export function buildScreenActivity(screen, opts = {}, startedAt) {
  const { showTitle = true, showTime = true } = opts;
  const base = SCREEN_DETAILS[screen?.name];
  if (!base) return null;
  const title = clean(screen?.title);
  const activity = {
    type: 0,
    details: screen.name === 'novel' && showTitle && title ? `Viewing ${clip(title, 120)}` : base,
    assets: { large_image: LARGE_IMAGE_KEY, large_text: APP_NAME },
  };
  if (showTime && Number.isFinite(startedAt)) activity.timestamps = { start: Math.floor(startedAt / 1000) };
  return activity;
}

// Pure logic behind the continuous-scroll reader. No DOM, no React, no IPC: everything here is unit-tested in Node
// (scripts/reader-logic-test.mjs) so the fiddly rules can be verified without a browser.
//
// Model (ported from the Honya Desktop reference build, then hardened):
//   * The reader shows an ordered list of chapter "segments" in ONE scroll container.
//   * The ACTIVE chapter is the last segment whose top edge is above a probe line 35% down the viewport.
//   * When the viewport gets within ~1.5 screens of the end, the next chapter is appended (never duplicated).
//   * Progress is stored per chapter with the same formula the single-chapter reader always used, generalised to a
//     segment: 0 when the segment's top is at the top of the viewport, 1 when its bottom reaches the viewport's bottom.
//   * Memory: only segments near the active one keep DOM nodes (others collapse to a fixed-height spacer so scroll
//     positions never shift); text of segments far away is released and re-fetched when the reader returns.

export const PROBE = 0.35; // fraction of the viewport height at which the "active chapter" is decided
export const APPEND_AHEAD = 1.5; // append the next chapter when this many viewports (or fewer) remain below
export const MOUNT_RADIUS = 2; // segments within this many chapters of the active one keep their DOM
export const REHYDRATE_RADIUS = 4; // released segments this close to the active one are re-loaded
export const KEEP_TEXT_RADIUS = 8; // text of segments farther than this is released (kept as a spacer)
export const READ_THRESHOLD = 0.98; // progress at/above which a chapter counts as finished (same as the legacy reader)

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Paragraphs exactly as the legacy reader split them. */
export const splitParas = (text) => (text ? String(text).split(/\n{1,}/).filter(Boolean) : []);

/**
 * Reading progress (0..1) of one segment.
 * For a segment that is the whole scroller (top 0, height = scrollHeight) this equals the legacy
 * `scrollTop / (scrollHeight - clientHeight)`, so progress saved by older builds keeps its meaning.
 */
export function segProgress(scrollTop, viewport, top, height) {
  const span = height - viewport;
  if (span <= 1) return scrollTop + viewport >= top + height - 1 ? 1 : 0; // chapter shorter than the window
  return clamp((scrollTop - top) / span, 0, 1);
}

/** Inverse of segProgress, for restoring a saved position. Finished/untouched chapters open at their top. */
export function scrollTopForProgress(progress, top, height, viewport) {
  const p = Number(progress) || 0;
  if (!(p > 0.01 && p < READ_THRESHOLD)) return top;
  return top + p * Math.max(height - viewport, 0);
}

/** Index of the active segment: the last one whose top is at/above the probe line. `tops[i]` may be null (not laid out). */
export function pickActiveIndex(tops, probe) {
  let active = 0;
  for (let i = 0; i < tops.length; i += 1) if (tops[i] != null && tops[i] <= probe) active = i;
  return active;
}

/** True when the viewport is close enough to the end of the content that the next chapter should load. */
export function shouldAppend({ scrollHeight, scrollTop, clientHeight, ahead = APPEND_AHEAD }) {
  return scrollHeight - scrollTop - clientHeight < clientHeight * ahead;
}

/** Appending never duplicates a chapter, even if two loads race. Returns the same array when nothing changes. */
export function appendUnique(list, seg) {
  return list.some((s) => s.id === seg.id) ? list : [...list, seg];
}

/** The chapter after `id` in the (number-ordered) chapter list, or null. */
export function chapterAfter(chapters, id) {
  const i = chapters.findIndex((c) => c.id === id);
  return i >= 0 ? chapters[i + 1] ?? null : null;
}
export function chapterBefore(chapters, id) {
  const i = chapters.findIndex((c) => c.id === id);
  return i > 0 ? chapters[i - 1] : null;
}

/** Does segment `i` keep its DOM? New (never measured) segments always mount once so their height can be recorded. */
export function isMounted(seg, i, activeIdx, measured) {
  if (seg.released) return false;
  return Math.abs(i - activeIdx) <= MOUNT_RADIUS || !measured;
}

/** Free the text of segments far from the active one. Returns the same array when there is nothing to release. */
export function releaseFar(list, activeIdx, radius = KEEP_TEXT_RADIUS) {
  let changed = false;
  const next = list.map((s, i) => {
    if (s.released || s.error || !s.text || Math.abs(i - activeIdx) <= radius) return s;
    changed = true;
    return { ...s, text: '', paras: [], released: true };
  });
  return changed ? next : list;
}

/** Released segments that are close enough to the active one to be loaded again. */
export function idsToRehydrate(list, activeIdx, radius = REHYDRATE_RADIUS) {
  return list.filter((s, i) => s.released && Math.abs(i - activeIdx) <= radius).map((s) => s.id);
}

/**
 * Should leaving `prevIdx` for `nextIdx` finish the chapter being left? Only a step to the very next chapter counts
 * (a jump with End/Home/scrollbar must not mark skipped chapters as read) and only if it was scrolled to its end.
 */
export function finishesChapter(prevIdx, nextIdx, prevProgress) {
  return nextIdx === prevIdx + 1 && prevProgress >= READ_THRESHOLD;
}

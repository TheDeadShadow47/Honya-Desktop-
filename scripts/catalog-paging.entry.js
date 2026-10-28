// Unit tests for the source-browser pagination rules (src/screens/Catalogs/paging.js). Pure functions, no DOM,
// no plugin host and no network. Run through scripts/catalog-paging-test.mjs.
import assert from 'node:assert/strict';
import {
  browseReducer,
  catalogItemKey,
  catalogPageRequest,
  initialBrowseState,
  mergeCatalogPage,
} from '../src/screens/Catalogs/paging.js';

let n = 0;
const ok = (name, fn) => {
  fn();
  n += 1;
  console.log(`ok ${n} - ${name}`);
};

const item = (i, prefix = 'novel') => ({ name: `${prefix} ${i}`, path: `/${prefix}/${i}` });
const page = (from, count, prefix = 'novel') => Array.from({ length: count }, (_, i) => item(from + i, prefix));
const load = (state, pageNo, generation = state.generation, retry = false) =>
  browseReducer(state, { type: 'load', page: pageNo, generation, retry });
const loaded = (state, pageNo, items, generation = state.generation) =>
  browseReducer(state, { type: 'loaded', page: pageNo, generation, items });
const failed = (state, pageNo, error = new Error('boom'), generation = state.generation) =>
  browseReducer(state, { type: 'failed', page: pageNo, generation, error });

/* ---- keys and requests ---------------------------------------------------------------------------------------- */

ok('item identity prefers path, then name, then the item itself', () => {
  assert.equal(catalogItemKey({ path: '/a', name: 'A' }), 'path:/a');
  assert.equal(catalogItemKey({ name: 'A' }), 'name:A');
  assert.equal(catalogItemKey({ name: '  A  ' }), 'name:A');
  assert.equal(catalogItemKey({ error: 'no identity' }), 'item:{"error":"no identity"}');
  assert.equal(catalogItemKey(null), 'item:null');
});

ok('popular and search use their existing signatures with the page last', () => {
  assert.deepEqual(catalogPageRequest('popular', 'novelfire', '', 1), { method: 'popular', args: ['novelfire', 1] });
  assert.deepEqual(catalogPageRequest('popular', 'novelfire', 'ignored', 3), { method: 'popular', args: ['novelfire', 3] });
  assert.deepEqual(catalogPageRequest('search', 'allnovel', 'renegade', 2), {
    method: 'search',
    args: ['allnovel', 'renegade', 2],
  });
});

/* ---- merging -------------------------------------------------------------------------------------------------- */

ok('a page appends only unseen items and keeps the rest', () => {
  const first = page(1, 3);
  const seen = first.map(catalogItemKey);
  const merged = mergeCatalogPage(first, seen, [item(4), item(5), item(1)]);
  assert.deepEqual(merged.items.map((x) => x.name), ['novel 1', 'novel 2', 'novel 3', 'novel 4', 'novel 5']);
  assert.equal(merged.added, 2);
  assert.equal(merged.seen.length, 5);
});

ok('same names with different paths are different novels', () => {
  const merged = mergeCatalogPage([{ name: 'X', path: '/a' }], ['path:/a'], [{ name: 'X', path: '/b' }]);
  assert.equal(merged.items.length, 2);
  assert.equal(merged.added, 1);
});

/* ---- reducer: first page and appending ------------------------------------------------------------------------ */

const start = (generation = 1) => browseReducer(initialBrowseState(), { type: 'reset', generation });

ok('first page: loading, then items, next page 2, not done', () => {
  let s = start(1);
  s = load(s, 1);
  assert.equal(s.loading, true);
  assert.equal(s.pendingPage, 1);
  s = loaded(s, 1, page(1, 20));
  assert.equal(s.loading, false);
  assert.equal(s.items.length, 20);
  assert.equal(s.seen.length, 20);
  assert.equal(s.nextPage, 2);
  assert.equal(s.done, false);
  assert.equal(s.error, null);
});

ok('a later page (any size) appends without duplicates', () => {
  let s = loaded(load(start(), 1), 1, page(1, 20));
  s = loaded(load(s, 2), 2, [...page(21, 3), item(1), item(2)]);
  assert.equal(s.items.length, 23);
  assert.equal(s.nextPage, 3);
  assert.equal(s.done, false);
});

ok('a page the source repeats ends the list instead of looping', () => {
  let s = loaded(load(start(), 1), 1, page(1, 20));
  s = loaded(load(s, 2), 2, page(1, 20));
  assert.equal(s.items.length, 20);
  assert.equal(s.done, true);
  assert.equal(load(s, 3), s); // no request after done
});

ok('an empty page (or a non-array result) ends the list', () => {
  let s = loaded(load(start(), 1), 1, page(1, 5));
  s = loaded(load(s, 2), 2, []);
  assert.equal(s.done, true);
  assert.equal(s.items.length, 5);

  let t = loaded(load(start(), 1), 1, page(1, 5));
  t = loaded(load(t, 2), 2, null);
  assert.equal(t.done, true);
  assert.equal(t.items.length, 5);
});

ok('a plugin that returns everything at once stops after one extra page', () => {
  const all = page(1, 7);
  let s = loaded(load(start(), 1), 1, all);
  s = loaded(load(s, 2), 2, all); // page 2 ignored by the plugin: same complete list
  assert.equal(s.items.length, 7);
  assert.equal(s.done, true);
});

/* ---- reducer: request guards ---------------------------------------------------------------------------------- */

ok('a second load while one is in flight is ignored', () => {
  const s = load(start(), 1);
  assert.equal(load(s, 2), s);
  assert.equal(load(s, 1), s);
  assert.equal(s.pendingPage, 1);
});

/* ---- reducer: errors and retry -------------------------------------------------------------------------------- */

ok('a page error keeps the loaded novels and remembers the failed page', () => {
  const err = new Error('403');
  let s = loaded(load(start(), 1), 1, page(1, 20));
  s = load(s, 2);
  s = failed(s, 2, err);
  assert.equal(s.items.length, 20);
  assert.equal(s.error, err);
  assert.equal(s.failedPage, 2);
  assert.equal(s.loading, false);
  assert.equal(s.done, false);
  assert.equal(load(s, 2), s); // scrolling does not auto-retry a broken page
  assert.equal(load(s, 3), s);
});

ok('retry re-requests only the failed page, then continues from it', () => {
  let s = loaded(load(start(), 1), 1, page(1, 20));
  s = failed(load(s, 2), 2);
  assert.equal(load(s, 3, s.generation, true), s); // wrong page
  s = load(s, 2, s.generation, true);
  assert.equal(s.loading, true);
  assert.equal(s.error, null);
  s = loaded(s, 2, page(21, 4));
  assert.equal(s.items.length, 24);
  assert.equal(s.nextPage, 3);
  assert.equal(s.failedPage, null);
});

/* ---- reducer: stale responses and resets ---------------------------------------------------------------------- */

ok('a response from a previous source/query cannot touch the new list', () => {
  let s = loaded(load(start(1), 1), 1, page(1, 20), 1);
  s = browseReducer(s, { type: 'reset', generation: 2 });
  s = load(s, 1, 2);
  const before = s;
  assert.equal(loaded(s, 2, page(21, 20), 1), before); // old generation
  assert.equal(failed(s, 2, new Error('old'), 1), before); // old failure
  assert.equal(s.items.length, 0);
  assert.equal(s.loading, true);
});

ok('a late response for a page no longer awaited is ignored', () => {
  let s = loaded(load(start(1), 1), 1, page(1, 20));
  s = load(s, 2);
  assert.equal(loaded(s, 3, page(41, 20)), s); // not the pending page
  assert.equal(s.items.length, 20);
  assert.equal(s.loading, true);
});

ok('reset clears items, dedupe keys, errors, done and the page cursor', () => {
  let s = loaded(load(start(1), 1), 1, page(1, 3));
  s = failed(load(s, 2), 2);
  s = browseReducer(s, { type: 'reset', generation: 7 });
  assert.deepEqual(s, { ...initialBrowseState(), generation: 7 });
  assert.equal(s.nextPage, 1);
  assert.equal(s.items.length, 0);
  assert.equal(s.error, null);
  assert.equal(s.failedPage, null);
  assert.equal(s.done, false);
});

ok('switching source or query starts a clean page-1 list', () => {
  let s = loaded(load(start(1), 1), 1, page(1, 20));
  s = loaded(load(s, 2), 2, page(21, 20));
  s = browseReducer(s, { type: 'reset', generation: 2 });
  assert.equal(s.items.length, 0);
  assert.equal(s.nextPage, 1);
  s = load(s, 1, 2);
  s = loaded(s, 1, [item(99, 'other')], 2);
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].name, 'other 99');
  assert.equal(s.nextPage, 2);
});

console.log(`CATALOG PAGINATION PASSED (${n} checks)`);

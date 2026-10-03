// Unit tests for the continuous-reader rules (src/screens/Reader/continuous.js). Pure functions, no DOM.
import assert from 'node:assert/strict';
import * as c from '../src/screens/Reader/continuous.js';

let n = 0;
const ok = (name, fn) => { fn(); n += 1; console.log(`ok ${n} - ${name}`); };

ok('progress equals the legacy single-chapter formula when the segment is the whole scroller', () => {
  const H = 5000, vh = 800;
  for (const top of [0, 100, 1234, 4200]) {
    assert.equal(c.segProgress(top, vh, 0, H), top / (H - vh) > 1 ? 1 : top / (H - vh));
  }
  assert.equal(c.segProgress(4200, vh, 0, H), 1);
  assert.equal(c.segProgress(0, vh, 0, H), 0);
});
ok('progress is per-segment: 0 at its top, 1 when its bottom reaches the viewport bottom, clamped outside', () => {
  const top = 3000, h = 2000, vh = 800; // segment spans 3000..5000
  assert.equal(c.segProgress(3000, vh, top, h), 0);
  assert.equal(c.segProgress(3600, vh, top, h), 0.5);
  assert.equal(c.segProgress(4200, vh, top, h), 1); // viewport bottom == segment bottom
  assert.equal(c.segProgress(4900, vh, top, h), 1); // next chapter already filling the screen
  assert.equal(c.segProgress(1000, vh, top, h), 0); // above the segment
});
ok('a chapter shorter than the window is read once its end is visible', () => {
  assert.equal(c.segProgress(0, 800, 0, 500), 1);
  assert.equal(c.segProgress(0, 800, 600, 500), 0); // below the fold: not yet
  assert.equal(c.segProgress(400, 800, 600, 500), 1);
});
ok('restore is the inverse of progress; finished/untouched chapters open at the top', () => {
  const top = 3000, h = 2000, vh = 800;
  for (const p of [0.05, 0.3, 0.5, 0.9]) {
    const st = c.scrollTopForProgress(p, top, h, vh);
    assert.ok(Math.abs(c.segProgress(st, vh, top, h) - p) < 1e-9, `round trip ${p}`);
  }
  for (const p of [0, 0.01, 0.98, 1, null, undefined, NaN]) assert.equal(c.scrollTopForProgress(p, top, h, vh), top);
});
ok('active chapter = last segment whose top is above the probe line', () => {
  assert.equal(c.pickActiveIndex([0, 3000, 6000], 100), 0);
  assert.equal(c.pickActiveIndex([0, 3000, 6000], 3000), 1);
  assert.equal(c.pickActiveIndex([0, 3000, 6000], 9000), 2);
  assert.equal(c.pickActiveIndex([0, null, 6000], 4000), 0); // not laid out yet
  assert.equal(c.pickActiveIndex([], 10), 0);
});
ok('append trigger: within 1.5 viewports of the end', () => {
  assert.equal(c.shouldAppend({ scrollHeight: 10000, scrollTop: 0, clientHeight: 800 }), false);
  assert.equal(c.shouldAppend({ scrollHeight: 10000, scrollTop: 8100, clientHeight: 800 }), true);
  assert.equal(c.shouldAppend({ scrollHeight: 10000, scrollTop: 8000, clientHeight: 800 }), false); // exactly 1.5 screens left: not yet
  assert.equal(c.shouldAppend({ scrollHeight: 1000, scrollTop: 0, clientHeight: 800 }), true); // short content keeps filling
});
ok('appendUnique never duplicates a chapter (racing loads)', () => {
  const a = [{ id: 'c1' }, { id: 'c2' }];
  assert.equal(c.appendUnique(a, { id: 'c2' }), a);
  const b = c.appendUnique(a, { id: 'c3' });
  assert.deepEqual(b.map((s) => s.id), ['c1', 'c2', 'c3']);
  assert.deepEqual(c.appendUnique(b, { id: 'c3' }).map((s) => s.id), ['c1', 'c2', 'c3']);
});
ok('chapter adjacency is taken from the ordered list', () => {
  const ch = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(c.chapterAfter(ch, 'a').id, 'b');
  assert.equal(c.chapterAfter(ch, 'c'), null);
  assert.equal(c.chapterAfter(ch, 'zzz'), null);
  assert.equal(c.chapterBefore(ch, 'a'), null);
  assert.equal(c.chapterBefore(ch, 'c').id, 'b');
});
ok('memory: DOM only near the active chapter; unmeasured segments mount once; released ones never mount', () => {
  const s = { released: false };
  assert.equal(c.isMounted(s, 5, 5, true), true);
  assert.equal(c.isMounted(s, 7, 5, true), true);
  assert.equal(c.isMounted(s, 8, 5, true), false);
  assert.equal(c.isMounted(s, 12, 5, false), true); // never measured -> mount so its height can be recorded
  assert.equal(c.isMounted({ released: true }, 5, 5, false), false);
});
ok('memory: text far from the active chapter is released, near text is kept, errors untouched, no-op returns same array', () => {
  const list = Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, text: 'x'.repeat(10), paras: ['x'], released: false }));
  list[0] = { ...list[0], error: new Error('boom'), text: '' };
  const out = c.releaseFar(list, 20);
  assert.equal(out[0].released, false); // error segment untouched
  assert.equal(out[1].released, true);
  assert.equal(out[1].text, '');
  assert.deepEqual(out[1].paras, []);
  assert.equal(out[11].released, true); // 20-11 = 9 > 8: released
  assert.equal(out[12].released, false); // 20-12 = 8 <= 8: kept
  assert.equal(out[28].released, false); // 8 ahead: kept
  assert.equal(out[29].released, true); // 9 ahead: released
  assert.equal(c.releaseFar(out, 20), out); // idempotent -> same reference (no render loop)
});
ok('memory: released chapters come back when the reader approaches them', () => {
  const list = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => ({ id: `c${i}`, released: i < 6 }));
  assert.deepEqual(c.idsToRehydrate(list, 9), ['c5']); // within 4 of index 9
  assert.deepEqual(c.idsToRehydrate(list, 0), ['c0', 'c1', 'c2', 'c3', 'c4']);
});
ok('only stepping to the very next chapter after reaching the end finishes the chapter being left', () => {
  assert.equal(c.finishesChapter(0, 1, 1), true);
  assert.equal(c.finishesChapter(0, 1, 0.97), false); // not scrolled to the end
  assert.equal(c.finishesChapter(0, 3, 1), false); // End/scrollbar jump must not mark skipped chapters read
  assert.equal(c.finishesChapter(2, 1, 1), false); // scrolling backwards
});
ok('paragraph split matches the legacy reader', () => {
  assert.deepEqual(c.splitParas('a\n\nb\nc\n'), ['a', 'b', 'c']);
  assert.deepEqual(c.splitParas(''), []);
  assert.deepEqual(c.splitParas(null), []);
});
console.log(`\n${n} reader-logic checks passed`);

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Icon from '../../components/Icon.jsx';
import { READER_BACKGROUNDS } from '@core/theme/theme.js';
import { sanitizeChapter } from '@core/text/clean.js';
import { db, plugins, session } from '../../lib/api';
import { go } from '../../lib/router';
import { useI18n, useSettings } from '../../lib/settings.jsx';
import { Checkbox, Empty, ErrorBox, IconButton, Spinner } from '../../components/ui.jsx';
import { emit } from '../../lib/store.js';
import {
  PROBE,
  READ_THRESHOLD,
  appendUnique,
  chapterAfter,
  chapterBefore,
  finishesChapter,
  idsToRehydrate,
  isMounted,
  pickActiveIndex,
  releaseFar,
  scrollTopForProgress,
  segProgress,
  shouldAppend,
  splitParas,
} from './continuous.js';

// Desktop reader. Data path is identical to Honya Android: use the downloaded text when present,
// otherwise fetch through the novel's source plugin. Progress, read state and bookmarks are written
// to SQLite so they survive a restart and are covered by backup/restore.
//
// CONTINUOUS SCROLL (settings.reader.continuous, default on): the window shows a list of consecutive chapters in one
// scroll container. The next chapter is appended when the reader nears the end, progress is tracked per chapter, and
// the active chapter drives the title bar, history, Discord presence and bookmarks. The rules live in ./continuous.js
// (unit-tested); this file wires them to the DOM. With the setting off the reader behaves as the original
// one-chapter-per-page reader.
//
// Kept deliberately separate from the app chrome: the reader owns the whole window (App renders it
// full-bleed), so it draws its own top bar and can be styled independently of the theme tokens.

/** Fetch (or read offline) one chapter. Never throws: failures come back as a segment with `error` so the UI can retry. */
async function buildSegment(chapter, novel, t) {
  let text = chapter.downloadedText;
  const offline = !!text;
  let error = null;
  if (!text) {
    try {
      if (!novel?.pluginId) throw new Error(t('reader.notDownloadedNoSource'));
      text = sanitizeChapter(await plugins.chapter(novel.pluginId, chapter.path), { title: chapter.name });
    } catch (e) {
      error = e;
      text = '';
    }
  }
  const empty = !error && !String(text ?? '').trim();
  // The body is kept in `text`; the heavy row field is not duplicated into the chapter metadata.
  // eslint-disable-next-line no-unused-vars
  const { downloadedText, ...meta } = chapter;
  return {
    id: chapter.id,
    chapter: meta,
    text: error ? '' : text,
    paras: error ? [] : splitParas(text),
    offline,
    error,
    empty,
    released: false,
    marks: [],
  };
}

export default function Reader({ param: chapterId }) {
  const t = useI18n();
  const { settings, update } = useSettings();
  const r = settings.reader;
  const continuous = r.continuous !== false;
  const bg = READER_BACKGROUNDS.find((b) => b.key === r.background) ?? READER_BACKGROUNDS[1];

  const [boot, setBoot] = useState({ status: 'loading' });
  const [segs, setSegs] = useState([]);
  const [activeId, setActiveId] = useState(chapterId);
  const [chapters, setChapters] = useState([]);
  const [novel, setNovel] = useState(null);
  const [appending, setAppending] = useState(false);
  const [search, setSearch] = useState({ open: false, q: '', at: 0, segId: null });
  const [panel, setPanel] = useState(false); // bookmarks panel
  const [pop, setPop] = useState(false); // typography popover
  const [jump, setJump] = useState('');
  const [tts, setTts] = useState({ on: false, paused: false, seg: null, i: 0 });
  const [notice, setNotice] = useState('');

  const scroller = useRef(null);
  const searchInput = useRef(null);
  const saveTimer = useRef(null);
  const noticeTimer = useRef(null);
  const segEls = useRef(new Map()); // segment id -> wrapper element (present for mounted AND collapsed segments)
  const heights = useRef(new Map()); // segment id -> last measured height (used by collapsed spacers)
  const segsRef = useRef([]);
  const activeRef = useRef(chapterId);
  const chaptersRef = useRef([]);
  const novelRef = useRef(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const continuousRef = useRef(continuous);
  continuousRef.current = continuous;
  const aliveRef = useRef(true);
  const restoredRef = useRef(false);
  const pending = useRef(null); // latest progress not yet written: { id, p }
  const readMarked = useRef(new Set());
  const appendPromise = useRef(null);
  const rehydrating = useRef(new Set());
  const ttsRef = useRef(tts);
  ttsRef.current = tts;

  const flash = useCallback((text) => {
    setNotice(text);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(''), 2600);
  }, []);

  // All writes to the segment list go through here so concurrent loads (append / rehydrate / retry) always see the
  // latest list. That is what keeps a chapter from ever being appended twice.
  const mutateSegs = useCallback((fn) => {
    const next = fn(segsRef.current);
    if (next !== segsRef.current) {
      segsRef.current = next;
      setSegs(next);
    }
  }, []);
  const patchSeg = useCallback(
    (id, patch) => mutateSegs((l) => l.map((s) => (s.id === id ? { ...s, ...patch } : s))),
    [mutateSegs],
  );

  /** Load one chapter into a segment (offline text first, else the source plugin). Never throws. */
  const loadSegment = useCallback(
    async (id) => {
      let chapter = null;
      try {
        chapter = await db.getChapter(id);
        if (!chapter) throw new Error(t('reader.chapterMissing'));
        const nv = novelRef.current ?? (await db.getNovel(chapter.novelId));
        const [seg, marks] = await Promise.all([
          buildSegment(chapter, nv, t),
          db.getChapterBookmarks(id).catch(() => []),
        ]);
        return { ...seg, marks };
      } catch (e) {
        // eslint-disable-next-line no-unused-vars
        const { downloadedText, ...meta } = chapter ?? chaptersRef.current.find((c) => c.id === id) ?? { id, name: '' };
        return { id, chapter: meta, text: '', paras: [], offline: false, error: e, empty: false, released: false, marks: [] };
      }
    },
    [t],
  );

  /* --- initial load -------------------------------------------------- */
  useEffect(() => {
    aliveRef.current = true;
    let alive = true;
    (async () => {
      try {
        const chapter = await db.getChapter(chapterId);
        if (!chapter) throw new Error(t('reader.chapterMissing'));
        const [nv, list] = await Promise.all([db.getNovel(chapter.novelId), db.getChapters(chapter.novelId)]);
        novelRef.current = nv;
        chaptersRef.current = list;
        const seg = await buildSegment(chapter, nv, t);
        if (seg.error) throw seg.error;
        seg.marks = await db.getChapterBookmarks(chapter.id);
        if (!alive) return;
        segsRef.current = [seg];
        activeRef.current = chapter.id;
        setNovel(nv);
        setChapters(list);
        setSegs([seg]);
        setBoot({ status: 'ready' });
        db.touchChapterRead(chapter.id).catch(() => {});
        if (settingsRef.current.reader.markReadOnOpen) db.markChapterRead(chapter.id, true).catch(() => {});
        session
          .start({
            novel: { id: nv?.id, title: nv?.title },
            chapter: { id: chapter.id, name: chapter.name, number: chapter.number },
          })
          .catch(() => {});
      } catch (e) {
        if (alive) setBoot({ status: 'error', error: e });
      }
    })();
    return () => {
      alive = false;
      aliveRef.current = false;
      session.end().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapterId]);

  const activeIdx = Math.max(0, segs.findIndex((s) => s.id === activeId));
  const active = segs[activeIdx] ?? null;

  /* --- progress ------------------------------------------------------ */
  const markFinished = useCallback((id) => {
    const seg = segsRef.current.find((s) => s.id === id);
    if (!seg || seg.chapter.read || readMarked.current.has(id)) return false;
    readMarked.current.add(id);
    db.markChapterRead(id, true).catch(() => {});
    emit('library', 'updates', 'history');
    return true;
  }, []);

  const flushProgress = useCallback(() => {
    clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const pd = pending.current;
    if (!pd) return;
    pending.current = null;
    db.saveChapterProgress(pd.id, pd.p).catch(() => {});
    session.progress(pd.p).catch(() => {});
    if (pd.p >= READ_THRESHOLD) {
      const finished = markFinished(pd.id);
      // Legacy single-chapter mode only: reaching the end continues with the next chapter (old ttsAutoNext behaviour).
      if (finished && !continuousRef.current && settingsRef.current.reader.ttsAutoNext) {
        const nx = chapterAfter(chaptersRef.current, pd.id);
        if (nx) go('reader', nx.id);
      }
    }
  }, [markFinished]);

  /* --- appending the next chapter -------------------------------------- */
  /** Appends the chapter after the last segment. Resolves to the new segment, or null. Safe to call repeatedly. */
  const appendNext = useCallback(() => {
    if (!continuousRef.current) return Promise.resolve(null);
    if (appendPromise.current) return appendPromise.current;
    const list = segsRef.current;
    const last = list[list.length - 1];
    if (!last || last.error) return Promise.resolve(null); // a failed chapter waits for an explicit retry (no retry loop)
    const nextCh = chapterAfter(chaptersRef.current, last.id);
    if (!nextCh || list.some((s) => s.id === nextCh.id)) return Promise.resolve(null);
    setAppending(true);
    const p = (async () => {
      const seg = await loadSegment(nextCh.id);
      if (!aliveRef.current) return null;
      mutateSegs((l) => appendUnique(l, seg));
      return seg;
    })().finally(() => {
      appendPromise.current = null;
      if (aliveRef.current) setAppending(false);
    });
    appendPromise.current = p;
    return p;
  }, [loadSegment, mutateSegs]);

  const maybeAppend = useCallback(() => {
    const el = scroller.current;
    if (!el || !continuousRef.current || !restoredRef.current) return;
    if (shouldAppend({ scrollHeight: el.scrollHeight, scrollTop: el.scrollTop, clientHeight: el.clientHeight })) appendNext();
  }, [appendNext]);

  const retrySeg = useCallback(
    async (id) => {
      const seg = await loadSegment(id);
      if (aliveRef.current) mutateSegs((l) => l.map((s) => (s.id === id ? seg : s)));
    },
    [loadSegment, mutateSegs],
  );

  /* --- restore reading position (once, for the chapter the window opened on) ----
     Done synchronously after the first layout rather than in requestAnimationFrame: rAF does not fire while the window
     is hidden or minimised, and progress saving / appending must never depend on it. */
  useLayoutEffect(() => {
    const el = scroller.current;
    if (boot.status !== 'ready' || !el || restoredRef.current) return;
    const first = segsRef.current[0];
    const w = first && segEls.current.get(first.id);
    if (w) el.scrollTop = scrollTopForProgress(first.chapter.progress, w.offsetTop, w.offsetHeight, el.clientHeight);
    el.focus();
    restoredRef.current = true;
    maybeAppend();
  }, [boot.status, maybeAppend]);

  /* --- scrolling: active chapter, progress, append ---------------------- */
  const onScroll = useCallback(() => {
    const el = scroller.current;
    const list = segsRef.current;
    if (!el || !list.length) return;
    const tops = list.map((s) => segEls.current.get(s.id)?.offsetTop ?? null);
    const ai = continuousRef.current ? pickActiveIndex(tops, el.scrollTop + el.clientHeight * PROBE) : 0;
    const seg = list[ai];
    const w = segEls.current.get(seg.id);
    if (!w) return;

    if (seg.id !== activeRef.current) {
      const prevId = activeRef.current;
      const prevIdx = list.findIndex((s) => s.id === prevId);
      const pw = segEls.current.get(prevId);
      if (pw && finishesChapter(prevIdx, ai, segProgress(el.scrollTop, el.clientHeight, pw.offsetTop, pw.offsetHeight))) {
        markFinished(prevId);
      }
      activeRef.current = seg.id;
      setActiveId(seg.id);
      // replaceState (not location.hash) so the router does not remount the reader; a restart reopens the active chapter
      try {
        window.history.replaceState(null, '', `#/reader/${encodeURIComponent(seg.id)}`);
      } catch {
        /* non-fatal */
      }
      db.touchChapterRead(seg.id).catch(() => {});
      if (settingsRef.current.reader.markReadOnOpen) db.markChapterRead(seg.id, true).catch(() => {});
      session
        .chapter({
          novel: { id: novelRef.current?.id, title: novelRef.current?.title },
          chapter: { id: seg.id, name: seg.chapter.name, number: seg.chapter.number },
        })
        .catch(() => {});
    }

    if (restoredRef.current) {
      pending.current = { id: seg.id, p: segProgress(el.scrollTop, el.clientHeight, w.offsetTop, w.offsetHeight) };
      if (!saveTimer.current) saveTimer.current = setTimeout(flushProgress, 500); // throttled, trailing
    }
    maybeAppend();
  }, [flushProgress, markFinished, maybeAppend]);

  // After every render: remember the height of mounted chapters (collapsed ones keep their last height as a spacer).
  useLayoutEffect(() => {
    for (const s of segsRef.current) {
      const w = segEls.current.get(s.id);
      if (w && !w.dataset.collapsed) heights.current.set(s.id, w.offsetHeight);
    }
  });

  // New content / window size can leave the end of the content within reach: keep filling.
  useEffect(() => {
    maybeAppend();
  }, [segs, maybeAppend]);
  useEffect(() => {
    window.addEventListener('resize', maybeAppend);
    return () => window.removeEventListener('resize', maybeAppend);
  }, [maybeAppend]);

  // Memory: free the text of chapters far behind/ahead; bring them back when the reader returns.
  useEffect(() => {
    if (!continuous) return;
    mutateSegs((l) => releaseFar(l, activeIdx));
    for (const id of idsToRehydrate(segsRef.current, activeIdx)) {
      if (rehydrating.current.has(id)) continue;
      rehydrating.current.add(id);
      loadSegment(id)
        .then((seg) => {
          if (aliveRef.current) mutateSegs((l) => l.map((s) => (s.id === id && s.released ? seg : s)));
        })
        .finally(() => rehydrating.current.delete(id));
    }
  }, [activeIdx, segs, continuous, loadSegment, mutateSegs]);

  // Leaving the reader: write the last position (even if it was scrolled <500ms ago) and refresh dependent screens.
  useEffect(
    () => () => {
      flushProgress();
      emit('library', 'updates', 'history');
      window.speechSynthesis?.cancel();
    },
    [flushProgress],
  );

  const registerEl = useCallback((id, el) => {
    if (el) segEls.current.set(id, el);
    else segEls.current.delete(id);
  }, []);

  /* --- search (scoped to the chapter it was started in) ---------------- */
  const searchSeg = segs.find((s) => s.id === search.segId) ?? null;
  const hits = useMemo(() => {
    const q = search.q.trim().toLowerCase();
    if (!q || !searchSeg) return [];
    const out = [];
    searchSeg.paras.forEach((p, i) => {
      if (p.toLowerCase().includes(q)) out.push(i);
    });
    return out;
  }, [searchSeg, search.q]);

  const currentHit = hits.length ? hits[Math.min(search.at, hits.length - 1)] : -1;

  const scrollToPara = useCallback((segId, i, smooth = true) => {
    segEls.current.get(segId)?.querySelector(`[data-p="${i}"]`)?.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  useEffect(() => {
    if (currentHit >= 0 && search.segId) scrollToPara(search.segId, currentHit);
  }, [currentHit, search.segId, scrollToPara]);

  const stepHit = (d) => setSearch((s) => (hits.length ? { ...s, at: (s.at + d + hits.length) % hits.length } : s));

  /* --- bookmarks (SQLite) -------------------------------------------- */
  /** First paragraph at the top of the viewport, with the chapter it belongs to. */
  const topPara = useCallback(() => {
    const box = scroller.current?.getBoundingClientRect();
    if (!box) return { segId: activeRef.current, p: 0 };
    for (const el of scroller.current.querySelectorAll('[data-p]')) {
      if (el.getBoundingClientRect().bottom > box.top + 80) return { segId: el.dataset.seg, p: Number(el.dataset.p) };
    }
    return { segId: activeRef.current, p: 0 };
  }, []);

  const toggleMark = useCallback(async () => {
    if (boot.status !== 'ready') return;
    const { segId, p } = topPara();
    const seg = segsRef.current.find((s) => s.id === segId);
    if (!seg) return;
    const id = `${seg.id}::${p}`;
    const existing = seg.marks.find((m) => m.id === id);
    if (existing) {
      await db.removeBookmark(id);
      patchSeg(seg.id, { marks: (segsRef.current.find((s) => s.id === seg.id)?.marks ?? []).filter((m) => m.id !== id) });
      flash(t('reader.bookmarkRemoved'));
    } else {
      const snippet = (seg.paras[p] || '').slice(0, 140);
      await db.addBookmark({
        id,
        novelId: seg.chapter.novelId,
        chapterId: seg.id,
        chapterName: seg.chapter.name,
        paragraph: p,
        progress: seg.chapter.progress ?? 0,
        snippet,
      });
      const cur = segsRef.current.find((s) => s.id === seg.id)?.marks ?? [];
      patchSeg(seg.id, { marks: [...cur, { id, paragraph: p, snippet }].sort((a, b) => a.paragraph - b.paragraph) });
      flash(t('reader.bookmarkAdded'));
    }
    emit('library');
  }, [boot.status, topPara, patchSeg, flash, t]);

  const removeMark = async (seg, m) => {
    await db.removeBookmark(m.id);
    patchSeg(seg.id, { marks: (segsRef.current.find((s) => s.id === seg.id)?.marks ?? []).filter((x) => x.id !== m.id) });
    emit('library');
  };

  /* --- chapter navigation ---------------------------------------------- */
  const scrollSegTop = useCallback((id) => {
    const w = segEls.current.get(id);
    if (w && scroller.current) scroller.current.scrollTo({ top: w.offsetTop });
  }, []);

  /** Go to a chapter: scroll to it if it is already in the window, otherwise open the reader on it. */
  const goTo = useCallback(
    (id) => {
      if (!id) return;
      const inWindow = segsRef.current.find((s) => s.id === id);
      if (continuousRef.current && inWindow && !inWindow.released && !inWindow.error) {
        scrollSegTop(id);
        return;
      }
      go('reader', id);
    },
    [scrollSegTop],
  );

  const scrollChapterEdge = useCallback((edge) => {
    const el = scroller.current;
    const w = segEls.current.get(activeRef.current);
    if (!el || !w) return;
    el.scrollTo({ top: edge === 'top' ? w.offsetTop : w.offsetTop + w.offsetHeight - el.clientHeight });
  }, []);

  const prev = active ? chapterBefore(chapters, active.id) : null;
  const next = active ? chapterAfter(chapters, active.id) : null;

  /* --- text to speech ------------------------------------------------ */
  const synth = typeof window !== 'undefined' ? window.speechSynthesis ?? null : null;

  const speakFrom = useCallback(
    (segId, i) => {
      if (!synth) {
        flash(t('reader.ttsUnavailable'));
        return;
      }
      synth.cancel();
      const seg = segsRef.current.find((s) => s.id === segId);
      if (!seg) return;
      const rr = settingsRef.current.reader;
      if (i >= seg.paras.length) {
        setTts({ on: false, paused: false, seg: segId, i: 0 });
        if (!rr.ttsAutoNext) return;
        if (!continuousRef.current) {
          const nx = chapterAfter(chaptersRef.current, segId);
          if (nx) go('reader', nx.id);
          return;
        }
        // Continuous: keep reading into the following chapter (loading it first if it is not there yet).
        const idx = segsRef.current.findIndex((s) => s.id === segId);
        const existing = segsRef.current[idx + 1];
        (existing ? Promise.resolve(existing) : appendNext()).then((nx) => {
          if (!aliveRef.current || !nx || nx.error || nx.released || !nx.paras.length) return;
          scrollSegTop(nx.id);
          speakFrom(nx.id, 0);
        });
        return;
      }
      const u = new SpeechSynthesisUtterance(seg.paras[i]);
      u.lang = novelRef.current?.language || document.documentElement.lang || 'en';
      u.rate = rr.ttsRate ?? 1;
      u.pitch = rr.ttsPitch ?? 1;
      if (rr.ttsVoice) {
        const voice = synth.getVoices().find((v) => v.name === rr.ttsVoice || v.voiceURI === rr.ttsVoice);
        if (voice) u.voice = voice;
      }
      u.onend = () => {
        const cur = ttsRef.current;
        if (cur.on && !cur.paused && cur.seg === segId && cur.i === i) speakFrom(segId, i + 1);
      };
      u.onerror = (e) => {
        if (e.error === 'interrupted' || e.error === 'canceled') return;
        setTts({ on: false, paused: false, seg: segId, i });
        flash(t('reader.ttsUnavailable'));
      };
      setTts({ on: true, paused: false, seg: segId, i });
      scrollToPara(segId, i);
      synth.speak(u);
    },
    [synth, scrollToPara, scrollSegTop, appendNext, flash, t],
  );

  const ttsToggle = useCallback(() => {
    if (!synth) {
      flash(t('reader.ttsUnavailable'));
      return;
    }
    const cur = ttsRef.current;
    if (!cur.on) {
      const { segId, p } = topPara();
      speakFrom(segId, p);
    } else if (cur.paused) {
      synth.resume();
      setTts((s) => ({ ...s, paused: false }));
    } else {
      synth.pause();
      setTts((s) => ({ ...s, paused: true }));
    }
  }, [synth, speakFrom, topPara, flash, t]);

  const ttsStop = useCallback(() => {
    synth?.cancel();
    setTts({ on: false, paused: false, seg: null, i: 0 });
  }, [synth]);

  const ttsJump = useCallback(
    (segId, i) => {
      if (ttsRef.current.on) speakFrom(segId, i);
    },
    [speakFrom],
  );

  /* --- offline (applies to the chapter being read) ---------------------- */
  const saveOffline = async () => {
    if (!active) return;
    try {
      await db.saveChapterText(active.id, active.text);
      patchSeg(active.id, { offline: true });
      flash(t('reader.savedOffline'));
    } catch (e) {
      flash(`${t('reader.saveFailed')}: ${e.message}`);
    }
  };

  const removeOffline = async () => {
    if (!active) return;
    await db.deleteChapterText(active.id).catch(() => {});
    patchSeg(active.id, { offline: false });
    flash(t('reader.removedOffline'));
    emit('downloads', 'library');
  };

  /* --- navigation / typography ---------------------------------------- */
  const exit = useCallback(
    () => go(boot.status === 'ready' ? 'novel' : 'library', active?.chapter.novelId ?? novel?.id ?? null),
    [boot.status, active, novel],
  );
  const setFont = useCallback(
    (fn) => update({ reader: { ...r, fontSize: Math.min(40, Math.max(12, fn(r.fontSize))) } }),
    [r, update],
  );
  const setReader = useCallback((patch) => update({ reader: { ...r, ...patch } }), [r, update]);

  const goNumber = () => {
    const n = Number(jump);
    const c = chapters.find((x) => x.number === n);
    if (c) {
      setJump('');
      goTo(c.id);
    } else flash(t('reader.noSuchChapter'));
  };

  useEffect(() => {
    const onKey = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      const typing =
        e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
      if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setSearch((s) => ({ ...s, open: true, segId: activeRef.current }));
        setTimeout(() => searchInput.current?.select(), 0);
        return;
      }
      if (typing) return;
      if (mod && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggleMark();
        return;
      }
      if (mod && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        ttsToggle();
        return;
      }
      if (mod && (e.key === '+' || e.key === '=')) {
        e.preventDefault();
        setFont((s) => s + 1);
      } else if (mod && e.key === '-') {
        e.preventDefault();
        setFont((s) => s - 1);
      } else if (mod && e.key === '0') {
        e.preventDefault();
        setFont(() => 19);
      } else if (mod || e.altKey) return;
      else if (e.key === 'Escape') {
        if (search.open) {
          setSearch((s) => ({ ...s, open: false }));
          scroller.current?.focus();
        } else if (panel) setPanel(false);
        else if (pop) setPop(false);
        else exit();
      } else if (e.key === 'j' || (!continuous && e.key === 'ArrowDown')) {
        // In continuous mode the arrow keys scroll normally; J/K (and the buttons) still jump chapters.
        if (next) goTo(next.id);
      } else if (e.key === 'k' || (!continuous && e.key === 'ArrowUp')) {
        if (prev) goTo(prev.id);
      } else if (e.key === 'Home') scrollChapterEdge('top');
      else if (e.key === 'End') scrollChapterEdge('bottom');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [exit, setFont, toggleMark, ttsToggle, panel, pop, search.open, continuous, next, prev, goTo, scrollChapterEdge]);

  const fontFamily =
    r.fontFamily === 'sans' ? 'var(--font-sans)' : r.fontFamily === 'mono' ? 'var(--font-mono)' : 'var(--font-serif)';
  const typo = useMemo(
    () => ({ width: r.width, padding: r.padding, fontSize: r.fontSize, lineHeight: r.lineHeight, fontFamily, justify: r.justify }),
    [r.width, r.padding, r.fontSize, r.lineHeight, fontFamily, r.justify],
  );

  /* --- render --------------------------------------------------------- */
  if (boot.status === 'error') {
    return (
      <div className="pad">
        <ErrorBox error={boot.error} />
        <button className="btn" onClick={() => go('library')}>
          {t('reader.backToLibrary')}
        </button>
      </div>
    );
  }
  if (boot.status === 'loading') {
    return (
      <div className="reader" style={{ background: bg.bg, color: bg.fg }}>
        <div className="reader-loading">
          <Spinner size={26} />
        </div>
      </div>
    );
  }
  if (segs.length === 1 && segs[0].empty) {
    return (
      <Empty icon="book" title={t('reader.emptyChapter')}>
        <button className="btn" onClick={exit}>
          {t('common.back')}
        </button>
      </Empty>
    );
  }

  const novelTitle = novel?.title ?? '';
  const offline = !!active?.offline;
  const marks = active?.marks ?? [];
  const lastSeg = segs[segs.length - 1];
  const atEnd = continuous && lastSeg && !chapterAfter(chapters, lastSeg.id);

  return (
    <div className="reader" style={{ background: bg.bg, color: bg.fg }}>
      <div className="reader-bar" style={{ borderColor: `${bg.fg}22` }}>
        <button className="btn small" onClick={exit} title={t('reader.back', { title: novelTitle })}>
          <Icon name="arrowLeft" size={14} /> {novelTitle || t('common.back')}
        </button>
        <span className="grow center reader-title">
          <span className="reader-title-text">{active?.chapter.name}</span>
          {offline && (
            <span className="chip" title={t('novel.offline')}>
              <Icon name="checkCircle" size={11} /> {t('reader.offline')}
            </span>
          )}
        </span>

        {offline ? (
          <button className="btn small" onClick={removeOffline} title={t('reader.removeOffline')}>
            <Icon name="trash" size={14} /> <span className="btn-label">{t('reader.removeOffline')}</span>
          </button>
        ) : (
          <button className="btn small" onClick={saveOffline} title={t('reader.saveOffline')} disabled={!active?.text}>
            <Icon name="download" size={14} /> <span className="btn-label">{t('reader.saveOffline')}</span>
          </button>
        )}

        <IconButton icon="arrowLeft" label={t('reader.previous')} disabled={!prev} onClick={() => prev && goTo(prev.id)} />
        <IconButton icon="arrowRight" label={t('reader.next')} disabled={!next} onClick={() => next && goTo(next.id)} />
        <select
          className="input reader-jump"
          value={active?.id ?? ''}
          aria-label={t('reader.jumpTo')}
          title={t('reader.jumpTo')}
          onChange={(e) => {
            goTo(e.target.value);
            e.target.blur(); // hand the keyboard back to the reader (J/K/Esc are ignored while a form control has focus)
            scroller.current?.focus();
          }}
        >
          {chapters.map((c) => (
            <option key={c.id} value={c.id}>
              {c.number != null ? `${c.number}. ` : ''}
              {c.name}
            </option>
          ))}
        </select>
        <input
          className="input reader-jump-num"
          placeholder="#"
          inputMode="numeric"
          value={jump}
          aria-label={t('reader.jumpTo')}
          onChange={(e) => setJump(e.target.value.replace(/\D/g, ''))}
          onKeyDown={(e) => e.key === 'Enter' && goNumber()}
        />

        <span className="reader-sep" />
        <IconButton
          icon="search"
          label={t('reader.search')}
          active={search.open}
          onClick={() => {
            setSearch((s) => ({ ...s, open: !s.open, segId: activeRef.current }));
            setTimeout(() => searchInput.current?.focus(), 0);
          }}
        />
        <IconButton icon="bookmark" label={t('reader.addBookmark')} onClick={toggleMark} />
        <IconButton icon="list" label={t('reader.bookmarks')} active={panel} onClick={() => setPanel((v) => !v)} />
        <IconButton icon="volume" label={t('reader.listen')} active={tts.on} onClick={ttsToggle} />
        {tts.on && (
          <>
            <IconButton icon="pause" label={tts.paused ? t('reader.resume') : t('reader.pause')} onClick={ttsToggle} />
            <IconButton icon="close" label={t('reader.stopListening')} onClick={ttsStop} />
          </>
        )}
        <span className="reader-sep" />
        <IconButton icon="minus" label={t('reader.smallerText')} onClick={() => setFont((s) => s - 1)} />
        <IconButton icon="plus" label={t('reader.largerText')} onClick={() => setFont((s) => s + 1)} />
        <IconButton icon="type" label={t('reader.settings')} active={pop} onClick={() => setPop((v) => !v)} />
      </div>

      {notice && <div className="reader-notice">{notice}</div>}

      {search.open && (
        <div className="reader-search" style={{ borderColor: `${bg.fg}22` }}>
          <Icon name="search" size={15} />
          <input
            ref={searchInput}
            className="input borderless"
            value={search.q}
            placeholder={t('reader.searchInChapter')}
            aria-label={t('reader.searchInChapter')}
            onChange={(e) => setSearch({ open: true, q: e.target.value, at: 0, segId: activeRef.current })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                stepHit(e.shiftKey ? -1 : 1);
              } else if (e.key === 'Escape') {
                e.stopPropagation();
                setSearch((s) => ({ ...s, open: false }));
                scroller.current?.focus();
              }
            }}
          />
          <span className="muted small nowrap">
            {search.q.trim() ? (hits.length ? `${Math.min(search.at, hits.length - 1) + 1} / ${hits.length}` : '0 / 0') : ''}
          </span>
          <IconButton icon="arrowUp" label={t('reader.previousMatch')} disabled={!hits.length} onClick={() => stepHit(-1)} />
          <IconButton icon="arrowDown" label={t('reader.nextMatch')} disabled={!hits.length} onClick={() => stepHit(1)} />
          <IconButton
            icon="close"
            label={t('common.close')}
            onClick={() => {
              setSearch({ open: false, q: '', at: 0, segId: null });
              scroller.current?.focus();
            }}
          />
        </div>
      )}

      {panel && (
        <aside className="reader-panel" style={{ background: bg.bg, borderColor: `${bg.fg}22` }}>
          <strong>{t('reader.bookmarks')}</strong>
          {!marks.length && (
            <p className="muted small">
              {t('reader.noBookmarks')} <kbd>Ctrl</kbd>
              <kbd>B</kbd>
            </p>
          )}
          {marks.map((m) => (
            <div key={m.id} className="reader-mark">
              <button
                className="btn small grow"
                onClick={() => {
                  scrollToPara(active.id, m.paragraph);
                  setPanel(false);
                }}
              >
                ¶{m.paragraph + 1} · {m.snippet}
              </button>
              <IconButton icon="close" label={t('common.remove')} onClick={() => removeMark(active, m)} />
            </div>
          ))}
        </aside>
      )}

      {pop && (
        <aside className="reader-panel reader-pop" style={{ background: bg.bg, borderColor: `${bg.fg}22` }}>
          <strong>{t('reader.settings')}</strong>
          <div className="reader-bgs" role="group" aria-label={t('reader.background')}>
            {READER_BACKGROUNDS.map((b) => (
              <button
                key={b.key}
                type="button"
                title={b.name}
                aria-label={b.name}
                aria-pressed={r.background === b.key}
                className={`reader-bgchip ${r.background === b.key ? 'on' : ''}`}
                style={{ background: b.bg, color: b.fg }}
                onClick={() => setReader({ background: b.key })}
              >
                Aa
              </button>
            ))}
          </div>
          <RangeField label={t('reader.fontSize')} value={r.fontSize} min={12} max={40} onChange={(v) => setReader({ fontSize: v })} />
          <RangeField label={t('reader.lineHeight')} value={r.lineHeight} min={1.2} max={2.4} step={0.05} onChange={(v) => setReader({ lineHeight: v })} />
          <RangeField label={t('reader.sidePadding')} value={r.padding} min={8} max={96} onChange={(v) => setReader({ padding: v })} />
          <RangeField label={t('settings.readingWidth')} value={r.width} min={480} max={1100} step={20} onChange={(v) => setReader({ width: v })} />
          <Checkbox label={t('settings.continuousScroll')} checked={continuous} onChange={(v) => setReader({ continuous: v })} />
        </aside>
      )}

      <div className="reader-scroll" ref={scroller} onScroll={onScroll} tabIndex={0}>
        {segs.map((seg, i) => (
          <Segment
            key={seg.id}
            seg={seg}
            mounted={!continuous || isMounted(seg, i, activeIdx, heights.current.has(seg.id))}
            height={heights.current.get(seg.id) ?? 400}
            typo={typo}
            q={search.segId === seg.id ? search.q : ''}
            hit={search.segId === seg.id ? currentHit : -1}
            ttsIndex={tts.on && tts.seg === seg.id ? tts.i : -1}
            legacy={!continuous}
            next={!continuous ? chapterAfter(chapters, seg.id) : null}
            onGoNext={goTo}
            onRetry={retrySeg}
            onTtsJump={ttsJump}
            register={registerEl}
            t={t}
          />
        ))}
        {continuous && (
          <div className="reader-tail">
            {appending ? (
              <>
                <Spinner size={18} /> <span className="muted">{t('common.loading')}</span>
              </>
            ) : atEnd ? (
              <span className="muted">{t('reader.endOfChapters')}</span>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function RangeField({ label, value, min, max, step = 1, onChange }) {
  return (
    <label className="reader-field">
      <span>
        {label}: {value}
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

// One chapter. Memoised: while scrolling, only the chapter whose props changed re-renders. A collapsed chapter keeps
// its wrapper (so offsets and the scroll position stay exact) but drops its paragraphs.
const Segment = memo(function Segment({ seg, mounted, height, typo, q, hit, ttsIndex, legacy, next, onGoNext, onRetry, onTtsJump, register, t }) {
  const marked = useMemo(() => new Set(seg.marks.map((m) => m.paragraph)), [seg.marks]);
  return (
    <section
      className="reader-seg"
      data-seg={seg.id}
      data-collapsed={mounted ? undefined : '1'}
      ref={(el) => register(seg.id, el)}
      style={mounted ? undefined : { height }}
    >
      {mounted && (
        <article
          style={{
            maxWidth: typo.width,
            padding: `40px ${typo.padding}px ${legacy ? 140 : 24}px`,
            fontSize: typo.fontSize,
            lineHeight: typo.lineHeight,
            fontFamily: typo.fontFamily,
            textAlign: typo.justify ? 'justify' : 'start',
          }}
        >
          <h2>{seg.chapter.name}</h2>
          {seg.error ? (
            <div className="reader-error">
              <strong>{t('reader.couldNotLoad')}</strong>
              <span className="muted small">{t('reader.offlineHint')}</span>
              <span className="small">{String(seg.error.message ?? seg.error)}</span>
              <button className="btn small" onClick={() => onRetry(seg.id)}>
                {t('reader.retry')}
              </button>
            </div>
          ) : seg.empty ? (
            <div className="reader-error">
              <span className="muted">{t('reader.emptyChapter')}</span>
            </div>
          ) : (
            seg.paras.map((p, i) => (
              <p
                key={i}
                data-p={i}
                data-seg={seg.id}
                dir="auto"
                className={`${ttsIndex === i ? 'reading' : ''} ${marked.has(i) ? 'marked' : ''}`}
                onDoubleClick={() => onTtsJump(seg.id, i)}
              >
                {highlight(p, q, hit === i)}
              </p>
            ))
          )}
          {legacy ? (
            <div className="reader-end">
              {next ? (
                <button className="btn primary" onClick={() => onGoNext(next.id)}>
                  {t('reader.nextChapter')} <kbd>K</kbd>
                </button>
              ) : (
                <span className="muted">{t('reader.endOfChapters')}</span>
              )}
            </div>
          ) : (
            <hr className="chapter-sep" />
          )}
        </article>
      )}
    </section>
  );
});

function highlight(text, q, current) {
  const needle = q.trim();
  if (!needle) return text;
  const lower = text.toLowerCase();
  const n = needle.toLowerCase();
  const out = [];
  let from = 0;
  let i;
  while ((i = lower.indexOf(n, from)) !== -1) {
    if (i > from) out.push(text.slice(from, i));
    out.push(
      <mark key={i} className={current ? 'current' : ''}>
        {text.slice(i, i + n.length)}
      </mark>,
    );
    from = i + n.length;
  }
  out.push(text.slice(from));
  return out;
}

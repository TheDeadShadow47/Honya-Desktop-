import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Icon from '../../components/Icon.jsx';
import {
  Button,
  ChapterState,
  Checkbox,
  Cover,
  Dialog,
  Empty,
  ErrorBox,
  Header,
  IconButton,
  Segmented,
  Select,
  ago,
  openChapter,
  pct,
  useToast,
} from '../../components/ui.jsx';
import { go } from '../../lib/router';
import { useI18n } from '../../lib/settings.jsx';
import { usePresence } from '../../lib/presence';
import { useChapterPrefs } from '../../lib/useLibrary';
import { useDebounced } from '../../lib/store.js';
import { db } from '../../lib/api';
import {
  addToLibrary,
  deleteNovel,
  downloadChapters,
  markRead,
  removeFromLibrary,
  removeDownload,
  refreshNovel,
} from '../../lib/actions';

// Per-novel chapter list preferences, matching Honya Android's lib/chapterPrefs.js shape.
const DEFAULT_CHAPTER_PREFS = {
  filters: { downloaded: false, unread: false },
  sortKey: 'numberAsc',
  display: { sourceTitle: false, chapterNumber: false },
};
const NOVEL_CACHE = new Map();
const PAGE = 120;
const SORT_KEYS = ['numberAsc', 'numberDesc', 'newest', 'oldest'];

const mergePrefs = (saved) => ({
  filters: { ...DEFAULT_CHAPTER_PREFS.filters, ...(saved?.filters ?? {}) },
  sortKey: SORT_KEYS.includes(saved?.sortKey) ? saved.sortKey : DEFAULT_CHAPTER_PREFS.sortKey,
  display: { ...DEFAULT_CHAPTER_PREFS.display, ...(saved?.display ?? {}) },
});

const releaseTime = (c) => {
  const t = Date.parse(c.releaseTime ?? '');
  return Number.isFinite(t) ? t : 0;
};

function applyView(chapters, prefs, query) {
  const needle = query.trim().toLowerCase();
  let list = chapters;
  if (prefs.filters.downloaded) list = list.filter((c) => c.downloaded);
  if (prefs.filters.unread) list = list.filter((c) => !c.read);
  if (needle) list = list.filter((c) => `${c.name ?? ''} ${c.number ?? ''}`.toLowerCase().includes(needle));
  const byNumber = (a, b) => (a.number ?? 0) - (b.number ?? 0);
  if (prefs.sortKey === 'numberDesc') list = [...list].sort((a, b) => -byNumber(a, b));
  else if (prefs.sortKey === 'newest') list = [...list].sort((a, b) => releaseTime(b) - releaseTime(a) || byNumber(b, a));
  else if (prefs.sortKey === 'oldest') list = [...list].sort((a, b) => releaseTime(a) - releaseTime(b) || byNumber(a, b));
  else list = [...list].sort(byNumber);
  return list;
}

export default function Novel({ param: novelId }) {
  const t = useI18n();
  const toast = useToast();
  // Last loaded copy per novel, so reopening a novel paints immediately and refreshes behind the scenes.
  const [data, setData] = useState(() => NOVEL_CACHE.get(novelId) ?? null);
  usePresence('novel', data?.novel?.title);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState(null);
  const [query, setQuery] = useState('');
  const q = useDebounced(query, 150);
  const [selection, setSelection] = useState(null); // Set-like array of chapter ids
  const [anchor, setAnchor] = useState(null); // for shift-range selection
  const [endpoints, setEndpoints] = useState([]); // up to two chapter ids marking a range
  const [panel, setPanel] = useState(null); // 'filter' | 'sort' | 'display' | 'selection'
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { prefs: allPrefs, save: savePrefs } = useChapterPrefs();

  const prefs = useMemo(() => mergePrefs(allPrefs[novelId]), [allPrefs, novelId]);
  const setPrefs = useCallback((patch) => savePrefs(novelId, mergePrefs({ ...prefs, ...patch })), [savePrefs, novelId, prefs]);

  const load = useCallback(async () => {
    try {
      const [novel, chapters] = await Promise.all([db.getNovel(novelId), db.getChapters(novelId)]);
      const next = { novel, chapters };
      NOVEL_CACHE.set(novelId, next);
      setData(next);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [novelId]);

  useEffect(() => {
    setSelection(null);
    setEndpoints([]);
    load();
  }, [load]);

  // The filtered/sorted list only depends on the chapters, the prefs and the query; recomputing it (and sorting
  // thousands of rows) on every unrelated state change made selection and panels feel laggy.
  const view = useMemo(() => (data ? applyView(data.chapters, prefs, q) : []), [data, prefs, q]);

  // Long novels have thousands of chapters. Mounting every row at once froze the UI on open, so rows are added in
  // pages as the list is scrolled to its end.
  const [shown, setShown] = useState(PAGE);
  useEffect(() => setShown(PAGE), [novelId, q, prefs]);
  const sentinel = useRef(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || shown >= view.length) return undefined;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setShown((n) => n + PAGE), {
      rootMargin: '800px',
    });
    io.observe(el);
    return () => io.disconnect();
  }, [shown, view.length]);

  if (error) return <ErrorBox error={error} onRetry={load} />;
  if (!data) return <p className="muted">{t('common.loading')}</p>;

  const { novel, chapters } = data;
  if (!novel) {
    return (
      <Empty icon="alert" title={t('novel.notFound')}>
        <Button onClick={() => go('library')}>{t('novel.back')}</Button>
      </Empty>
    );
  }

  const firstUnread = chapters.find((c) => !c.read) ?? null;
  const lastReadId = getLastReadId(chapters);
  const resume = chapters.find((c) => c.id === lastReadId) ?? firstUnread ?? chapters[chapters.length - 1] ?? null;
  const unread = chapters.filter((c) => !c.read).length;
  const downloaded = chapters.filter((c) => c.downloaded).length;
  const anyRead = chapters.some((c) => c.read);
  const selected = selection ?? [];
  const selectedSet = new Set(selected);
  const filtered = view.length !== chapters.length;

  // Range endpoints: the last two chapters the user manually checked. Order in the list (not click
  // order) decides start/end, so reverse picks (36 then 20) work and filtered views are respected.
  const visibleEnds = endpoints.filter((id) => view.some((c) => c.id === id) && selectedSet.has(id));
  const endIdx = visibleEnds.map((id) => view.findIndex((c) => c.id === id)).sort((a, b) => a - b);
  const rangeStartId = endIdx.length === 2 ? view[endIdx[0]].id : null;
  const rangeEndId = endIdx.length === 2 ? view[endIdx[1]].id : null;
  const canSelectRange = endIdx.length === 2 && endIdx[1] - endIdx[0] > 1;

  const selectRange = () => {
    if (!canSelectRange) return;
    const ids = view.slice(endIdx[0], endIdx[1] + 1).map((c) => c.id);
    setSelection((cur) => [...new Set([...(cur ?? []), ...ids])]);
    toast.show(t('selection.rangeSelected', { count: ids.length }));
  };

  const select = (id, { range = false } = {}) => {
    if (!selection) return;
    if (!range) {
      const adding = !selectedSet.has(id);
      setEndpoints((cur) => (adding ? [...cur.filter((x) => x !== id), id].slice(-2) : cur.filter((x) => x !== id)));
    }
    setSelection((cur) => {
      const set = new Set(cur ?? []);
      if (range && anchor && view.length) {
        const a = view.findIndex((c) => c.id === anchor);
        const b = view.findIndex((c) => c.id === id);
        if (a >= 0 && b >= 0) {
          for (let i = Math.min(a, b); i <= Math.max(a, b); i += 1) set.add(view[i].id);
          return [...set];
        }
      }
      if (set.has(id)) set.delete(id);
      else set.add(id);
      setAnchor(id);
      return [...set];
    });
  };

  const selectAll = () => {
    if (!selection) return;
    setSelection(view.map((c) => c.id));
  };
  const deselectAll = () => {
    setSelection([]);
    setEndpoints([]);
  };

  const withSelection = (fn, okMessage) => async () => {
    setBusyAction(true);
    try {
      await fn([...selectedSet]);
      if (okMessage) toast.show(okMessage(selectedSet.size));
      setSelection(null);
      setEndpoints([]);
    } catch (e) {
      toast.show(String(e?.message ?? e), 'error');
    } finally {
      setBusyAction(false);
    }
  };

  const onDownloadSelected = withSelection(
    (ids) => {
      const list = chapters.filter((c) => ids.includes(c.id) && !c.downloaded);
      return downloadChapters(list, novel);
    },
    (n) => t('selection.addedToDownloads', { count: n, plural: n === 1 ? '' : 's' }),
  );

  const onMarkSelectedRead = withSelection((ids) => markRead(ids, true), (n) => t('selection.markedRead', { count: n }));
  const onMarkSelectedUnread = withSelection((ids) => markRead(ids, false), (n) => t('selection.markedUnread', { count: n }));
  const onRemoveSelectedDownloads = withSelection(
    async (ids) => {
      for (const id of ids) await removeDownload(id);
    },
    (n) => t('selection.removedDownloads', { count: n }),
  );

  const onRefresh = async () => {
    setBusy(true);
    try {
      const newCount = await refreshNovel(novel);
      await load();
      toast.show(newCount > 0 ? t('novel.updatedNew', { count: newCount }) : t('novel.updatedNone'));
    } catch (e) {
      toast.show(String(e?.message ?? e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const onMarkAllRead = async () => {
    await markRead(chapters.map((c) => c.id), true);
    await load();
  };

  const statusLabel = statusFor(novel.status, t);

  return (
    <div className="novel-page">
      <div className="novel-head">
        <button className="novel-cover" onClick={() => go('library')} aria-label={t('novel.back')}>
          <Cover src={novel.cover} title={novel.title} />
        </button>
        <div className="grow novel-info">
          <div className="novel-head-top">
            <div className="grow">
              <h1>{novel.title}</h1>
              <p className="muted">
                {novel.author || t('novel.unknownAuthor')}
                {novel.genres?.length ? ` · ${novel.genres.join(', ')}` : ''}
              </p>
            </div>
            <div className="row">
              {resume && (
                <Button kind="primary" icon="play" onClick={() => openChapter(resume)}>
                  {anyRead ? t('novel.continueReading') : t('novel.startReading')}
                </Button>
              )}
              {novel.inLibrary ? (
                <Button icon="minusCircle" onClick={() => removeFromLibrary(novel).then(load)}>
                  {t('novel.removeFromLibrary')}
                </Button>
              ) : (
                <Button icon="plus" kind="primary" onClick={() => addToLibrary(novel).then(load)}>
                  {t('novel.addToLibrary')}
                </Button>
              )}
              <Button icon="refresh" onClick={onRefresh} disabled={busy || !novel.pluginId}>
                {busy ? t('common.working') : t('novel.refresh')}
              </Button>
              <IconButton icon="trash" label={t('library.deleteNovel')} onClick={() => setConfirmDelete(true)} />
            </div>
          </div>
          <div className="chips">
            <span className="chip strong">{statusLabel}</span>
            {novel.pluginId && <span className="chip">{novel.pluginId}</span>}
            <span className="chip">
              {t('novel.chapters', { count: chapters.length, plural: chapters.length === 1 ? '' : 's' })}
            </span>
            {downloaded > 0 && (
              <span className="chip">
                <Icon name="checkCircle" size={12} /> {t('novel.downloadedCount', { count: downloaded })}
              </span>
            )}
          </div>
          {novel.summary && <p className="summary">{novel.summary}</p>}
          <div className="row">
            {novel.site && (
              <a className="btn small" href={novel.site} target="_blank" rel="noreferrer noopener">
                <Icon name="external" size={13} /> {t('novel.openSource')}
              </a>
            )}
            <Button icon="checkCircle" onClick={onMarkAllRead} disabled={!unread}>
              {t('novel.markAllRead')}
            </Button>
          </div>
        </div>
      </div>

      <div className="chapter-toolbar">
        <div className="search-box">
          <Icon name="search" size={15} />
          <input
            className="input borderless"
            placeholder={t('novel.searchChapters')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t('novel.searchChapters')}
          />
        </div>
        <span className="muted small">
          {filtered
            ? t('novel.filteredChapters', { count: chapters.length, plural: chapters.length === 1 ? '' : 's', shown: view.length })
            : t('novel.chapters', { count: chapters.length, plural: chapters.length === 1 ? '' : 's' })}
        </span>
        <span className="grow" />
        <Button
          icon={selection ? 'close' : 'checkCircle'}
          kind={selection ? undefined : 'primary'}
          onClick={() => {
            setEndpoints([]);
            setSelection(selection ? null : []);
          }}
        >
          {selection ? t('selection.exit') : t('selection.start')}
        </Button>
        <button
          className={`btn ${panel === 'filter' ? 'on' : ''} ${prefs.filters.unread || prefs.filters.downloaded ? 'tinted' : ''}`}
          onClick={() => setPanel(panel === 'filter' ? null : 'filter')}
          aria-pressed={panel === 'filter'}
        >
          <Icon name="filter" size={15} /> {t('chapterManage.filter')}
        </button>
        <Select
          value={prefs.sortKey}
          onChange={(v) => setPrefs({ sortKey: v })}
          aria-label={t('chapterManage.sort')}
          options={[
            { value: 'numberAsc', label: t('chapterManage.asc') },
            { value: 'numberDesc', label: t('chapterManage.desc') },
            { value: 'newest', label: t('chapterManage.newestFirst') },
            { value: 'oldest', label: t('chapterManage.oldestFirst') },
          ]}
        />
        <button className={`btn ${panel === 'display' ? 'on' : ''}`} onClick={() => setPanel(panel === 'display' ? null : 'display')}>
          <Icon name="eye" size={15} /> {t('chapterManage.display')}
        </button>
      </div>

      {panel === 'filter' && (
        <div className="panel-row">
          <Checkbox
            label={t('chapterManage.unread')}
            checked={prefs.filters.unread}
            onChange={(v) => setPrefs({ filters: { ...prefs.filters, unread: v } })}
          />
          <Checkbox
            label={t('chapterManage.downloaded')}
            checked={prefs.filters.downloaded}
            onChange={(v) => setPrefs({ filters: { ...prefs.filters, downloaded: v } })}
          />
          <Button icon="close" onClick={() => setPrefs({ filters: DEFAULT_CHAPTER_PREFS.filters })}>
            {t('chapterManage.reset')}
          </Button>
        </div>
      )}
      {panel === 'display' && (
        <div className="panel-row">
          <Checkbox
            label={t('chapterManage.chapterNumber')}
            checked={prefs.display.chapterNumber}
            onChange={(v) => setPrefs({ display: { ...prefs.display, chapterNumber: v } })}
          />
          <Checkbox
            label={t('chapterManage.releaseDate')}
            checked={prefs.display.sourceTitle}
            onChange={(v) => setPrefs({ display: { ...prefs.display, sourceTitle: v } })}
          />
        </div>
      )}

      {selection && (
        <div className="selection-bar" role="toolbar">
          <span className="muted">
            {t('selection.ofN', { count: selected.length, total: view.length })}
          </span>
          <Button icon="checkCircle" onClick={selectAll} disabled={!view.length}>
            {t('selection.selectAll')}
          </Button>
          <Button icon="close" onClick={deselectAll} disabled={!selected.length}>
            {t('selection.deselectAll')}
          </Button>
          <Button
            icon="list"
            kind={canSelectRange ? 'primary' : undefined}
            onClick={selectRange}
            disabled={!canSelectRange}
            title={t('selection.rangeHint')}
          >
            {t('selection.selectRange')}
          </Button>
          {!canSelectRange && <span className="muted small range-hint">{t('selection.rangeHint')}</span>}
          <span className="grow" />
          <Button icon="downloads" onClick={onDownloadSelected} disabled={!selected.length || busyAction}>
            {t('selection.download')}
          </Button>
          <Button icon="check" onClick={onMarkSelectedRead} disabled={!selected.length || busyAction}>
            {t('selection.markRead')}
          </Button>
          <Button icon="close" onClick={onMarkSelectedUnread} disabled={!selected.length || busyAction}>
            {t('selection.markUnread')}
          </Button>
          <Button icon="trash" onClick={onRemoveSelectedDownloads} disabled={!selected.length || busyAction}>
            {t('selection.removeDownload')}
          </Button>
        </div>
      )}

      {!chapters.length ? (
        <Empty icon="book" title={t('novel.noChapters')} hint={t('novel.noChapters.subtitle')} />
      ) : !view.length ? (
        <Empty icon="filter" title={t('novel.noChaptersMatchFilters')} />
      ) : (
        <div className="chapter-list" role="listbox" aria-multiselectable={!!selection}>
          {view.slice(0, shown).map((c, i) => {
            const isSelected = selectedSet.has(c.id);
            const endLabel = c.id === rangeStartId ? t('selection.rangeStart') : c.id === rangeEndId ? t('selection.rangeEnd') : null;
            return (
              <div
                key={c.id}
                role="option"
                aria-selected={selection ? isSelected : undefined}
                className={`chapter-row ${c.read ? 'read' : ''} ${isSelected ? 'selected' : ''} ${endLabel ? 'range-end' : ''}`}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (!selection) setSelection([c.id]);
                  else select(c.id);
                }}
              >
                {selection && (
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => select(c.id)}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={c.name}
                  />
                )}
                {prefs.display.chapterNumber && <span className="chapter-num muted">{c.number}</span>}
                <button
                  className="grow plain chapter-open"
                  onClick={() => (selection ? select(c.id) : openChapter(c))}
                  onClickCapture={(e) => {
                    if (selection && e.shiftKey) {
                      e.preventDefault();
                      select(c.id, { range: true });
                    }
                  }}
                >
                  <ChapterState chapter={c} />
                  <span className="chapter-name">{c.name}</span>
                  {selection && endLabel && <span className="range-tag">{endLabel}</span>}
                  {prefs.display.sourceTitle && c.releaseTime && <span className="muted small">{fmtDate(c.releaseTime)}</span>}
                </button>
                {!c.read && c.progress > 0 && <span className="muted small nowrap">{pct(c.progress)}</span>}
                {c.downloaded && <Icon name="checkCircle" size={15} className="ok" title={t('chapter.offline')} />}
                <IconButton
                  icon="downloads"
                  label={c.downloaded ? t('selection.removeDownload') : t('chapter.download')}
                  onClick={() =>
                    c.downloaded
                      ? removeDownload(c.id).then(load)
                      : downloadChapters([c], novel).then(() => toast.show(t('selection.addedToDownloads', { count: 1, plural: '' })))
                  }
                />
                <IconButton
                  icon={c.read ? 'close' : 'check'}
                  label={c.read ? t('selection.markUnread') : t('selection.markRead')}
                  onClick={() => markRead([c.id], !c.read).then(load)}
                />
              </div>
            );
          })}
          {shown < view.length && <div ref={sentinel} className="chapter-more" aria-hidden="true" />}
        </div>
      )}

      <Dialog
        open={!!confirmDelete}
        title={t('library.deleteNovel')}
        onClose={() => setConfirmDelete(false)}
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</Button>
            <Button
              kind="danger"
              onClick={async () => {
                setConfirmDelete(false);
                await deleteNovel(novel.id);
                toast.show(t('library.deleted', { title: novel.title }));
                go('library');
              }}
            >
              {t('library.deleteNovel')}
            </Button>
          </>
        }
      >
        <p>{t('library.deleteNovelBody')}</p>
        <p className="muted">{t('library.deleteNovelHint')}</p>
      </Dialog>
      {toast.node}
    </div>
  );
}

function getLastReadId(chapters) {
  let best = null;
  for (const c of chapters) if (c.lastReadAt && (!best || c.lastReadAt > best.lastReadAt)) best = c;
  return best?.id ?? null;
}

function fmtDate(value) {
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString() : '';
}

/** Maps a free-form source status string onto a known Honya label, falling back to the raw value. */
function statusFor(raw, t) {
  if (!raw) return t('novel.unknownStatus');
  const s = String(raw).toLowerCase();
  if (s.includes('complet') || s.includes('finished')) return t('novel.status.completed');
  if (s.includes('hiatus') || s.includes('hiati')) return t('novel.status.hiatus');
  if (s.includes('cancel') || s.includes('licensed')) return t('novel.status.cancelled');
  if (s.includes('ongoing') || s.includes('publishing') || s.includes('active')) return t('novel.status.ongoing');
  return raw;
}
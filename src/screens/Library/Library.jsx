import { useMemo, useState } from 'react';
import Icon from '../../components/Icon.jsx';
import { Button, Cover, Dialog, Empty, ErrorBox, Header, IconButton, Segmented, Select, ago, openNovel, pct, useToast } from '../../components/ui.jsx';
import { go } from '../../lib/router';
import { useI18n, useSettings } from '../../lib/settings.jsx';
import { usePresence } from '../../lib/presence';
import { useContinueReading, useLibrary } from '../../lib/useLibrary';
import { deleteNovel, removeFromLibrary } from '../../lib/actions';
import { useDebounced } from '../../lib/store.js';

const SORTS = {
  title: (a, b) => a.title.localeCompare(b.title),
  unread: (a, b) => b.unread - a.unread || a.title.localeCompare(b.title),
  added: (a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0),
  lastRead: (a, b) => (b.lastReadAt ?? 0) - (a.lastReadAt ?? 0),
  progress: (a, b) => pctOf(b) - pctOf(a) || a.title.localeCompare(b.title),
};
const pctOf = (n) => (n.totalChapters ? n.readChapters / n.totalChapters : 0);

// Exactly one card: the novel read most recently, at the chapter it was last read.
function ContinueReading() {
  const t = useI18n();
  const { data, loading } = useContinueReading(1);
  const row = data?.[0];
  if (!row) {
    // First ever load only (afterwards the cached answer is used): hold the space so the grid does not jump.
    return loading ? <section className="continue continue-skeleton" aria-hidden="true" /> : null;
  }
  const done = !!row.read;
  const progress = done ? 1 : Math.min(1, Math.max(0, Number(row.progress) || 0));
  return (
    <section className="continue">
      <h3>{t('library.continueReading')}</h3>
      <button className="continue-card" onClick={() => go('reader', row.chapterId)} title={row.novelTitle}>
        <div className="continue-cover">
          <Cover src={row.novelCover} title={row.novelTitle} />
        </div>
        <div className="continue-info">
          <div className="continue-title">{row.novelTitle}</div>
          <div className="continue-chapter">{row.chapterName}</div>
          <div className="continue-progress" aria-label={`${pct(progress)}`}>
            <i style={{ width: `${progress * 100}%` }} />
          </div>
        </div>
        <span className="continue-play" aria-hidden="true">
          <Icon name="play" size={16} filled />
        </span>
      </button>
    </section>
  );
}

export default function Library() {
  const t = useI18n();
  usePresence('library');
  const { settings, update } = useSettings();
  const { data, loading, error, reload } = useLibrary();
  const toast = useToast();
  const [query, setQuery] = useState('');
  const q = useDebounced(query, 150);
  const [filter, setFilter] = useState('all');
  const [confirmDelete, setConfirmDelete] = useState(null);

  const sort = settings.librarySort ?? 'title';
  const view = settings.libraryView ?? 'grid';
  const coverSize = Math.min(260, Math.max(120, Number(settings.coverSize) || 160));

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data ?? [])
      .filter((n) => {
        if (filter === 'unread' && n.unread === 0) return false;
        if (filter === 'downloaded' && !n.downloadedChapters) return false;
        if (filter === 'started' && !n.lastReadAt) return false;
        if (!needle) return true;
        return `${n.title} ${n.author ?? ''} ${(n.genres ?? []).join(' ')}`.toLowerCase().includes(needle);
      })
      .sort(SORTS[sort] ?? SORTS.title);
  }, [data, q, filter, sort]);

  const totals = useMemo(() => {
    const all = data ?? [];
    return {
      count: all.length,
      unread: all.reduce((s, n) => s + n.unread, 0),
      downloaded: all.reduce((s, n) => s + n.downloadedChapters, 0),
      started: all.filter((n) => n.lastReadAt).length,
    };
  }, [data]);

  const onRemove = async (novel) => {
    await removeFromLibrary(novel);
    toast.show(t('library.removed', { title: novel.title }));
  };

  const onDelete = async () => {
    const novel = confirmDelete;
    setConfirmDelete(null);
    if (!novel) return;
    await deleteNovel(novel.id);
    toast.show(t('library.deleted', { title: novel.title }));
  };

  const title = <h1>{t('nav.library')}</h1>;

  return (
    <>
      <Header
        title={t('nav.library')}
        subtitle={data ? t('library.withUnread', { count: totals.count, plural: totals.count === 1 ? '' : 's', unread: totals.unread }) : ' '}
      >
        <div className="search-box">
          <Icon name="search" size={15} />
          <input
            className="input borderless"
            placeholder={t('library.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t('library.searchA11y')}
          />
          {query && (
            <button className="clear" onClick={() => setQuery('')} aria-label={t('common.clear')}>
              <Icon name="close" size={13} />
            </button>
          )}
        </div>
        <Select
          value={filter}
          onChange={setFilter}
          aria-label={t('novel.filter')}
          options={[
            { value: 'all', label: t('library.filterAll') },
            { value: 'unread', label: t('library.filterUnread') },
            { value: 'started', label: t('library.filterStarted') },
            { value: 'downloaded', label: t('chapterManage.downloaded') },
          ]}
        />
        <Select
          value={sort}
          onChange={(v) => update({ librarySort: v })}
          aria-label={t('chapterManage.sort')}
          options={[
            { value: 'title', label: t('library.sortTitle') },
            { value: 'unread', label: t('library.sortUnread') },
            { value: 'added', label: t('library.sortAdded') },
            { value: 'lastRead', label: t('library.sortLastRead') },
            { value: 'progress', label: t('library.sortProgress') },
          ]}
        />
        {view === 'grid' && (
          <label className="size-slider" title={t('library.gridA11y')}>
            <Icon name="grid" size={13} />
            <input
              type="range"
              min={120}
              max={260}
              step={10}
              value={coverSize}
              aria-label={t('library.gridA11y')}
              onChange={(e) => update({ coverSize: Number(e.target.value) })}
            />
            <Icon name="grid" size={19} />
          </label>
        )}
        <Segmented
          value={view}
          onChange={(v) => update({ libraryView: v })}
          options={[
            { value: 'grid', label: '', icon: 'grid' },
            { value: 'list', label: '', icon: 'list' },
          ]}
        />
      </Header>

      {!loading && !error && totals.count > 0 && <ContinueReading />}

      {error ? (
        <ErrorBox error={error} onRetry={reload} />
      ) : loading && !data ? (
        <p className="muted">{t('common.loading')}</p>
      ) : !data?.length ? (
        <Empty icon="library" title={t('library.empty')} hint={t('library.empty.subtitle')}>
          <div className="row center">
            <Button kind="primary" icon="catalogs" onClick={() => go('catalogs')}>
              {t('library.findNovels')}
            </Button>
            <Button icon="settings" onClick={() => go('settings')}>
              {t('settings.title')}
            </Button>
          </div>
        </Empty>
      ) : !list.length ? (
        <Empty icon="search" title={t('library.noMatches')} hint={t('library.noMatches.subtitle')} />
      ) : view === 'grid' ? (
        <div className="grid" style={{ '--cover-w': `${coverSize}px` }}>
          {list.map((n) => (
            <div key={n.id} className="card-wrap">
              <button className="card" onClick={() => openNovel(n)} title={n.title}>
                <div className="cover-wrap">
                  <Cover src={n.cover} title={n.title} />
                  {n.unread > 0 && <span className="badge">{n.unread > 99 ? '99+' : n.unread}</span>}
                  {n.pendingDownloads > 0 && (
                    <span className="badge badge-alt" title={t('downloads.queued')}>
                      <Icon name="downloads" size={11} />
                    </span>
                  )}
                </div>
                <div className="card-title">{n.title}</div>
                <div className="card-meta muted">{n.author || t('novel.unknownAuthor')}</div>
                <div className="bar" title={`${n.readChapters}/${n.totalChapters}`}>
                  <i style={{ width: `${pctOf(n) * 100}%` }} />
                </div>
              </button>
              <div className="card-actions">
                {n.lastChapterId && (
                  <IconButton icon="play" label={t('library.continueReading')} onClick={() => go('reader', n.lastChapterId)} />
                )}
                <IconButton icon="minusCircle" label={t('novel.removeFromLibrary')} onClick={() => onRemove(n)} />
                <IconButton icon="trash" label={t('library.deleteNovel')} onClick={() => setConfirmDelete(n)} />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="list">
          {list.map((n) => (
            <div key={n.id} className="row-item">
              <button className="grow plain row-click" onClick={() => openNovel(n)}>
                <div className="thumb">
                  <Cover src={n.cover} title={n.title} />
                </div>
                <div className="grow">
                  <div className="strong">{n.title}</div>
                  <div className="muted small">
                    {n.author || t('novel.unknownAuthor')} · {n.readChapters}/{n.totalChapters} {t('library.chaptersRead')}
                    {n.lastChapterName ? ` · ${n.lastChapterName}` : ''}
                  </div>
                </div>
              </button>
              {n.downloadedChapters > 0 && (
                <span className="chip" title={t('chapterManage.downloaded')}>
                  <Icon name="checkCircle" size={12} /> {n.downloadedChapters}
                </span>
              )}
              {n.unread > 0 && <span className="badge static">{n.unread}</span>}
              <span className="muted small nowrap">{n.lastReadAt ? ago(n.lastReadAt) : ''}</span>
              {n.lastChapterId && (
                <IconButton icon="play" label={t('library.continueReading')} onClick={() => go('reader', n.lastChapterId)} />
              )}
              <IconButton icon="minusCircle" label={t('novel.removeFromLibrary')} onClick={() => onRemove(n)} />
              <IconButton icon="trash" label={t('library.deleteNovel')} onClick={() => setConfirmDelete(n)} />
            </div>
          ))}
        </div>
      )}

      {confirmDelete && (
        <Dialog
          open
          title={t('library.deleteNovel')}
          onClose={() => setConfirmDelete(null)}
          footer={
            <>
              <Button onClick={() => setConfirmDelete(null)}>{t('common.cancel')}</Button>
              <Button kind="danger" onClick={onDelete}>
                {t('library.deleteNovel')}
              </Button>
            </>
          }
        >
          <p>{t('library.deleteNovelBody')}</p>
          <p className="muted small">{t('library.deleteNovelHint')}</p>
        </Dialog>
      )}
      {toast.node}
    </>
  );
}
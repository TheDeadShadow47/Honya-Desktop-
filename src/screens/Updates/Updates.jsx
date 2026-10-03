import { useState } from 'react';
import Icon from '../../components/Icon.jsx';
import {
  Button,
  Checkbox,
  ChapterState,
  Cover,
  Empty,
  ErrorBox,
  Header,
  IconButton,
  openChapter,
  openNovel,
  useToast,
} from '../../components/ui.jsx';
import { go } from '../../lib/router';
import { useI18n } from '../../lib/settings.jsx';
import { usePresence } from '../../lib/presence';
import { useLibraryUpdateState, useUpdates } from '../../lib/useLibrary';
import {
  cancelLibraryUpdate,
  downloadChapters,
  markRead,
  runLibraryUpdate,
} from '../../lib/actions';

export default function Updates() {
  const t = useI18n();
  usePresence('updates');
  const toast = useToast();
  const { data, error, reload } = useUpdates(300);
  const updateState = useLibraryUpdateState();
  const [selection, setSelection] = useState(null);
  const [onlyUnread, setOnlyUnread] = useState(true);

  const all = data ?? [];
  const rows = onlyUnread ? all.filter((c) => !c.read) : all;
  const selected = selection ?? [];
  const selectedSet = new Set(selected);
  const unread = all.filter((c) => !c.read).length;
  const novels = new Set(all.map((c) => c.novelId)).size;

  const toggle = (id) => {
    if (!selection) return;
    setSelection((cur) => {
      const set = new Set(cur ?? []);
      if (set.has(id)) set.delete(id);
      else set.add(id);
      return [...set];
    });
  };

  const selectAll = () => selection && setSelection(rows.map((c) => c.id));
  const deselectAll = () => setSelection([]);

  const withSelected = (fn, message) => async () => {
    try {
      await fn([...selectedSet]);
      if (message) toast.show(message);
      setSelection(null);
      reload();
    } catch (e) {
      toast.show(String(e?.message ?? e), 'error');
    }
  };

  const onDownloadSelected = withSelected(
    (ids) => downloadChapters(rows.filter((c) => ids.includes(c.id)), null),
    (n) => t('selection.addedToDownloads', { count: n, plural: n === 1 ? '' : 's' }),
  );
  const onMarkSelectedRead = withSelected((ids) => markRead(ids, true), (n) => t('selection.markedRead', { count: n }));
  const onMarkSelectedUnread = withSelected((ids) => markRead(ids, false), (n) => t('selection.markedUnread', { count: n }));

  const onUpdateAll = async () => {
    try {
      const summary = await runLibraryUpdate();
      toast.show(
        summary?.newChapters
          ? t('updates.updateCompleteNew', { count: summary.newChapters, novels: summary.updatedNovels ?? 0 })
          : t('updates.updateCompleteNone'),
      );
      reload();
    } catch (e) {
      toast.show(String(e?.message ?? e), 'error');
    }
  };

  return (
    <>
      <Header
        title={t('updates.title')}
        subtitle={
          all.length
            ? t('updates.subtitle', { count: unread, novels, total: all.length })
            : t('updates.empty')
        }
      >
        {updateState.running ? (
          <Button icon="close" onClick={cancelLibraryUpdate}>
            {t('updates.cancelUpdate')}
          </Button>
        ) : (
          <Button icon="refresh" kind="primary" onClick={onUpdateAll} disabled={!all.length}>
            {t('updates.updateAll')}
          </Button>
        )}
        <Button
          icon={selection ? 'close' : 'checkCircle'}
          onClick={() => (selection ? setSelection(null) : setSelection([]))}
        >
          {selection ? t('selection.exit') : t('selection.start')}
        </Button>
      </Header>

      {updateState.running && (
        <div className="download-progress">
          <div className="bar">
            <span
              style={{
                width: `${updateState.total ? Math.round((updateState.current / updateState.total) * 100) : 100}%`,
              }}
            />
          </div>
          <span className="muted small">
            {updateState.current} / {updateState.total}
            {updateState.novelTitle ? ` · ${updateState.novelTitle}` : ''}
          </span>
        </div>
      )}

      {error ? (
        <ErrorBox error={error} onRetry={reload} />
      ) : !all.length ? (
        <Empty icon="updates" title={t('updates.empty')} hint={t('updates.emptyHint')}>
          <Button icon="library" onClick={() => go('library')}>
            {t('nav.library')}
          </Button>
        </Empty>
      ) : (
        <>
          <div className="panel-row">
            <Checkbox label={t('updates.onlyUnread')} checked={onlyUnread} onChange={setOnlyUnread} />
            <span className="muted small">
              {onlyUnread
                ? t('updates.showingUnread', { shown: rows.length, total: all.length })
                : t('updates.showingAll', { total: all.length })}
            </span>
          </div>

          {selection && (
            <div className="selection-bar" role="toolbar">
              <span className="muted">{t('selection.ofN', { count: selected.length, total: rows.length })}</span>
              <Button icon="checkCircle" onClick={selectAll} disabled={!rows.length}>
                {t('selection.selectAll')}
              </Button>
              <Button icon="close" onClick={deselectAll} disabled={!selected.length}>
                {t('selection.deselectAll')}
              </Button>
              <span className="grow" />
              <Button icon="downloads" onClick={onDownloadSelected} disabled={!selected.length}>
                {t('selection.download')}
              </Button>
              <Button icon="check" onClick={onMarkSelectedRead} disabled={!selected.length}>
                {t('selection.markRead')}
              </Button>
              <Button icon="close" onClick={onMarkSelectedUnread} disabled={!selected.length}>
                {t('selection.markUnread')}
              </Button>
            </div>
          )}

          {!rows.length ? (
            <Empty icon="checkCircle" title={t('updates.allCaughtUp')} />
          ) : (
            <div className="list updates-list" role="listbox" aria-multiselectable={!!selection}>
              {rows.map((c) => {
                const isSelected = selectedSet.has(c.id);
                return (
                  <div
                    key={`${c.novelId}:${c.id}`}
                    className={`row-item update-row ${c.read ? 'read' : ''} ${isSelected ? 'selected' : ''}`}
                    role="option"
                    aria-selected={selection ? isSelected : undefined}
                  >
                    <Cover src={c.novelCover} title={c.novelTitle} className="tiny" />
                    {selection && (
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggle(c.id)}
                        onClick={(e) => e.stopPropagation()}
                        aria-label={c.name}
                      />
                    )}
                    <ChapterState chapter={c} />
                    <button
                      className="grow plain update-info"
                      onClick={() => (selection ? toggle(c.id) : openChapter(c))}
                    >
                      <span className="dl-title">{c.name}</span>
                      <span className="muted small">{c.novelTitle}</span>
                    </button>
                    <Icon name="sparkle" size={13} className="new-tag" title={t('updates.newChapter')} />
                    <IconButton icon="book" label={t('novel.openNovel')} onClick={() => openNovel(c.novelId)} />
                    <IconButton
                      icon={c.read ? 'close' : 'check'}
                      label={c.read ? t('selection.markUnread') : t('selection.markRead')}
                      onClick={() => markRead([c.id], !c.read).then(reload)}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
      {toast.node}
    </>
  );
}

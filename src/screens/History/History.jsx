import { useState } from 'react';
import Icon from '../../components/Icon.jsx';
import {
  Button,
  ChapterState,
  Cover,
  Dialog,
  Empty,
  ErrorBox,
  Header,
  IconButton,
  openChapter,
  openNovel,
  pct,
  useToast,
} from '../../components/ui.jsx';
import { useI18n } from '../../lib/settings.jsx';
import { usePresence } from '../../lib/presence';
import { useHistory } from '../../lib/useLibrary';
import { clearHistory, removeHistoryEntry } from '../../lib/actions';

export default function History() {
  const t = useI18n();
  usePresence('history');
  const toast = useToast();
  const { data, error, reload } = useHistory(300);
  const [confirmClear, setConfirmClear] = useState(false);
  const rows = data ?? [];

  const remove = async (id) => {
    await removeHistoryEntry(id);
    toast.show(t('history.removed'));
    reload();
  };

  return (
    <>
      <Header
        title={t('history.title')}
        subtitle={rows.length ? t('history.subtitle', { count: rows.length }) : t('history.empty')}
      >
        <Button icon="trash" onClick={() => setConfirmClear(true)} disabled={!rows.length}>
          {t('history.clear')}
        </Button>
      </Header>

      {error ? (
        <ErrorBox error={error} onRetry={reload} />
      ) : !rows.length ? (
        <Empty icon="history" title={t('history.empty')} hint={t('history.emptyHint')} />
      ) : (
        <div className="list history-list">
          {rows.map((h) => (
            <div key={`${h.chapterId}`} className="row-item history-row">
              <Cover src={h.novelCover} title={h.novelTitle} className="tiny" />
              <button className="grow plain history-info" onClick={() => openChapter(h)}>
                <span className="grow row">
                  <span className="dl-title">{h.chapterName ?? h.chapterId}</span>
                  <ChapterState chapter={h} />
                </span>
                <span className="muted small">
                  {h.novelTitle}
                  {h.progress > 0 ? ` · ${pct(h.progress)}` : ''}
                </span>
              </button>
              <span className="muted small nowrap">{formatWhen(h.lastReadAt ?? h.openedAt, t)}</span>
              <IconButton icon="book" label={t('novel.openNovel')} onClick={() => openNovel(h.novelId)} />
              <IconButton icon="trash" label={t('history.remove')} onClick={() => remove(h.chapterId)} />
            </div>
          ))}
        </div>
      )}

      <Dialog
        open={confirmClear}
        title={t('history.clear')}
        onClose={() => setConfirmClear(false)}
        footer={
          <>
            <Button onClick={() => setConfirmClear(false)}>{t('common.cancel')}</Button>
            <Button
              kind="danger"
              onClick={async () => {
                setConfirmClear(false);
                await clearHistory();
                toast.show(t('history.cleared'));
                reload();
              }}
            >
              {t('history.clear')}
            </Button>
          </>
        }
      >
        <p>{t('history.clearBody')}</p>
        <p className="muted row">
          <Icon name="info" size={14} /> {t('history.clearHint')}
        </p>
      </Dialog>
      {toast.node}
    </>
  );
}

function formatWhen(ts, t) {
  if (!ts) return '';
  const then = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(then)) return '';
  const diff = Date.now() - then;
  if (diff < 60_000) return t('common.justNow');
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h`;
  return new Date(then).toLocaleDateString();
}

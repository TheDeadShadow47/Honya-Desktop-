import Icon from '../../components/Icon.jsx';
import {
  Button,
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
import { useDownloadQueue } from '../../lib/useLibrary';
import {
  cancelAllQueuedDownloads,
  cancelDownload,
  clearCompletedDownloads,
  clearFailedDownloads,
  pauseDownloads,
  removeDownload,
  resumeDownloads,
  retryFailedDownloads,
} from '../../lib/actions';

const SECTIONS = ['downloading', 'queued', 'failed', 'completed'];

export default function Downloads() {
  const t = useI18n();
  usePresence('downloads');
  const toast = useToast();
  const { items, error, reload, paused, batchTotal, batchDone, batchFailed, active } = useDownloadQueue();
  const list = items ?? [];

  const run = (fn, message) => async () => {
    try {
      await fn();
      if (message) toast.show(message);
      reload();
    } catch (e) {
      toast.show(String(e?.message ?? e), 'error');
    }
  };

  const counts = Object.fromEntries(SECTIONS.map((s) => [s, list.filter((d) => d.status === s).length]));
  const anyFailed = counts.failed > 0;
  const anyQueued = counts.queued > 0 || counts.downloading > 0;
  const pctDone = batchTotal ? Math.round(((batchDone + batchFailed) / batchTotal) * 100) : 0;

  return (
    <>
      <Header
        title={t('downloads.title')}
        subtitle={
          batchTotal
            ? t('downloads.batchProgress', { done: batchDone, failed: batchFailed, total: batchTotal })
            : list.length
              ? t('downloads.activeSubtitle', { count: list.length, plural: list.length === 1 ? '' : 's' })
              : t('downloads.idleSubtitle')
        }
      >
        {paused ? (
          <Button icon="play" kind="primary" onClick={run(resumeDownloads, t('downloads.resumed'))}>
            {t('downloads.resume')}
          </Button>
        ) : (
          <Button icon="pause" onClick={run(pauseDownloads, t('downloads.paused'))} disabled={!anyQueued}>
            {t('downloads.pause')}
          </Button>
        )}
        <Button icon="refresh" onClick={run(retryFailedDownloads, t('downloads.retried'))} disabled={!anyFailed}>
          {t('downloads.retryAll')}
        </Button>
        <Button icon="close" onClick={run(cancelAllQueuedDownloads, t('downloads.cancelledAll'))} disabled={!anyQueued}>
          {t('downloads.cancelAll')}
        </Button>
      </Header>

      {batchTotal > 0 && (
        <div className="download-progress">
          <div className="bar">
            <span style={{ width: `${pctDone}%` }} />
          </div>
          <span className="muted small">
            {batchDone} / {batchTotal}
            {batchFailed ? ` · ${batchFailed} ${t('downloads.failed').toLowerCase()}` : ''}
          </span>
        </div>
      )}

      {error && <ErrorBox error={error} onRetry={reload} />}

      {!list.length && !active ? (
        <Empty icon="downloads" title={t('downloads.empty')} hint={t('downloads.emptyHint')}>
          <Button icon="library" onClick={() => go('library')}>
            {t('nav.library')}
          </Button>
        </Empty>
      ) : (
        SECTIONS.map((section) => {
          const rows = list.filter((d) => d.status === section);
          if (!rows.length) return null;
          return (
            <section key={section} className="dl-section">
              <div className="dl-section-head">
                <h3>
                  <Icon
                    name={
                      section === 'downloading'
                        ? 'download'
                        : section === 'queued'
                          ? 'clock'
                          : section === 'failed'
                            ? 'alert'
                            : 'checkCircle'
                    }
                    size={16}
                  />
                  {t(`downloads.section${section[0].toUpperCase()}${section.slice(1)}`)}
                </h3>
                <span className="muted small">{rows.length}</span>
                <span className="grow" />
                {section === 'failed' && (
                  <Button icon="trash" onClick={run(clearFailedDownloads, t('downloads.clearedFailed'))}>
                    {t('downloads.clearFailed')}
                  </Button>
                )}
                {section === 'completed' && (
                  <Button icon="trash" onClick={run(clearCompletedDownloads, t('downloads.clearedCompleted'))}>
                    {t('downloads.clearCompleted')}
                  </Button>
                )}
              </div>
              <div className="list">
                {rows.map((d) => (
                  <div key={d.chapterId ?? d.id} className="row-item dl-row">
                    <Cover src={d.cover} title={d.chapterName} className="tiny" />
                    <button className="grow plain dl-info" onClick={() => openChapter(d)}>
                      <span className="dl-title">{d.chapterName ?? d.chapterId}</span>
                      <span className="muted small">
                        {d.novelTitle}
                        {d.totalBytes ? ` · ${(d.totalBytes / 1024).toFixed(1)} KB` : ''}
                        {d.error ? ` · ${d.error}` : ''}
                      </span>
                    </button>
                    {d.status === 'downloading' && <Icon name="downloading" size={16} className="spin" />}
                    <IconButton
                      icon="book"
                      label={t('novel.openNovel')}
                      onClick={() => d.novelId && openNovel(d.novelId)}
                    />
                    {['queued', 'downloading'].includes(d.status) ? (
                      <IconButton
                        icon="close"
                        label={t('downloads.cancel')}
                        onClick={run(() => cancelDownload(d.chapterId ?? d.id), t('downloads.cancelled'))}
                      />
                    ) : (
                      <IconButton
                        icon="trash"
                        label={t('selection.removeDownload')}
                        onClick={run(() => removeDownload(d.chapterId ?? d.id), t('selection.removedDownloads', { count: 1 }))}
                      />
                    )}
                  </div>
                ))}
              </div>
            </section>
          );
        })
      )}
      {toast.node}
    </>
  );
}

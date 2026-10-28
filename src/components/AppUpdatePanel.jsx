import { useState } from 'react';
import { appUpdate } from '../lib/api';
import { useI18n, useSettings } from '../lib/settings.jsx';
import { dismissUpdateNotice, useAppUpdate } from '../lib/useAppUpdate';
import { formatBytes, statusView } from '../lib/appUpdateUi';
import { Button } from './ui.jsx';

/**
 * Status, release notes and actions for the app updater. Used in Settings and in the "details" dialog opened from the
 * update notice. Release notes are rendered as plain text (never HTML).
 */
export default function AppUpdatePanel({ onPostponed }) {
  const t = useI18n();
  const { update } = useSettings();
  const { state } = useAppUpdate();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');

  const run = async (fn) => {
    setBusy(true);
    setActionError('');
    try {
      await fn();
    } catch (e) {
      setActionError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  // Long-running operations (check / download) are driven by the pushed main-process state, which also refuses concurrent
  // runs. They must not hold the local `busy` flag: it would keep e.g. "Retry" disabled for a moment after a failure was pushed.
  const fire = (fn) => {
    setActionError('');
    fn().catch((e) => setActionError(e?.message ?? String(e)));
  };

  if (!state) return <p className="muted small">{t('update.checking')}</p>;

  const view = statusView(state);
  const p = state.progress;
  const hasUpdate = !!state.version && ['available', 'downloading', 'ready'].includes(state.status);
  const later = () => {
    update({ postponedUpdateVersion: state.version });
    dismissUpdateNotice(state.version);
    onPostponed?.();
  };
  const manual = state.mode === 'manual';

  return (
    <div className="upd-panel">
      <div className={`upd-status ${view.tone}`} role="status">
        {t(view.key, view.params)}
      </div>
      {state.status !== 'disabled' && (
        <p className="muted small">{t('update.currentVersion', { version: state.currentVersion })}</p>
      )}

      {state.status === 'downloading' && (
        <div>
          <div className="upd-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p?.percent ?? 0)}>
            <i style={{ width: `${Math.round(p?.percent ?? 0)}%` }} />
          </div>
          <p className="muted small">
            {t('update.downloadPercent', { pct: Math.round(p?.percent ?? 0) })}
            {p?.total ? ` · ${t('update.downloadProgress', { downloaded: formatBytes(p.transferred), total: formatBytes(p.total) })}` : ''}
          </p>
        </div>
      )}

      {hasUpdate && (
        <>
          <h4 className="upd-notes-title">{t('appUpdate.releaseNotes')}</h4>
          <pre className="upd-notes">{state.releaseNotes || t('appUpdate.noNotes')}</pre>
        </>
      )}
      {manual && state.status === 'available' && <p className="muted small">{t('appUpdate.manualHint')}</p>}
      {state.status === 'ready' && <p className="muted small">{t('appUpdate.installHint')}</p>}
      {actionError && <p className="upd-status error small">{actionError}</p>}

      <div className="upd-actions">
        {state.canInstall && (
          <Button kind="primary" icon="refresh" disabled={busy} onClick={() => run(() => appUpdate.install())}>
            {t('appUpdate.installRestart')}
          </Button>
        )}
        {state.canDownload && (
          <Button kind="primary" icon="download" onClick={() => fire(() => appUpdate.download())}>
            {t('update.downloadUpdate')}
          </Button>
        )}
        {state.canRetryDownload && (
          <Button kind="primary" icon="refresh" onClick={() => fire(() => appUpdate.download())}>
            {t('update.retry')}
          </Button>
        )}
        {state.canOpenDownload && (
          <Button kind="primary" icon="download" disabled={busy} onClick={() => run(() => appUpdate.openDownload())}>
            {t('appUpdate.downloadFromGithub')}
          </Button>
        )}
        {hasUpdate && state.status !== 'downloading' && (
          <Button disabled={busy} onClick={later}>
            {t('update.later')}
          </Button>
        )}
        {state.status !== 'disabled' && state.status !== 'downloading' && state.status !== 'ready' && !state.canRetryDownload && (
          <Button icon="refresh" disabled={!state.canCheck} onClick={() => fire(() => appUpdate.check())}>
            {state.status === 'checking' ? t('update.checking') : state.status === 'error' ? t('update.retry') : t('update.checkForUpdates')}
          </Button>
        )}
        {state.releasesUrl && (state.status === 'error' || state.missingAsset || hasUpdate) && state.status !== 'disabled' && (
          <Button icon="external" disabled={busy} onClick={() => run(() => appUpdate.openReleases())}>
            {t('appUpdate.openReleases')}
          </Button>
        )}
      </div>
    </div>
  );
}

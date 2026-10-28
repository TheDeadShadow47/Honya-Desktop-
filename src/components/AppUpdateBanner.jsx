import { useState } from 'react';
import { useI18n, useSettings } from '../lib/settings.jsx';
import { dismissUpdateNotice, useAppUpdate } from '../lib/useAppUpdate';
import { shouldNotify } from '../lib/appUpdateUi';
import { Button, Dialog } from './ui.jsx';
import AppUpdatePanel from './AppUpdatePanel.jsx';

/**
 * Small, non-blocking notice in the corner. Shown once per version per session, not for a version the user postponed,
 * and never over the reader. It does nothing by itself: every action is the user's.
 */
export default function AppUpdateBanner({ hidden }) {
  const t = useI18n();
  const { settings, update } = useSettings();
  const { state, dismissed } = useAppUpdate();
  const [open, setOpen] = useState(false);

  const show = shouldNotify(state, { postponedVersion: settings.postponedUpdateVersion, dismissed });
  const version = state?.version ?? '';
  const later = () => {
    update({ postponedUpdateVersion: version });
    dismissUpdateNotice(version);
    setOpen(false);
  };

  return (
    <>
      {show && !hidden && !open && (
        <div className="upd-banner" role="status">
          <strong>{state.status === 'ready' ? t('update.updateReady') : t('update.available', { version })}</strong>
          <p className="muted small">{t('appUpdate.bannerBody')}</p>
          <div className="upd-actions">
            <Button kind="primary" onClick={() => setOpen(true)}>
              {t('appUpdate.details')}
            </Button>
            <Button onClick={later}>{t('update.later')}</Button>
          </div>
        </div>
      )}
      <Dialog open={open} title={t('update.whatsNewTitle', { version })} onClose={() => setOpen(false)} width={560}>
        <AppUpdatePanel onPostponed={() => setOpen(false)} />
      </Dialog>
    </>
  );
}

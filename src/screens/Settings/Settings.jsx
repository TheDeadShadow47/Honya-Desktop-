import { useEffect, useRef, useState } from 'react';
import Icon from '../../components/Icon.jsx';
import { THEMES, READER_BACKGROUNDS } from '@core/theme/theme.js';
import { SUPPORTED_LANGUAGES, LANGUAGE_LABELS } from '@core/i18n/i18n.js';
import { app, discord, plugins } from '../../lib/api';
import { useI18n, useSettings } from '../../lib/settings.jsx';
import { usePresence } from '../../lib/presence';
import { useAsync } from '../../lib/useAsync';
import { Button, Checkbox, Dialog, Header, Segmented, Select, useToast } from '../../components/ui.jsx';
import { go } from '../../lib/router';

const Section = ({ title, hint, children }) => (
  <section className="section">
    <h3>{title}</h3>
    {hint && <p className="muted small">{hint}</p>}
    {children}
  </section>
);

// Live connection status for Discord Rich Presence (polled while the section is on screen).
const useDiscordStatus = (enabled) => {
  const [state, setState] = useState('off');
  useEffect(() => {
    let alive = true;
    const poll = () =>
      discord
        .status()
        .then((r) => alive && setState(r?.state ?? 'off'))
        .catch(() => {});
    const first = setTimeout(poll, 400); // let the preference reach the main process first
    const timer = setInterval(poll, 3000);
    return () => {
      alive = false;
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [enabled]);
  return state;
};

const Field = ({ label, hint, children }) => (
  <label className="field">
    <span className="field-label">
      {label}
      {hint && <small>{hint}</small>}
    </span>
    {children}
  </label>
);

// Drags update a local value instantly and commit to settings at most every 120ms (and on release), so scrubbing a
// slider no longer re-renders and re-saves the whole app on every pixel of movement.
const Slider = ({ label, value, min, max, step = 1, suffix = '', onChange }) => {
  const [local, setLocal] = useState(value);
  const timer = useRef(null);
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => setLocal(value), [value]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const commit = (v) => {
    clearTimeout(timer.current);
    if (v !== value) latest.current(v);
  };
  return (
    <Field label={`${label}: ${local}${suffix}`}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={local}
        onChange={(e) => {
          const v = +e.target.value;
          setLocal(v);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => commit(v), 120);
        }}
        onPointerUp={(e) => commit(+e.currentTarget.value)}
        onKeyUp={(e) => commit(+e.currentTarget.value)}
      />
    </Field>
  );
};

export default function Settings() {
  const t = useI18n();
  usePresence('settings');
  const toast = useToast();
  const { settings, update, replaceAll } = useSettings();
  const discordState = useDiscordStatus(!!settings.discord.enabled);
  const info = useAsync(() => app.info());
  const host = useAsync(() => plugins.hostInfo());
  // Deferred: totalling stored chapter text is the heaviest query in the app and must not delay opening Settings.
  const storage = useAsync(() => new Promise((r) => setTimeout(r, 900)).then(() => app.storageStats()));
  const [confirmReset, setConfirmReset] = useState(false);
  const [repoUrl, setRepoUrl] = useState('');
  const [repoBusy, setRepoBusy] = useState(false);
  const [repoError, setRepoError] = useState('');
  const r = settings.reader;
  const setReader = (patch) => update({ reader: { ...r, ...patch } });

  // A repository is only saved once it answers with a valid plugin list, so typos never end up in the list.
  const addRepo = async () => {
    const u = repoUrl.trim();
    if (!/^https?:\/\//i.test(u)) return setRepoError(t('catalogs.badUrl'));
    if (settings.repositories.includes(u)) return setRepoError(t('settings.repoExists'));
    setRepoBusy(true);
    try {
      await plugins.fetchRepository(u);
      update({ repositories: [...settings.repositories, u] });
      setRepoUrl('');
      setRepoError('');
      toast.show(t('settings.repoAdded'));
    } catch (e) {
      setRepoError(t('settings.repoFailed', { error: e?.message ?? String(e) }));
    } finally {
      setRepoBusy(false);
    }
  };
  const removeRepo = (u) => update({ repositories: settings.repositories.filter((x) => x !== u) });

  const onImport = async () => {
    try {
      const res = await app.importBackup();
      if (res?.canceled) return;
      const urls = (res?.repositories ?? []).map((x) => x?.url ?? x).filter((x) => typeof x === 'string');
      if (urls.length) update({ repositories: [...new Set([...settings.repositories, ...urls])] });
      toast.show(t('settings.imported', { novels: res?.novels ?? 0 }));
    } catch (e) {
      toast.show(t('settings.importFailed', { error: e.message }), 'error');
    }
  };

  const onExport = async () => {
    try {
      const res = await app.exportBackup();
      if (res?.canceled) return;
      toast.show(t('settings.exported', { path: res?.path ?? '' }));
    } catch (e) {
      toast.show(t('settings.exportFailed', { error: e.message }), 'error');
    }
  };

  const onResetPrefs = () => {
    setConfirmReset(false);
    replaceAll(null);
    toast.show(t('settings.prefsReset'));
  };

  return (
    <>
      <Header title={t('settings.title')} subtitle={t('settings.subtitle')} />

      <Section title={t('settings.appearance')} hint={t('settings.appearanceHint')}>
        <div className="themes">
          {Object.values(THEMES).map((th) => (
            <button
              key={th.key}
              className={`theme ${settings.theme === th.key ? 'on' : ''}`}
              onClick={() => update({ theme: th.key })}
              style={{
                background: th.background,
                color: th.text,
                borderColor: settings.theme === th.key ? th.primary : th.outline,
              }}
              aria-pressed={settings.theme === th.key}
            >
              <i style={{ background: th.primary }} />
              {th.name}
            </button>
          ))}
        </div>
        <Field label={t('settings.language')} hint={t('settings.languageHint')}>
          <Select
            value={settings.language}
            onChange={(v) => update({ language: v })}
            options={SUPPORTED_LANGUAGES.map((l) => ({ value: l, label: LANGUAGE_LABELS[l] ?? l }))}
          />
        </Field>
      </Section>

      <Section title={t('settings.library')} hint={t('settings.libraryHint')}>
        <Field label={t('settings.libraryLayout')}>
          <Segmented
            value={settings.libraryView}
            onChange={(v) => update({ libraryView: v })}
            options={[
              { value: 'grid', label: t('settings.grid'), icon: 'library' },
              { value: 'list', label: t('settings.list'), icon: 'history' },
            ]}
          />
        </Field>
        <Slider
          label={t('settings.coverSize')}
          value={settings.coverSize}
          min={120}
          max={260}
          step={10}
          suffix="px"
          onChange={(v) => update({ coverSize: v })}
        />
        <Field label={t('settings.librarySort')}>
          <Select
            value={settings.librarySort}
            onChange={(v) => update({ librarySort: v })}
            options={[
              { value: 'title', label: t('settings.sortTitle') },
              { value: 'author', label: t('settings.sortAuthor') },
              { value: 'lastRead', label: t('settings.sortLastRead') },
              { value: 'added', label: t('settings.sortAdded') },
              { value: 'chapters', label: t('settings.sortChapters') },
            ]}
          />
        </Field>
      </Section>

      <Section title={t('settings.reader')} hint={t('settings.readerHint')}>
        <Field label={t('settings.readerBackground')}>
          <Select
            value={r.background}
            onChange={(v) => setReader({ background: v })}
            options={READER_BACKGROUNDS.map((b) => ({ value: b.key, label: b.name }))}
          />
        </Field>
        <Slider label={t('settings.fontSize')} value={r.fontSize} min={12} max={40} suffix="px" onChange={(v) => setReader({ fontSize: v })} />
        <Slider
          label={t('settings.lineHeight')}
          value={r.lineHeight}
          min={1.3}
          max={2.4}
          step={0.05}
          onChange={(v) => setReader({ lineHeight: v })}
        />
        <Field label={t('settings.fontFamily')}>
          <Segmented
            value={r.fontFamily}
            onChange={(v) => setReader({ fontFamily: v })}
            options={[
              { value: 'serif', label: t('settings.serif') },
              { value: 'sans', label: t('settings.sans') },
              { value: 'mono', label: t('settings.mono') },
            ]}
          />
        </Field>
        <Slider label={t('settings.readingWidth')} value={r.width} min={480} max={1100} step={20} suffix="px" onChange={(v) => setReader({ width: v })} />
        <Slider label={t('settings.pagePadding')} value={r.padding} min={8} max={96} suffix="px" onChange={(v) => setReader({ padding: v })} />
        <Checkbox
          label={t('settings.fullJustify')}
          checked={r.justify}
          onChange={(v) => setReader({ justify: v })}
        />
        <Checkbox
          label={t('settings.continuousScroll')}
          hint={t('settings.continuousScrollHint')}
          checked={r.continuous !== false}
          onChange={(v) => setReader({ continuous: v })}
        />
        <Checkbox
          label={t('settings.markReadOnOpen')}
          hint={t('settings.markReadOnOpenHint')}
          checked={r.markReadOnOpen}
          onChange={(v) => setReader({ markReadOnOpen: v })}
        />
      </Section>

      <Section title={t('settings.tts')} hint={t('settings.ttsHint')}>
        <Slider
          label={t('settings.ttsRate')}
          value={r.ttsRate ?? 1}
          min={0.5}
          max={2}
          step={0.1}
          suffix="x"
          onChange={(v) => setReader({ ttsRate: v })}
        />
        <Slider label={t('settings.ttsPitch')} value={r.ttsPitch ?? 1} min={0.5} max={2} step={0.05} suffix="x" onChange={(v) => setReader({ ttsPitch: v })} />
        <Checkbox label={t('settings.ttsAutoNext')} checked={r.ttsAutoNext} onChange={(v) => setReader({ ttsAutoNext: v })} />
        <Field label={t('settings.ttsVoice')} hint={t('settings.ttsVoiceHint')}>
          <input
            className="input"
            placeholder={t('settings.ttsVoicePlaceholder')}
            value={r.ttsVoice ?? ''}
            onChange={(e) => setReader({ ttsVoice: e.target.value })}
          />
        </Field>
      </Section>

      <Section title={t('settings.downloads')} hint={t('settings.downloadsHint')}>
        <Checkbox label={t('settings.notifications')} checked={settings.notificationsEnabled} onChange={(v) => update({ notificationsEnabled: v })} />
        <Checkbox label={t('settings.notifyStart')} checked={settings.notifyDownloadStart} onChange={(v) => update({ notifyDownloadStart: v })} />
        <Checkbox label={t('settings.notifyComplete')} checked={settings.notifyDownloadComplete} onChange={(v) => update({ notifyDownloadComplete: v })} />
        <Checkbox label={t('settings.notifyFailed')} checked={settings.notifyDownloadFailed} onChange={(v) => update({ notifyDownloadFailed: v })} />
      </Section>

      <Section title={t('settings.updates')} hint={t('settings.updatesHint')}>
        <Field label={t('settings.autoUpdate')}>
          <Select
            value={settings.autoUpdateInterval}
            onChange={(v) => update({ autoUpdateInterval: v })}
            options={[
              { value: 'never', label: t('settings.never') },
              { value: '6h', label: t('settings.every6h') },
              { value: '12h', label: t('settings.every12h') },
              { value: 'daily', label: t('settings.daily') },
            ]}
          />
        </Field>
        <Checkbox
          label={t('settings.notifyNewChapters')}
          checked={settings.notifyNewChaptersFound}
          onChange={(v) => update({ notifyNewChaptersFound: v })}
        />
        <Checkbox label={t('settings.notifyUpdateComplete')} checked={settings.notifyUpdateComplete} onChange={(v) => update({ notifyUpdateComplete: v })} />
        <Checkbox label={t('settings.notifyUpdateFailed')} checked={settings.notifyUpdateFailed} onChange={(v) => update({ notifyUpdateFailed: v })} />
      </Section>

      <Section title={t('catalogs.repositories')} hint={t('settings.sourcesHint')}>
        <div className="row">
          <input
            className="input wide"
            placeholder={t('catalogs.urlPlaceholder')}
            value={repoUrl}
            disabled={repoBusy}
            onChange={(e) => {
              setRepoUrl(e.target.value);
              setRepoError('');
            }}
            onKeyDown={(e) => e.key === 'Enter' && addRepo()}
            aria-label={t('catalogs.repositoryUrl')}
          />
          <Button kind="primary" disabled={repoBusy || !repoUrl.trim()} onClick={addRepo}>
            {repoBusy ? t('catalogs.checkingRepo') : t('common.add')}
          </Button>
        </div>
        {repoError && <p className="small" style={{ color: 'var(--error)' }}>{repoError}</p>}
        {settings.repositories.length ? (
          <div className="list">
            {settings.repositories.map((u) => (
              <div key={u} className="row-item">
                <span className="grow muted repo-url" title={u}>
                  {u}
                </span>
                <Button icon="trash" onClick={() => removeRepo(u)}>
                  {t('common.remove')}
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">{t('catalogs.noRepositories')}</p>
        )}
        <div className="row">
          <Button icon="catalogs" onClick={() => go('catalogs')}>
            {t('nav.catalogs')}
          </Button>
        </div>
      </Section>

      <Section title={t('settings.discord')} hint={t('settings.discordHint')}>
        <Checkbox
          label={t('settings.discordEnabled')}
          checked={!!settings.discord.enabled}
          onChange={(v) => update({ discord: { enabled: v } })}
        />
        {settings.discord.enabled && discordState !== 'off' && (
          <p className="muted small">{t(`settings.discordStatus.${discordState}`)}</p>
        )}
        {['showTitle', 'showChapter', 'showTime', 'showBrowsing'].map((k) => (
          <Checkbox
            key={k}
            label={t(`settings.discord.${k}`)}
            disabled={!settings.discord.enabled}
            checked={!!settings.discord[k]}
            onChange={(v) => update({ discord: { [k]: v } })}
          />
        ))}
      </Section>

      <Section title={t('settings.about')}>
        <p className="muted small">
          Honya Desktop {info.data?.version} · Electron {info.data?.electron} · Node {info.data?.node}
        </p>
        <p className="muted small">
          {t('settings.isolation', { mode: host.data?.isolation ?? '…' })}
        </p>
      </Section>

      <Dialog
        open={confirmReset}
        title={t('settings.resetPrefs')}
        onClose={() => setConfirmReset(false)}
        footer={
          <>
            <Button onClick={() => setConfirmReset(false)}>{t('common.cancel')}</Button>
            <Button kind="danger" onClick={onResetPrefs}>
              {t('settings.resetPrefs')}
            </Button>
          </>
        }
      >
        <p>{t('settings.resetPrefsBody')}</p>
      </Dialog>
      {toast.node}
    </>
  );
}

function formatBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

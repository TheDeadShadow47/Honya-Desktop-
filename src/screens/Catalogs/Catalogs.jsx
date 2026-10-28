import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import Icon from '../../components/Icon.jsx';
import {
  Button,
  Cover,
  Empty,
  ErrorBox,
  Header,
  Segmented,
  Select,
  Spinner,
  useToast,
} from '../../components/ui.jsx';
import { plugins } from '../../lib/api';
import { go } from '../../lib/router';
import { useI18n, useSettings } from '../../lib/settings.jsx';
import { usePresence } from '../../lib/presence';
import { useAsync } from '../../lib/useAsync';
import { subscribe, useResource } from '../../lib/store.js';
import { installPlugin, openNovelResult, uninstallPlugin } from '../../lib/actions';
import { browseReducer, catalogItemKey, catalogPageRequest, initialBrowseState } from './paging.js';

const IsolationWarning = ({ isolation, t }) =>
  isolation === 'none' ? (
    <div className="notice warn row">
      <Icon name="alert" size={16} />
      <span>{t('catalogs.isolationWarning')}</span>
    </div>
  ) : null;

export function Catalogs() {
  const t = useI18n();
  usePresence('catalogs');
  const toast = useToast();
  const { settings } = useSettings();
  const installed = useResource('plugins', () => plugins.listInstalled());
  const host = useAsync(() => plugins.hostInfo());
  // Repositories are managed in Settings; here every saved repository is loaded and merged into one list.
  const repoKey = settings.repositories.join('\n');
  const [repos, setRepos] = useState({}); // url -> { items, error, busy }
  const [reloadTick, setReloadTick] = useState(0);
  const [busyId, setBusyId] = useState(null);
  const [installError, setInstallError] = useState(null);
  const [filter, setFilter] = useState('');
  const [lang, setLang] = useState('');

  useEffect(() => {
    let alive = true;
    const urls = settings.repositories;
    setRepos(Object.fromEntries(urls.map((u) => [u, { items: null, error: null, busy: true }])));
    urls.forEach((u) => {
      plugins
        .fetchRepository(u)
        .then((items) => alive && setRepos((r) => ({ ...r, [u]: { items, error: null, busy: false } })))
        .catch((e) => alive && setRepos((r) => ({ ...r, [u]: { items: null, error: e?.message ?? String(e), busy: false } })));
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoKey, reloadTick]);

  const repoStates = settings.repositories.map((u) => ({ url: u, ...(repos[u] ?? { items: null, error: null, busy: true }) }));
  const loading = repoStates.some((r) => r.busy);
  const failed = repoStates.filter((r) => r.error);
  const items = useMemo(() => {
    const seen = new Set();
    return repoStates.flatMap((r) => r.items ?? []).filter((p) => (seen.has(p.id) ? false : seen.add(p.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repos, repoKey]);

  const install = async (p) => {
    setBusyId(p.id);
    try {
      setInstallError(null);
      await installPlugin(p);
      toast.show(t('catalogs.installed', { name: p.name }));
      installed.reload();
    } catch (e) {
      setInstallError(t('catalogs.installFailed', { error: e.message }));
    } finally {
      setBusyId(null);
    }
  };

  const uninstall = async (p) => {
    try {
      await uninstallPlugin(p.id);
      toast.show(t('catalogs.uninstalled', { name: p.name }));
      installed.reload();
    } catch (e) {
      toast.show(String(e?.message ?? e), 'error');
    }
  };

  const langs = useMemo(() => [...new Set(items.map((p) => p.lang).filter(Boolean))].sort(), [items]);
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase().replace(/\s+/g, '');
    const hay = (p) => `${p.name ?? ''} ${p.id ?? ''} ${p.site ?? ''}`.toLowerCase().replace(/\s+/g, '');
    return items.filter((p) => (!lang || p.lang === lang) && (!q || hay(p).includes(q)));
  }, [items, lang, filter]);

  const have = new Map((installed.data ?? []).map((p) => [p.id, p]));

  return (
    <>
      <Header title={t('catalogs.title')} subtitle={t('catalogs.subtitle')} />
      <IsolationWarning isolation={host.data?.isolation} t={t} />

      <section>
        <h3>{t('catalogs.installedSources')}</h3>
        {installed.error ? (
          <ErrorBox error={installed.error} onRetry={installed.reload} />
        ) : !installed.data?.length ? (
          <Empty icon="catalogs" title={t('catalogs.noneInstalled')} hint={t('catalogs.noneInstalledHint')} />
        ) : (
          <div className="list">
            {installed.data.map((p) => (
              <div key={p.id} className="row-item">
                {p.iconUrl && (
                  <img
                    className="plugin-icon"
                    src={p.iconUrl}
                    alt=""
                    loading="lazy"
                    onError={(e) => {
                      e.currentTarget.style.display = 'none';
                    }}
                  />
                )}
                <button className="grow plain" onClick={() => go('browse', p.id)}>
                  <div className="strong">{p.name}</div>
                  <div className="muted small">
                    {p.lang} · v{p.version}
                  </div>
                </button>
                <Button icon="search" onClick={() => go('browse', p.id)}>
                  {t('catalogs.browse')}
                </Button>
                <Button icon="trash" onClick={() => uninstall(p)}>
                  {t('catalogs.uninstall')}
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>

      {!settings.repositories.length ? (
        <section>
          <h3>{t('catalogs.availableSources')}</h3>
          <Empty icon="catalogs" title={t('catalogs.noRepositories')} hint={t('catalogs.noRepositoriesHint')}>
            <Button kind="primary" icon="settings" onClick={() => go('settings')}>
              {t('catalogs.openSettings')}
            </Button>
          </Empty>
        </section>
      ) : (
        <>
          {loading && <p className="muted">{t('catalogs.loadingRepo')}</p>}
          {failed.map((r) => (
            <div key={r.url} className="row">
              <ErrorBox error={`${r.url}: ${r.error}`} />
              <Button icon="refresh" onClick={() => setReloadTick((n) => n + 1)}>
                {t('catalogs.reload')}
              </Button>
            </div>
          ))}
          {installError && <ErrorBox error={installError} />}
        </>
      )}

      {items.length > 0 && (
        <section>
          <div className="row wrap">
            <input
              className="input wide"
              placeholder={t('catalogs.filterPlaceholder', { count: items.length })}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label={t('catalogs.filterSources')}
            />
            <Select
              value={lang}
              onChange={setLang}
              aria-label={t('catalogs.language')}
              options={[{ value: '', label: t('catalogs.allLanguages') }, ...langs.map((l) => ({ value: l, label: l }))]}
            />
            <span className="muted small">
              {t('catalogs.shownCount', { shown: shown.length, total: items.length })}
            </span>
          </div>
          <div className="list" data-testid="repo-list">
            {shown.map((p) => {
              const current = have.get(p.id);
              const isUpdate = current && current.version !== p.version;
              return (
                <div key={p.id} className="row-item" data-plugin={p.id}>
                  {p.iconUrl && (
                    <img
                      className="plugin-icon"
                      src={p.iconUrl}
                      alt=""
                      loading="lazy"
                      onError={(e) => {
                        e.currentTarget.style.display = 'none';
                      }}
                    />
                  )}
                  <div className="grow">
                    <div className="strong">{p.name}</div>
                    <div className="muted small">
                      {p.lang} · v{p.version}
                    </div>
                  </div>
                  {current && <span className="chip">{t('catalogs.installedChip')}</span>}
                  <Button
                    kind={isUpdate ? 'primary' : undefined}
                    data-install={p.id}
                    disabled={busyId === p.id}
                    icon={busyId === p.id ? undefined : isUpdate ? 'refresh' : 'downloads'}
                    onClick={() => install(p)}
                  >
                    {busyId === p.id ? '…' : isUpdate ? t('catalogs.update') : current ? t('catalogs.reinstall') : t('catalogs.install')}
                  </Button>
                </div>
              );
            })}
          </div>
          {!shown.length && <Empty icon="search" title={t('catalogs.noMatches')} />}
        </section>
      )}
      {toast.node}
    </>
  );
}

// Page-number browsing on top of the existing plugins.popular/search(id, ..., page) API. There is no page-token or
// hasNextPage in the plugin contract: a page is requested until it is empty or repeats items already shown.
function useBrowsePages(pluginId, mode) {
  const [state, dispatch] = useReducer(browseReducer, undefined, initialBrowseState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const generationRef = useRef(0);
  const busyRef = useRef(false);

  const request = useCallback(
    (page) => {
      const { method, args } = catalogPageRequest(mode.kind, pluginId, mode.q, page);
      return plugins[method](...args);
    },
    [pluginId, mode.kind, mode.q],
  );

  const run = useCallback(
    (page, generation, retry = false) => {
      busyRef.current = true;
      dispatch({ type: 'load', page, generation, retry });
      Promise.resolve()
        .then(() => request(page))
        .then((items) => {
          if (generation !== generationRef.current) return; // source/query changed while loading
          dispatch({ type: 'loaded', page, generation, items });
        })
        .catch((error) => {
          if (generation !== generationRef.current) return;
          dispatch({ type: 'failed', page, generation, error });
        })
        .finally(() => {
          if (generation === generationRef.current) busyRef.current = false;
        });
    },
    [request],
  );

  // Page 1, and a clean reset whenever the source, browse mode or search query changes.
  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    dispatch({ type: 'reset', generation });
    run(1, generation);
    return () => {
      // A response from the previous list must never append to the new one.
      if (generation === generationRef.current) generationRef.current += 1;
      busyRef.current = false;
    };
  }, [run]);

  const loadMore = useCallback(() => {
    if (busyRef.current) return; // a scroll event must not duplicate an in-flight request
    const s = stateRef.current;
    if (s.loading || s.done || s.error || s.pendingPage != null) return;
    run(s.nextPage, generationRef.current);
  }, [run]);

  // Retry only the failed page; already-loaded results stay on screen.
  const retry = useCallback(() => {
    if (busyRef.current) return;
    const s = stateRef.current;
    if (!s.error || s.failedPage == null) return;
    run(s.failedPage, generationRef.current, true);
  }, [run]);

  return { state, loadMore, retry };
}

export function Browse({ param: pluginId }) {
  const t = useI18n();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [mode, setMode] = useState({ kind: 'popular', q: '' });
  usePresence(mode.kind === 'search' || q.trim() ? 'search' : 'browse');
  const { state, loadMore, retry } = useBrowsePages(pluginId, mode);
  const meta = useAsync(async () => (await plugins.listInstalled()).find((p) => p.id === pluginId), [pluginId]);
  const sentinelRef = useRef(null);

  useEffect(() => subscribe('plugins'), []);

  // Infinite scrolling: the sentinel sits after the grid and is re-observed for every new page. The visible button is
  // the accessible fallback (and the only trigger if IntersectionObserver is unavailable).
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || state.done || state.error || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      { rootMargin: '600px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [state.nextPage, state.done, state.error, state.loading, loadMore]);

  const open = async (n) => {
    try {
      const id = await openNovelResult(pluginId, n);
      go('novel', id);
    } catch (e) {
      toast.show(String(e?.message ?? e), 'error');
    }
  };

  return (
    <>
      <Header title={meta.data?.name ?? pluginId} subtitle={mode.kind === 'search' ? t('browse.resultsFor', { q: mode.q }) : t('browse.popular')}>
        <Segmented
          value={mode.kind}
          onChange={(kind) => setMode((m) => ({ kind, q: kind === 'search' ? m.q : '' }))}
          options={[
            { value: 'popular', label: t('browse.popular'), icon: 'sparkle' },
            { value: 'search', label: t('browse.search'), icon: 'search' },
          ]}
        />
        <input
          className="input wide"
          placeholder={t('browse.searchThisSource')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && q.trim()) setMode({ kind: 'search', q: q.trim() });
          }}
          aria-label={t('browse.searchThisSource')}
        />
        <Button icon="search" onClick={() => (q.trim() ? setMode({ kind: 'search', q: q.trim() }) : null)}>
          {t('browse.search')}
        </Button>
        <Button icon="arrowLeft" onClick={() => go('catalogs')}>
          {t('common.back')}
        </Button>
      </Header>

      {state.error && !state.items.length ? (
        <ErrorBox error={state.error} onRetry={retry} />
      ) : state.loading && !state.items.length ? (
        <p className="muted">{t('common.loading')}</p>
      ) : !state.items.length ? (
        <Empty icon="search" title={t('browse.noResults')} hint={t('browse.noResultsHint')} />
      ) : (
        <>
          <div className="grid">
            {state.items.map((n) => (
              <button key={catalogItemKey(n)} className="card" onClick={() => open(n)} title={n.name}>
                <div className="cover-wrap">
                  <Cover src={n.cover} title={n.name} />
                </div>
                <div className="card-title">{n.name}</div>
                {n.author && <div className="card-sub">{n.author}</div>}
              </button>
            ))}
          </div>
          {state.error ? (
            <ErrorBox error={state.error} onRetry={retry} />
          ) : state.done ? null : (
            <div className="row" style={{ justifyContent: 'center', alignItems: 'center', gap: 8, paddingTop: 18 }}>
              {state.loading && <Spinner />}
              <Button icon="refresh" disabled={state.loading} onClick={loadMore}>
                {t('browse.loadMore')}
              </Button>
              <span ref={sentinelRef} aria-hidden="true" style={{ width: 1, height: 1 }} />
            </div>
          )}
        </>
      )}
      {toast.node}
    </>
  );
}

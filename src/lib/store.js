import { useCallback, useEffect, useRef, useState } from 'react';

// A tiny invalidation bus. Every mutation goes through lib/actions.js, which announces which
// topics changed; screens subscribed to those topics refetch from SQLite. This keeps the sidebar
// badges, library, updates, history and download views consistent without a global store.

const listeners = new Set();

export function emit(...topics) {
  const set = new Set(topics);
  for (const fn of [...listeners]) {
    try {
      fn(set);
    } catch {}
  }
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Last good result per resource, kept for the life of the window. Screens unmount on every navigation; without this
// each return to a screen started from "no data" (blank frame / spinner / layout shift) until SQLite answered.
const cache = new Map();

/**
 * Loads `loader` and refetches whenever one of `topics` is announced.
 * `loader` must be stable enough for `deps` to describe its inputs.
 *
 * Stale-while-revalidate: with `cacheKey`, the previous result is shown immediately on mount and refreshed in the
 * background. While data exists, `loading` stays false during refetches so nothing flashes or reflows.
 */
export function useResource(topics, loader, deps = [], { enabled = true, cacheKey = null } = {}) {
  const key = cacheKey == null ? null : `${cacheKey}|${JSON.stringify(deps)}`;
  const [state, setState] = useState(() => {
    const hit = key && cache.has(key) ? cache.get(key) : null;
    return hit ? { loading: false, data: hit.data, error: null } : { loading: enabled, data: null, error: null };
  });
  const alive = useRef(true);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const keyRef = useRef(key);
  keyRef.current = key;

  const run = useCallback(() => {
    if (!enabled) return;
    setState((s) => (s.data !== null || s.loading ? s : { ...s, loading: true }));
    Promise.resolve()
      .then(() => loaderRef.current())
      .then((data) => {
        if (keyRef.current) cache.set(keyRef.current, { data });
        if (alive.current) setState({ loading: false, data, error: null });
      })
      .catch((error) => {
        if (!alive.current) return;
        // Keep showing the last good data if a background refresh fails.
        setState((s) => (s.data !== null ? { ...s, loading: false } : { loading: false, data: null, error }));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    alive.current = true;
    // Different inputs (e.g. another novel): adopt that entry's cache, or fall back to a clean loading state.
    const hit = key && cache.has(key) ? cache.get(key) : null;
    setState((s) => (hit ? { loading: false, data: hit.data, error: null } : s.data === null ? s : { loading: enabled, data: null, error: null }));
    run();
    return () => {
      alive.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  useEffect(() => {
    const wanted = Array.isArray(topics) ? topics : [topics];
    return subscribe((changed) => {
      if (wanted.some((w) => changed.has(w))) run();
    });
  }, [run, Array.isArray(topics) ? topics.join('|') : topics]);

  return { ...state, reload: run, setData: (data) => setState((s) => ({ ...s, data })) };
}

/** Debounced value, for search inputs. */
export function useDebounced(value, ms = 200) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}
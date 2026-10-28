// Pure pagination rules for the source browser (Catalogs -> Browse). The LNReader contract is "an array per page":
// there is no hasNextPage token, so a page ends the list when it is empty or contributes nothing new. Keeping this
// logic here makes the stop/retry/stale rules testable without React or the plugin host.

/** Stable identity for a plugin result. LNReader plugins provide `path`; `name` is the fallback. */
export function catalogItemKey(novel) {
  const path = typeof novel?.path === 'string' ? novel.path.trim() : '';
  if (path) return `path:${path}`;
  const name = typeof novel?.name === 'string' ? novel.name.trim() : '';
  if (name) return `name:${name}`;
  try {
    return `item:${JSON.stringify(novel)}`;
  } catch {
    return `item:${String(novel)}`;
  }
}

/**
 * The existing IPC call for one page. Popular and search intentionally have different signatures: only search carries
 * the query. `page` is always the last argument, matching pluginService/pluginApi.
 */
export function catalogPageRequest(kind, pluginId, query, page) {
  return kind === 'search'
    ? { method: 'search', args: [pluginId, query, page] }
    : { method: 'popular', args: [pluginId, page] };
}

/** Append only unseen items. `added === 0` means the source repeated a page it already returned. */
export function mergeCatalogPage(items, seen, incoming) {
  const known = new Set(seen);
  const nextSeen = seen.slice();
  const merged = [];
  for (const item of Array.isArray(incoming) ? incoming : []) {
    const key = catalogItemKey(item);
    if (known.has(key)) continue;
    known.add(key);
    nextSeen.push(key);
    merged.push(item);
  }
  return { items: items.concat(merged), seen: nextSeen, added: merged.length };
}

export const initialBrowseState = () => ({
  generation: 0,
  items: [],
  seen: [],
  nextPage: 1,
  pendingPage: null,
  loading: false,
  error: null,
  failedPage: null,
  done: false,
});

/**
 * One list, one request at a time. `generation` invalidates in-flight responses after a source/mode/query change;
 * `pendingPage` rejects late responses for a page that is no longer being awaited. A failed page is kept (with its
 * items) until an explicit retry for that same page, so scrolling cannot hammer a broken source.
 */
export function browseReducer(state, action) {
  switch (action.type) {
    case 'reset':
      return { ...initialBrowseState(), generation: action.generation };
    case 'load': {
      if (action.generation !== state.generation) return state;
      if (state.loading || state.pendingPage != null || state.done) return state;
      if (state.error && !action.retry) return state;
      if (action.retry && state.failedPage !== action.page) return state;
      return { ...state, loading: true, pendingPage: action.page, error: null, failedPage: null };
    }
    case 'loaded': {
      // A response for another generation or another awaited page is stale and must not touch this list.
      if (action.generation !== state.generation || action.page !== state.pendingPage) return state;
      const incoming = Array.isArray(action.items) ? action.items : [];
      const merged = mergeCatalogPage(state.items, state.seen, incoming);
      return {
        ...state,
        items: merged.items,
        seen: merged.seen,
        nextPage: action.page + 1,
        pendingPage: null,
        loading: false,
        error: null,
        failedPage: null,
        // Empty page, or a page the source already returned: there is nothing further to request.
        done: incoming.length === 0 || merged.added === 0,
      };
    }
    case 'failed': {
      if (action.generation !== state.generation || action.page !== state.pendingPage) return state;
      return { ...state, loading: false, pendingPage: null, error: action.error, failedPage: action.page };
    }
    default:
      return state;
  }
}

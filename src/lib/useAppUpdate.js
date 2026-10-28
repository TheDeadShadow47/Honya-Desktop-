import { useEffect, useSyncExternalStore } from 'react';
import { appUpdate } from './api';

// One shared copy of the main-process updater state for every component (banner + Settings). The main process pushes
// each change; the first subscriber also fetches the current state once.
let snapshot = { state: null, dismissed: [] };
const listeners = new Set();
let started = false;

const publish = (patch) => {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((l) => l());
};
const start = () => {
  if (started) return;
  started = true;
  appUpdate.onState((s) => publish({ state: s }));
  appUpdate
    .getState()
    .then((s) => publish({ state: s }))
    .catch(() => {}); // the app stays fully usable if the updater is unavailable
};
const subscribe = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** Hide the notice for this version for the rest of the session (the persisted "Later" lives in the preferences). */
export const dismissUpdateNotice = (version) => {
  if (version && !snapshot.dismissed.includes(version)) publish({ dismissed: [...snapshot.dismissed, version] });
};

export function useAppUpdate() {
  useEffect(start, []);
  return useSyncExternalStore(subscribe, () => snapshot);
}

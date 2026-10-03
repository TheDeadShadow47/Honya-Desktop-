// Discord Rich Presence manager. Optional and isolated: the reader never imports this module; it is attached to the
// reading-session bus in electron/main.js. Nothing here can throw into the caller or block reading.
//
// Behaviour
//  - Enabled from Settings (prefs.discord.enabled). While enabled it keeps trying to reach Discord quietly
//    (10s, 20s, 40s, then every 60s), so starting Discord after Honya works and Discord restarts are survived.
//  - Updates are debounced and rate-limited; identical activities are not re-sent.
//  - Leaving the reader clears the presence after a short grace period (chapter-to-chapter navigation briefly ends
//    and restarts the session, and must not flicker or reset the elapsed timer).
import { DiscordRpc } from './rpc.js';
import { buildActivity, buildScreenActivity } from './activity.js';
import { resolveClientId } from './config.js';

export const implemented = true;

const DEBOUNCE_MS = 800;
const MIN_INTERVAL_MS = 4000; // Discord allows ~5 activity updates per 20s
const END_GRACE_MS = 10000;
const RETRY_MS = [10000, 20000, 40000, 60000];

export function createDiscordManager({
  getPrefs,
  clientId = resolveClientId(),
  createRpc = () => new DiscordRpc(),
  timing = {},
  log = (...a) => console.info('[discord]', ...a),
} = {}) {
  const T = { debounce: DEBOUNCE_MS, minInterval: MIN_INTERVAL_MS, endGrace: END_GRACE_MS, retry: RETRY_MS, ...timing };
  let rpc = null;
  let desired = null; // latest reading session, or null when not reading
  let sessionStart = null;
  let screenState = null; // latest non-reader screen { name, title? }; shown whenever the reader is not open
  let browseStart = null; // when the current stretch of "not reading" began (elapsed timer for browsing presence)
  let lastSent = null; // JSON of the activity Discord currently shows ('' = cleared)
  let lastSentAt = 0;
  let failures = 0;
  let flushTimer = null;
  let retryTimer = null;
  let endTimer = null;
  let running = false;
  let again = false;
  let enabledNow = false;
  let stopped = false;
  let warned = false;

  const options = async () => {
    try {
      const p = await getPrefs();
      return { enabled: !!p?.discord?.enabled, ...(p?.discord ?? {}) };
    } catch {
      return { enabled: false };
    }
  };

  const schedule = (delay = T.debounce) => {
    if (stopped) return;
    clearTimeout(flushTimer);
    const wait = Math.max(delay, T.minInterval - (Date.now() - lastSentAt));
    flushTimer = setTimeout(() => void flush(), Math.max(0, wait));
    flushTimer.unref?.();
  };

  const scheduleRetry = () => {
    if (stopped || retryTimer) return;
    const delay = T.retry[Math.min(failures, T.retry.length - 1)];
    failures += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void flush();
    }, delay);
    retryTimer.unref?.();
  };

  const disconnect = () => {
    clearTimeout(retryTimer);
    retryTimer = null;
    const r = rpc;
    rpc = null;
    lastSent = null;
    if (r) {
      r.removeAllListeners('close');
      try {
        r.close();
      } catch {}
    }
  };

  async function ensureConnected() {
    if (rpc?.connected) return true;
    disconnect();
    const r = createRpc();
    r.on('close', () => {
      if (rpc !== r) return;
      rpc = null;
      lastSent = null;
      log('connection lost');
      if (enabledNow) scheduleRetry();
    });
    try {
      await r.connect(clientId);
    } catch (e) {
      if (!warned) log('not connected:', e?.message);
      warned = true;
      scheduleRetry();
      return false;
    }
    rpc = r;
    failures = 0;
    warned = false;
    log('connected');
    return true;
  }

  async function flush() {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      const opts = await options();
      enabledNow = !!clientId && opts.enabled;
      if (!enabledNow) {
        disconnect();
        return;
      }
      if (!(await ensureConnected())) return;
      // Reading wins; otherwise show what the user is doing elsewhere in the app (unless they turned that off).
      let activity = null;
      if (desired) activity = buildActivity(desired, opts, sessionStart);
      else if (screenState && opts.showBrowsing !== false) activity = buildScreenActivity(screenState, opts, browseStart);
      const next = activity ? JSON.stringify(activity) : '';
      if (next === lastSent) return;
      await rpc.setActivity(next ? JSON.parse(next) : null);
      lastSent = next;
      lastSentAt = Date.now();
    } catch (e) {
      log('update failed:', e?.message);
      disconnect();
      if (enabledNow) scheduleRetry();
    } finally {
      running = false;
      if (again) {
        again = false;
        schedule();
      }
    }
  }

  return {
    /** Reading started or moved to another chapter/novel. */
    update(state) {
      try {
        clearTimeout(endTimer);
        endTimer = null;
        if (!desired) sessionStart = Date.now();
        desired = { novel: state?.novel, chapter: state?.chapter };
        schedule();
      } catch {}
    },
    /**
     * The user is on a screen other than the reader ({ name, title? }), or null to forget it.
     * A screen outside the reader means the reader is closed, so any reading session ends right away (no grace period).
     */
    screen(state) {
      try {
        if (desired) {
          clearTimeout(endTimer);
          endTimer = null;
          desired = null;
          sessionStart = null;
          browseStart = Date.now();
        }
        if (state && !screenState) browseStart = Date.now();
        screenState = state && state.name ? { name: state.name, title: state.title } : null;
        schedule();
      } catch {}
    },
    /** Reader closed. The presence is cleared (or falls back to the current screen) after a grace period. */
    end() {
      try {
        if (!desired || endTimer) return;
        endTimer = setTimeout(() => {
          endTimer = null;
          desired = null;
          sessionStart = null;
          if (screenState) browseStart = Date.now(); // fall back to "browsing" with a fresh timer
          schedule(0);
        }, T.endGrace);
        endTimer.unref?.();
      } catch {}
    },
    /** Preferences changed (or app start): re-evaluate enabled/options and connect or disconnect. */
    refresh() {
      failures = 0;
      clearTimeout(retryTimer);
      retryTimer = null;
      schedule(0);
    },
    status() {
      if (!clientId) return { state: 'noClientId' };
      if (!enabledNow) return { state: 'off' };
      return { state: rpc?.connected ? 'connected' : 'waiting' };
    },
    /** App is quitting: drop the presence immediately. Discord also clears it when the connection closes. */
    shutdown() {
      stopped = true;
      for (const t of [flushTimer, retryTimer, endTimer]) clearTimeout(t);
      try {
        rpc?.removeAllListeners('close');
        rpc?.close();
      } catch {}
      rpc = null;
    },
  };
}

/** Subscribe the integration to the reading-session bus. Returns the manager (refresh/status/shutdown). */
export function attachDiscord(sessionBus, { getPrefs } = {}) {
  const manager = createDiscordManager({ getPrefs });
  const safe = (fn) => (state) => {
    try {
      fn(state);
    } catch (e) {
      console.warn('[discord] ignored error', e?.message);
    }
  };
  sessionBus.on('start', safe((s) => manager.update(s)));
  sessionBus.on('chapter', safe((s) => manager.update(s)));
  sessionBus.on('end', safe(() => manager.end()));
  sessionBus.on('screen', safe((s) => manager.screen(s)));
  return manager;
}

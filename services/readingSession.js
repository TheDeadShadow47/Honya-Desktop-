// Reading-session event bus. The reader emits events; integrations (Discord later) subscribe.
// Nothing in the reader imports an integration directly.
import { EventEmitter } from 'node:events';

export function createReadingSessionBus() {
  const bus = new EventEmitter();
  let state = null; // { novel, chapter, progress, startedAt }
  const emit = (type) => {
    try {
      bus.emit(type, state);
      bus.emit('*', type, state);
    } catch (e) {
      console.warn('[session] listener failed', e?.message);
    }
  };
  return {
    on: (type, fn) => bus.on(type, fn),
    start: ({ novel, chapter }) => {
      state = { novel, chapter, progress: 0, startedAt: Date.now() };
      emit('start');
    },
    chapter: ({ novel, chapter }) => {
      state = { novel, chapter, progress: 0, startedAt: state?.startedAt ?? Date.now() };
      emit('chapter');
    },
    progress: (progress) => {
      if (!state) return;
      state = { ...state, progress };
      emit('progress');
    },
    end: () => {
      if (!state) return;
      emit('end');
      state = null;
    },
    // Non-reader screens (library, catalogs...). Not part of the reading state; integrations listen for 'screen'.
    screen: (screen) => {
      try {
        bus.emit('screen', screen ?? null);
      } catch (e) {
        console.warn('[session] listener failed', e?.message);
      }
    },
    current: () => state,
  };
}

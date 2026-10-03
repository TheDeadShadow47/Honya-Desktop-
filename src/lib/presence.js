import { useEffect } from 'react';
import { session } from './api';

// Tells the main process which screen the user is on so Discord Rich Presence can follow them outside the reader
// (the reader reports its own, richer session). Only a generic screen name (and, on a novel page, the title) is sent;
// the main process decides whether anything is shown. Failures are ignored: presence must never affect the UI.
export function usePresence(name, title) {
  useEffect(() => {
    session.screen({ name, title: title || undefined }).catch(() => {});
  }, [name, title]);
}

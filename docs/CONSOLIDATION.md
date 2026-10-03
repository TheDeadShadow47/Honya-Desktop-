# Consolidation notes: continuous reader

Honya Desktop (the `hondesk-final` line, with Discord Rich Presence) is the foundation. The reader gained the
continuous-scrolling behaviour of the earlier `Honya-Desktop` reference build.

## How continuous scrolling works
`src/screens/Reader/Reader.jsx` keeps a list of consecutive chapter *segments* in one scroll container.

* **Append:** when fewer than 1.5 viewports remain below, the next chapter (from the number-ordered chapter list) is loaded
  and appended. One load at a time; appends are de-duplicated by chapter id; a failed chapter shows an inline error with
  **Retry** and is never retried automatically.
* **Active chapter:** the last segment whose top is above a probe line 35% down the viewport. It drives the title bar,
  the URL hash (via `history.replaceState`, so the router does not remount), reading history, bookmarks, search scope and
  Discord presence (`session:chapter`).
* **Progress:** per chapter, with the same formula the single-chapter reader used (0 = chapter top at viewport top, 1 =
  chapter bottom at viewport bottom), written to `chapters.progress` (monotonic) and flushed on exit. Scrolling from the end of
  one chapter into the next marks the first read. A jump (End, scrollbar, jump list) never marks skipped chapters read.
* **Restore:** the chapter the reader opened on is restored from its saved progress.
* **Offline first:** downloaded text is used when present, otherwise the source plugin is called.
* **Memory:** only chapters within 2 of the active one keep DOM nodes (others collapse to a spacer of identical height so
  nothing shifts); text of chapters more than 8 away is released and re-loaded when the reader comes back.
* **Setting:** Settings -> Reader -> *Continuous scrolling* (also in the reader's typography popover). Default on.
  Off restores the original one-chapter-per-page reader exactly, including its arrow-key chapter navigation.

Pure rules live in `src/screens/Reader/continuous.js` (unit tested by `npm run test:reader-logic`).

## Behaviour that changed (deliberately)
* In continuous mode the arrow keys scroll; **J/K**, the arrow buttons and the jump list change chapter.
  (Previously ArrowUp/Down jumped a whole chapter.) Home/End go to the top/bottom of the active chapter.
* The old "reaching 98% of a chapter jumps to the next one" (it was gated by *Continue with the next chapter*) is replaced by
  simply scrolling on. With continuous scrolling off it behaves as before. *Continue with the next chapter* still governs text-to-speech
  carrying on into the next chapter.

## New in the reader (from the reference build)
Jump-to-chapter (list + number box), a typography popover (background, font size, line height, padding, width).

## Tests
`npm test` runs everything. `npm run test:reader` drives the real app through restarts with a synthetic plugin and a fake
Discord server (no internet needed).

## Discord presence outside the reader
Screens report themselves through `usePresence()` (`src/lib/presence.js`) -> `session:screen` IPC -> the reading-session bus ->
the Discord manager, which shows reading when the reader is open and the current screen otherwise (new pref
`discord.showBrowsing`, default on). Tested in `scripts/discord-test.mjs` and end to end in `npm run test:reader`.

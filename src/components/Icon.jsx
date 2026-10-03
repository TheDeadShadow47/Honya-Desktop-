// Consistent stroke icons (24x24 grid). Replaces the emoji navigation so the app reads as a
// desktop reader rather than a mobile mock-up. All icons inherit currentColor.
const P = {
  library: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H19v14H6.5A2.5 2.5 0 0 0 4 19.5zM4 5.5v14M8 7h7M8 10.5h7M8 14h4',
  updates: 'M12 4a8 8 0 1 1-7.4 5M4 4v5h5M12 8.5v4l2.8 1.8',
  history: 'M3.5 12a8.5 8.5 0 1 0 2.6-6.1M3.5 4.5V9H8M12 7.8V12l3 1.8',
  catalogs: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M15.5 8.5l-2 5.5-5.5 2 2-5.5z',
  downloads: 'M12 3v11m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
  settings: 'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4M19.4 14.5a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.9 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-3-1.2l-.1.1a2 2 0 1 1-2.8-2.9l.1-.1a1.7 1.7 0 0 0-1.2-2.9H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-3l-.1-.1a2 2 0 1 1 2.8-2.9l.1.1a1.7 1.7 0 0 0 2.9-1.2V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 3 1.2l.1-.1a2 2 0 1 1 2.8 2.9l-.1.1a1.7 1.7 0 0 0 1.2 2.9h.2a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.6 1.1',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14M20 20l-4-4',
  close: 'M6 6l12 12M18 6 6 18',
  check: 'M4.5 12.5l5 5 10-11',
  chevronLeft: 'M15 5l-7 7 7 7',
  chevronRight: 'M9 5l7 7-7 7',
  chevronUp: 'M5 15l7-7 7 7',
  chevronDown: 'M5 9l7 7 7-7',
  arrowLeft: 'M20 12H4m0 0 6-6m-6 6 6 6',
  arrowRight: 'M4 12h16m0 0-6-6m6 6-6 6',
  arrowUp: 'M12 20V4m0 0-6 6m6-6 6 6',
  arrowDown: 'M12 4v16m0 0-6-6m6 6 6-6',
  volume: 'M4 9.5v5h3.5l4.5 4v-13l-4.5 4zM15.5 9.2a4 4 0 0 1 0 5.6M18.3 6.5a8 8 0 0 1 0 11',
  download: 'M12 3v11m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
  downloading: 'M20 11a8 8 0 1 0-.7 4.3M20 5v6h-6',
  play: 'M7 4.5v15l13-7.5z',
  pause: 'M8.5 4.5v15M15.5 4.5v15',
  stop: 'M6 6h12v12H6z',
  bookmark: 'M6.5 3.5h11v17l-5.5-4-5.5 4z',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  sort: 'M7 4v16m0 0-3-3m3 3 3-3M17 20V4m0 0-3 3m3-3 3 3',
  filter: 'M4 5h16l-6 7v6l-4 2v-8z',
  refresh: 'M20 11a8 8 0 1 0-.7 4.3M20 5v6h-6',
  trash: 'M4 7h16M9.5 7V5h5v2M6.5 7l1 13h9l1-13M10 11v6M14 11v6',
  external: 'M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4',
  more: 'M12 6h.01M12 12h.01M12 18h.01',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  headphones: 'M4 15v-3a8 8 0 0 1 16 0v3M4 15a2 2 0 0 1 2-2h1v7H6a2 2 0 0 1-2-2zM20 15a2 2 0 0 0-2-2h-1v7h1a2 2 0 0 0 2-2z',
  book: 'M5 4.5A1.5 1.5 0 0 1 6.5 3H19v18H6.5A1.5 1.5 0 0 1 5 19.5zM9 3v18',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M3.5 9h17M3.5 15h17M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
  type: 'M5 6.5V4.5h14v2M12 4.5v15M9 19.5h6',
  palette:
    'M12 21a9 9 0 1 1 0-18c4.5 0 8 2.9 8 6.5 0 2.2-1.8 3.5-4 3.5h-1.6a2 2 0 0 0-1.4 3.4c.4.4.2 1.1-.3 1.4-.3.2-.6.2-1 .2zM7.5 12.5h.01M9.5 8h.01M14 7.5h.01M17 10.5h.01',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 7v5.2l3.2 2',
  cloud: 'M7 18a4 4 0 0 1-.4-8A5.5 5.5 0 0 1 17.5 10 3.5 3.5 0 0 1 17 17.5',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 11v5.5M12 7.8h.01',
  eye: 'M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6M12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5',
  eyeOff: 'M4 4l16 16M9.9 5.2A9.6 9.6 0 0 1 12 5c6 0 9.5 6 9.5 6a17 17 0 0 1-3.3 4M6.4 7.6A17 17 0 0 0 2.5 11s3.5 6 9.5 6c1 0 2-.2 2.8-.5M10 10a2.5 2.5 0 0 0 3.4 3.5',
  alert: 'M12 4.5 21 20H3zM12 10v4.5M12 17.5h.01',
  upload: 'M12 20V9m0 0 4 4m-4-4-4 4M4 6V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v1',
  save: 'M5 3h11l3 3v15H5zM8 3v6h7V3M8 14h8v7H8z',
  minusCircle: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M8 12h8',
  checkCircle: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M8 12.5l2.8 2.8L16.5 9.5',
  dots: 'M12 5.5h.01M12 12h.01M12 18.5h.01',
  columns: 'M4 4h16v16H4zM12 4v16',
  textWidth: 'M3 6h18M3 18h18M8 6v12M16 6v12',
  sparkle: 'M12 3.5 13.8 9l5.7 1.8-5.7 1.8L12 18.5l-1.8-5.9L4.5 10.8 10.2 9zM18.5 3v3M20 4.5h-3',
};

export default function Icon({ name, size = 20, className = '', strokeWidth = 1.7, style, filled = false }) {
  const d = P[name];
  if (!d) return null;
  const solid = filled && (name === 'play' || name === 'bookmark');
  return (
    <svg
      className={`icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={solid ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={solid ? 0 : strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={style}
    >
      <path d={d} />
    </svg>
  );
}

export const iconNames = Object.keys(P);
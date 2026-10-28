// Pure builder: reading-session state + user options -> a Discord activity object.
// Only the novel title, the chapter label and — when title sharing is on — the novel's public HTTPS cover URL are ever
// sent. Never paths, plugin ids, chapter/source-page URLs or reading history.
import { LARGE_IMAGE_KEY, APP_NAME } from './config.js';

const BAD = /^(undefined|null|unknown|nan|\[object object\])$/i;

/** Community-documented Discord limit for the `large_image` field. */
const COVER_MAX = 313;

/** LNReader's "no cover" placeholder, as injected by the plugin engine (core/plugins/pluginEngine.js). */
export const PLACEHOLDER_COVER =
  'https://github.com/LNReader/lnreader-plugins/blob/master/public/static/coverNotAvailable.webp?raw=true';

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Cover URLs are fetched by Discord's own media proxy, so they must be publicly reachable. Anything local or private
 * would leak internal host names and could never load. Every check below fails closed.
 */

/** Private, loopback, link-local, CGNAT, test-net, multicast or reserved IPv4. Malformed input counts as unsafe. */
function ipv4Unsafe(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return true;
  const [a, b, c] = p;
  if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16/12
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0/24 and TEST-NET-1
  if (a === 192 && b === 168) return true; // private 192.168/16
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18/15
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  return a >= 224; // multicast 224/4 and reserved 240/4 (incl. 255.255.255.255)
}

/** Expand a serialized IPv6 literal into 8 numeric groups, or null when it is malformed. */
function ipv6Groups(ip) {
  let s = ip.toLowerCase().split('%')[0]; // a zone index cannot be reached publicly
  const dotted = s.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const p = dotted[2].split('.').map(Number);
    if (p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null;
    s = `${dotted[1]}${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
  const fill = right === null ? 0 : 8 - left.length - right.length;
  if ((right !== null && fill < 0) || (right === null && left.length !== 8)) return null;
  const parts = right === null ? left : [...left, ...Array(fill).fill('0'), ...right];
  if (parts.length !== 8) return null;
  const nums = parts.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return nums.some(Number.isNaN) ? null : nums;
}

/** Unspecified, loopback, IPv4-mapped private, unique-local, link-local or multicast IPv6. Malformed counts as unsafe. */
function ipv6Unsafe(ip) {
  const g = ipv6Groups(ip);
  if (!g) return true;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  const embedded = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    return ipv4Unsafe(embedded(g[6], g[7])); // IPv4-mapped ::ffff:0:0/96 and IPv4-compatible ::/96
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return ipv4Unsafe(embedded(g[6], g[7])); // NAT64 64:ff9b::/96
  }
  return false;
}

/** True only for a hostname Discord could actually fetch from the public internet. */
export function isPublicHost(hostname) {
  const host = String(hostname ?? '')
    .toLowerCase()
    .replace(/\.+$/, ''); // a trailing root dot is still the same host
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (bare.includes(':')) return !ipv6Unsafe(bare); // IPv6 literal
  if (IPV4.test(bare)) return !ipv4Unsafe(bare); // IPv4 literal (already normalized by URL)
  return bare.includes('.'); // a single-label name only resolves on a local network
}

const isPlaceholderCover = (u) =>
  /\/covernotavailable\.webp$/i.test(u.pathname) &&
  /(^|\.)(github\.com|githubusercontent\.com)$/i.test(u.hostname);

/**
 * The cover to show as Discord's large image, or '' when it must not be sent. Required: absolute HTTPS, no embedded
 * credentials, a public hostname, at most 313 characters, and not the known placeholder. Never repaired.
 */
export function coverImage(session, opts = {}) {
  if (opts.showTitle === false) return ''; // a cover identifies the novel as strongly as its title does
  const raw = session?.novel?.cover;
  if (typeof raw !== 'string') return '';
  const url = raw.trim();
  if (!url || url.length > COVER_MAX) return '';
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password) return '';
    if (!isPublicHost(u.hostname)) return '';
    if (url === PLACEHOLDER_COVER || isPlaceholderCover(u)) return '';
    return url;
  } catch {
    return '';
  }
}

/** Trimmed single-line string, or '' for null/undefined/objects and placeholder text. */
export const clean = (v) => {
  if (v === null || v === undefined || typeof v === 'object') return '';
  const s = String(v).replace(/\s+/g, ' ').trim();
  return BAD.test(s) ? '' : s;
};

const clip = (s, max = 128) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/** "Chapter 86", or the chapter's own title when it carries more information. '' when nothing is known. */
export function chapterLabel(chapter) {
  const name = clean(chapter?.name);
  const n = Number(clean(chapter?.number));
  const num = Number.isFinite(n) && n > 0 ? String(n) : '';
  if (name) {
    const hasNum = !num || new RegExp(`(^|\\D)${num.replace('.', '\\.')}(\\D|$)`).test(name);
    return clip(hasNum ? name : `Chapter ${num} · ${name}`);
  }
  return num ? `Chapter ${num}` : '';
}

export function buildActivity(session, opts = {}, startedAt = session?.startedAt) {
  const { showTitle = true, showChapter = true, showTime = true } = opts;
  const title = clean(session?.novel?.title);
  const activity = {
    type: 0,
    details: showTitle && title ? `Reading ${clip(title, 120)}` : 'Reading a novel',
    assets: { large_image: coverImage(session, opts) || LARGE_IMAGE_KEY, large_text: APP_NAME },
  };
  const label = showChapter ? chapterLabel(session?.chapter) : '';
  if (label.length >= 2) activity.state = label; // Discord rejects 1-character fields
  if (showTime && Number.isFinite(startedAt)) activity.timestamps = { start: Math.floor(startedAt / 1000) };
  return activity;
}

/** What each non-reader screen shows. Generic on purpose: no search text, source names, ids or paths are ever sent. */
export const SCREEN_DETAILS = {
  library: 'Browsing the library',
  updates: 'Checking for new chapters',
  history: 'Looking through reading history',
  catalogs: 'Browsing catalogs',
  browse: 'Browsing a source',
  search: 'Searching for a novel',
  downloads: 'Managing downloads',
  settings: 'Adjusting settings',
  novel: 'Viewing a novel',
};

/** Activity for "not in the reader". `screen` = { name, title? }. Returns null for an unknown screen. */
export function buildScreenActivity(screen, opts = {}, startedAt) {
  const { showTitle = true, showTime = true } = opts;
  const base = SCREEN_DETAILS[screen?.name];
  if (!base) return null;
  const title = clean(screen?.title);
  const activity = {
    type: 0,
    details: screen.name === 'novel' && showTitle && title ? `Viewing ${clip(title, 120)}` : base,
    assets: { large_image: LARGE_IMAGE_KEY, large_text: APP_NAME },
  };
  if (showTime && Number.isFinite(startedAt)) activity.timestamps = { start: Math.floor(startedAt / 1000) };
  return activity;
}

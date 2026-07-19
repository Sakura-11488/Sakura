import { Image as RNImage, Platform } from 'react-native';
import { type AnimeInfo } from './anime';
import { getWebMediaProxyUrl } from '@/lib/content-proxy-client';
import { MEDIA_BASE_DEFAULT } from '@/lib/content-hosts';

// ─── Media server (nip.io for iOS ATS compliance) ─────────────────────────────
const MEDIA = MEDIA_BASE_DEFAULT;
const PSYOP_BASE = `${MEDIA}/psyopanime`;
const TWO_HE_BASE = `${MEDIA}/2heanime`;
const DEGEGEN_BASE = `${MEDIA}/sakura-originals/degegen-files`;
const DEGEGEN_MANIFEST_URL = `${DEGEGEN_BASE}/manifest.json`;
const DEGEGEN_ASSET_VERSION = '20260608-3eps';

// ─── Local cover images (require() for Metro bundler) ────────────────────────
export const PSYOP_COVER = require('../assets/images/psyopanime.png');
export const BURNIE_COVER = require('../assets/images/burnie-senders-poster.png');
export const TWO_HE_COVER = require('../assets/images/2he.jpg');
export const TWO_HE_COVER_URI = webImg(`${MEDIA}/2heanime.jpg`);
export const DEGEGEN_COVER = require('../assets/images/degenfiles.jpeg');
export const DEGEGEN_EP1_THUMB = require('../assets/images/degenfiles-ep1.jpeg');
const DEGEGEN_REMOTE_COVER_URI = webImg(`${DEGEGEN_BASE}/cover.png?v=${DEGEGEN_ASSET_VERSION}`);
const DEGEGEN_COVER_URI = DEGEGEN_REMOTE_COVER_URI;

function resolveBundledAssetUri(source: number | { uri: string }): string {
  if (typeof source === 'object' && source !== null && 'uri' in source && typeof source.uri === 'string') {
    return source.uri;
  }
  const resolve = (RNImage as typeof RNImage & { resolveAssetSource?: (asset: number) => { uri: string } })
    .resolveAssetSource;
  if (typeof resolve === 'function') {
    return resolve(source as number).uri;
  }
  return `${DEGEGEN_BASE}/ep1-thumb.jpeg?v=${DEGEGEN_ASSET_VERSION}`;
}

const DEGEGEN_EP1_THUMB_URI = resolveBundledAssetUri(DEGEGEN_EP1_THUMB);

// ─── ID registry ──────────────────────────────────────────────────────────────
export const SAKURA_ORIGINAL_IDS = new Set(['psyopanime', '2heanime', 'burnie-senders', 'degegen-files']);

export function isSakuraOriginal(id: string): boolean {
  return SAKURA_ORIGINAL_IDS.has(id);
}

export interface SakuraOriginalAuthor {
  name: string;
  wallet: string;
  /** Local require() or remote uri — shown on the Authors tab */
  avatarImage?: number | { uri: string };
}

/** Producer wallets for Sakura Original anime — used on the Authors tab. */
export const SAKURA_ORIGINAL_AUTHORS: Record<string, SakuraOriginalAuthor> = {
  psyopanime: {
    name: 'PsyopAnime',
    wallet: '4YSEhnFVxnoC3Xa2NXCs4G7CPM9GsLGwhoNzCqfRJMpi',
    avatarImage: PSYOP_COVER,
  },
  '2heanime': {
    name: '2heAnime',
    wallet: 'AYTey4uWERPEc4LyTM7mkPbs5XSjTCbF3hmM6jWoJgA6',
    avatarImage: TWO_HE_COVER,
  },
  'degegen-files': {
    name: 'Degegen Files',
    wallet: '8qQJTKRbiSmqbX1uVMztiogw1KUchfKCKWN2cwdNQMJb',
    avatarImage: { uri: DEGEGEN_REMOTE_COVER_URI },
  },
  'burnie-senders': {
    name: 'Burnie Senders',
    wallet: '8qQJTKRbiSmqbX1uVMztiogw1KUchfKCKWN2cwdNQMJb',
    avatarImage: BURNIE_COVER,
  },
};

export function getSakuraOriginalAuthor(id: string): SakuraOriginalAuthor | null {
  return SAKURA_ORIGINAL_AUTHORS[id] ?? null;
}

// ─── PsyopAnime episode list ──────────────────────────────────────────────────
const PSYOP_EP_RAW: Array<[number, string, string]> = [
  [1, 'BnBj8sRUu6o', 'Enemies of Disclosure Trailer #1'],
  [2, 'O3OBtF67MY0', 'INSERT 1 COIN(S) TO PLAY'],
  [3, '69oB50L7euw', 'WW3 Anime - Maduro'],
  [4, '9hlx5Rslrzk', 'Maximum Carnage technical demo'],
  [5, 'iLNypgG-X8k', 'Enemies of Disclosure: Narrative War'],
  [6, '5W6mxTrmYIs', 'PsyopQueen Reveal'],
  [7, 'FMJCfUhoV0c', 'PsyopQueen Series Trailer'],
  [8, 'EhkENVbG1_E', 'Somali Scam King - FT PsyopAnime'],
  [9, 'QtVXX2bpGjA', 'WW3 // Venezuela'],
  [10, 'yZEYXkrhtgg', 'Green Ranger'],
  [11, '1gQJdIlaXuY', 'CODE WHITE ft Aiden Guo'],
  [12, 'XMOG-5TTiCg', 'WW3 - Iran\'s Revolution'],
  [13, 's_sJPZwV1cI', 'WW3 - World Leaders strike'],
  [14, 'MciXXdZFJzM', 'WW3 - Episode 3'],
  [15, 'aiZdLiH-Lq4', 'WW3 - Ep 4 Trailer'],
  [16, 'qeANZIfik9A', 'WW3 - Ep 4'],
  [17, 'ei2ruRo41GA', 'Grok Imagine Superbowl Contest Entry'],
  [18, 'xg2Anzd4MyQ', 'GROK CONTEST RESULTS'],
  [19, 'ZuZWjjiG6lM', 'Epstein Files preview - Pam Bondi'],
  [20, 'NTpFZLDoxI0', 'Recap of Feb 2026 BTC crash'],
  [21, 'fpgZd4SiwkI', 'Epstein Files preview'],
  [22, 'sjUBdXL4siI', 'Reptilian Ritual'],
  [23, 'I0OX9ZuJOR0', 'State of the Union'],
  [24, 'aGewhQX8xmI', 'Grok contest announcement - enter to win!'],
  [25, 'JAuvfd_2IO0', 'EP 5 preview - Burj Al Arab Jumeirah drone strike'],
  [26, 'SeTpr9JsO94', 'Death of the Ayatollah'],
  [27, 'l1rhOaAj-_k', 'Iran Escalation'],
  [28, 'oNrNnhD5s6s', 'Iran/USA Recap'],
  [29, 'RRqg1PNuLvk', 'Iran counter offensive'],
  [30, 'I31HyZxegzY', "Don't say his name"],
  [31, 'qFIuVw8whbs', 'Trump Declares War'],
  [32, 'c_QXgKvu3TM', 'Epstein Files'],
  [33, 'P5K_J7-b8uI', 'NYC protest goes wrong'],
  [34, 'pVLsEaLkOMo', 'Iranian Football Team'],
  [35, 'y8j5CqapxcU', 'Top 10 Anime Betrayals'],
  [36, 'OS19oNHNnJs', '2026 Trailer'],
  [37, 'LedPhAOIUXI', "Bernie's AI Moratorium"],
  [38, 'iz86M-cdd2k', 'No Kings'],
  [39, 'wur2EZ7csXU', 'WW3 - Pilot Extraction trailer'],
  [40, 'o1UuQJBPYSk', 'WW3 - Ceasefire'],
  [41, 't4RcNosDlmo', 'WW3 - IRGC'],
  [42, 'dmPmpPu5I4E', "Canada's MMIWG2SLGBTQQIA+"],
  [43, 'zXlBHNZx_RA', 'Untitled 2026 Series - Transformation'],
  [44, '9z36buKz_IE', 'Joe Biden is canceled'],
  [45, 'MTkCHlty-j4', 'Southern Poverty Law Center Scam'],
  [46, 'orrYe2SDuN8', 'Southern Poverty Law Center Orientation Meeting'],
  [47, 'ciijNrFFLl4', 'BREAKING - SHOTS FIRED AT WHCA DINNER'],
  [48, 'J19z12LGBec', 'WHCA UPDATE'],
  [49, 'zqS6SRCgaBQ', 'World War 11'],
  [50, '_6W-Cjkhy1M', 'Hentaivirus'],
  [51, 'MF03-Pj92gw', 'Mixtape 10/10'],
  [52, 'LkyFrj904JY', 'WW3 Episode 5 preview'],
  [53, 'P9_dPX3_MMA', 'What are you fighting for?'],
  [54, 'Ax-5qViMdRQ', 'Enemies of Disclosure preview'],
  [55, '1oNINhwUlSg', 'Bitcoin Crash May 2026'],
  [56, '37WQna24yBw', 'Breaking!  Strait of Hormuz will open'],
  [57, '2kDEAPvD_2Y', 'Shots reported outside of the White House'],
  [58, 'i6Epuqc6Ikw', 'WW3 Episode 5'],
  [59, 'K93Q_p_fGpQ', 'World War 3 episodes 1-5 supercut'],
  [60, 'qZR7FdCdAIA', 'Henry Nowak'],
  [61, '4W1xeCAiOx0', 'World War 3 episode 6 preview'],
  [62, 'vGJASDZZE98', 'Asmongold VS'],
  [63, 'aCPQpsYdI0w', 'Trump walks out of interview'],
  [64, '1HD3ofBFk7c', 'Iran shoots down US Helicopter'],
  [65, 'iaGut06MrKk', 'Belfast'],
  [66, '9fAFOljBvJk', 'UFO Disclosure'],
  [67, '2qOLJt01va8', 'Knicks win game 4'],
  [68, 'ZWjlSl4sNCc', 'Pentagon shut down'],
  [69, '-ZHzAlzCkzE', 'News Network - coming soon'],
  [70, 'mopJqNAVNTI', 'Space X IPO'],
  [71, 'LftIVGEqwP8', 'Knicks in 5'],
  [72, 'HDRxe4R3kdM', 'PsyopQueen 2026 trailer'],
  [73, 'kdQvai0KeP0', 'Psyopqueen OVA preview'],
  [74, 'mc8Sc52Zc5o', 'UK bans social media'],
  [75, '5nnhalquFbU', 'UFC Terror plot'],
  [76, 'hdLxHtHKycM', 'Grooming Gang Inquiry'],
  [77, 'mg6kDSEaiMA', 'UFO series'],
  [78, 'Qy63BFlC6Q8', 'Enemies of Disclosure: Narrative War'],
  [79, 'C5-OPZ23fvk', 'Supergirl Movie Review'],
  [80, '84Y-CmsH2EE', 'Supergirl VS Doomsday tech demo'],
  [81, 'AEY58qovEmU', 'Socialist Summer'],
  [82, 'kqjLIvWP7Dc', 'Technical Demo 2'],
  [83, 'pO3pTn4u5tU', 'Michael Saylor sells bitcoin'],
  [84, 'pPluqbSoWhU', 'Venezuela Earthquake'],
  [85, 'KGlKVkJkxM0', 'News Update'],
  [86, 'w-LFecX6D5A', 'Enemies of Disclosure preview'],
  [87, 'xhGbwW-gd4g', 'Russia attacks Kyiv, Ukraine'],
  [88, 'YyKwPvbQzPQ', 'News Network - Episode 1'],
];

const psyopEpisodes: AnimeInfo['episodes'] = PSYOP_EP_RAW.map(([number, ytId, title]) => ({
  id: `psyop-${ytId}`,
  number,
  title,
  thumbnail: webImg(`${PSYOP_BASE}/thumbs/${ytId}.jpg`),
}));

// ─── 2heAnime episode list ────────────────────────────────────────────────────
const TWO_HE_EP_RAW: Array<[string, string, string]> = [
  ['were-still-here', 'werestillhere.mov', "We're Still Here"],
  ['two-titans-collide', 'openaixai.mov', 'Two Titans Collide'],
  ['deal-of-the-cosmos', 'dealofthecosmos.mov', 'Deal of the Cosmos'],
  ['tung-tung-sahur-taxes', 'TTT.mov', 'Tung Tung Sahur: Taxes'],
  ['iceman', 'iceman.mov', 'Iceman'],
  ['hantavirus', 'hanta.mov', 'Hantavirus'],
  ['sienna-star', 'STAR.mov', 'Sienna Star'],
  ['neet', 'neet.mov', 'NEET'],
  ['trillionaire', 'trillionaire.mov', 'Trillionaire'],
];

const twoHeEpisodes: AnimeInfo['episodes'] = TWO_HE_EP_RAW.map(([slug, , title], idx) => ({
  id: `2he-${slug}`,
  number: idx + 1,
  title,
  thumbnail: TWO_HE_COVER_URI,
}));

// ─── Degegen Files episode list ───────────────────────────────────────────────
const degegenEpisodes: AnimeInfo['episodes'] = [
  {
    id: 'degegen-inverse-vibe',
    number: 1,
    title: 'Inverse Vibe',
    thumbnail: DEGEGEN_EP1_THUMB_URI,
  },
  {
    id: 'degegen-sellor',
    number: 2,
    title: 'Sellor',
    thumbnail: webImg(`${DEGEGEN_BASE}/episodes/sellor.png?v=${DEGEGEN_ASSET_VERSION}`),
  },
  {
    id: 'degegen-z-crash',
    number: 3,
    title: 'Z-Crash',
    thumbnail: webImg(`${DEGEGEN_BASE}/episodes/z-crash.png?v=${DEGEGEN_ASSET_VERSION}`),
  },
];

type RemoteWorkEpisode = {
  id: string;
  number?: number;
  title: string;
  thumbnail?: string;
  videoUrl: string;
};

type RemoteWorkManifest = {
  id?: string;
  title?: string;
  description?: string;
  status?: string;
  genres?: string[];
  score?: number | null;
  image?: string;
  cover?: string;
  episodes?: RemoteWorkEpisode[];
};

type RemoteWorkConfig = {
  manifestUrl: string;
  /** Base URL for bare-relative asset paths in the manifest */
  base: string;
  /** Optional cache-bust version appended to asset URLs (legacy Degegen behavior) */
  assetVersion?: string;
  fallback: () => AnimeInfo;
};

type RemoteWorkState = {
  info: AnimeInfo | null;
  streams: Map<string, string>;
  fetchedAt: number;
  inflight: Promise<AnimeInfo | null> | null;
};

const REMOTE_WORK_TTL_MS = 5 * 60_000;

/**
 * Shows whose episode lists live in a droplet manifest.json maintained by the
 * media-ingest service (scripts/droplet/media-ingest). The hardcoded arrays
 * above remain as offline/bootstrap fallback only \u2014 new episodes appear
 * without an app release.
 */
const REMOTE_WORKS: Record<string, RemoteWorkConfig> = {
  psyopanime: {
    manifestUrl: `${PSYOP_BASE}/manifest.json`,
    base: PSYOP_BASE,
    fallback: () => PSYOP_INFO,
  },
  '2heanime': {
    manifestUrl: `${TWO_HE_BASE}/manifest.json`,
    base: TWO_HE_BASE,
    fallback: () => TWO_HE_INFO,
  },
  'degegen-files': {
    manifestUrl: DEGEGEN_MANIFEST_URL,
    base: DEGEGEN_BASE,
    assetVersion: DEGEGEN_ASSET_VERSION,
    fallback: () => DEGEGEN_INFO,
  },
};

const remoteWorkState = new Map<string, RemoteWorkState>();

function stateFor(id: string): RemoteWorkState {
  let state = remoteWorkState.get(id);
  if (!state) {
    state = { info: null, streams: new Map(), fetchedAt: 0, inflight: null };
    remoteWorkState.set(id, state);
  }
  return state;
}

function absoluteMediaUrl(url: string | undefined, base: string): string | undefined {
  if (!url) return undefined;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('/')) return `${MEDIA}${url}`;
  return `${base}/${url.replace(/^\/+/, '')}`;
}

/**
 * On web, route droplet-hosted (plain-HTTP) image URLs through the same-origin
 * HTTPS media proxy so they aren't mixed-content blocked. No-op on native.
 */
export function webImg<T extends string | undefined>(url: T): T {
  if (!url || Platform.OS !== 'web') return url;
  return getWebMediaProxyUrl(url) as T;
}

function cacheBustUrl(url?: string, version?: string): string | undefined {
  if (!url) return url;
  if (!version) return webImg(url);
  const join = url.includes('?') ? '&' : '?';
  return webImg(`${url}${join}v=${version}`);
}

function normalizeRemoteManifest(
  id: string,
  cfg: RemoteWorkConfig,
  manifest: RemoteWorkManifest,
): AnimeInfo | null {
  if (manifest.id && manifest.id !== id) return null;
  const fallback = cfg.fallback();
  const episodes = Array.isArray(manifest.episodes) ? manifest.episodes : [];
  const normalizedEpisodes: AnimeInfo['episodes'] = [];
  const streams = new Map<string, string>();

  for (const [idx, ep] of episodes.entries()) {
    const epId = String(ep.id || '').trim();
    const title = String(ep.title || '').trim();
    const videoUrl = absoluteMediaUrl(ep.videoUrl, cfg.base);
    if (!epId || !title || !videoUrl) continue;
    normalizedEpisodes.push({
      id: epId,
      number: Number.isFinite(ep.number) ? Number(ep.number) : idx + 1,
      title,
      thumbnail: cacheBustUrl(absoluteMediaUrl(ep.thumbnail, cfg.base), cfg.assetVersion),
    });
    streams.set(epId, videoUrl);
  }

  if (normalizedEpisodes.length === 0) return null;

  stateFor(id).streams = streams;
  return {
    ...fallback,
    title: manifest.title || fallback.title,
    image: cacheBustUrl(absoluteMediaUrl(manifest.image, cfg.base), cfg.assetVersion) || fallback.image,
    cover:
      cacheBustUrl(
        absoluteMediaUrl(manifest.cover, cfg.base) || absoluteMediaUrl(manifest.image, cfg.base),
        cfg.assetVersion,
      ) || fallback.cover,
    description: manifest.description || fallback.description,
    status: manifest.status || fallback.status,
    genres: Array.isArray(manifest.genres) && manifest.genres.length ? manifest.genres : fallback.genres,
    score: typeof manifest.score === 'number' || manifest.score === null ? manifest.score : fallback.score,
    episodes: normalizedEpisodes,
  };
}

async function fetchRemoteWorkInfo(id: string, opts?: { force?: boolean }): Promise<AnimeInfo | null> {
  const cfg = REMOTE_WORKS[id];
  if (!cfg) return null;
  const state = stateFor(id);
  const now = Date.now();
  if (!opts?.force && state.info && now - state.fetchedAt < REMOTE_WORK_TTL_MS) {
    return state.info;
  }
  if (!opts?.force && state.inflight) return state.inflight;

  state.inflight = (async () => {
    try {
      const rawUrl = `${cfg.manifestUrl}?t=${Math.floor(now / REMOTE_WORK_TTL_MS)}`;
      // Web builds can't fetch the plain-http media host from an https page —
      // route through the media proxy (same as video playback).
      const url = Platform.OS === 'web' ? getWebMediaProxyUrl(rawUrl) : rawUrl;
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`manifest returned ${res.status}`);
      const text = await res.text();
      const manifest = JSON.parse(text.replace(/^\uFEFF/, '').trim()) as RemoteWorkManifest;
      const info = normalizeRemoteManifest(id, cfg, manifest);
      if (info) {
        state.info = info;
        state.fetchedAt = Date.now();
      }
      return info;
    } catch (e) {
      console.warn(`[sakura-originals] failed to fetch ${id} manifest:`, e);
      return state.info;
    } finally {
      state.inflight = null;
    }
  })();

  return state.inflight;
}

// ─── AnimeInfo objects ────────────────────────────────────────────────────────
const PSYOP_INFO: AnimeInfo = {
  id: 'psyopanime',
  title: 'PsyopAnime: The Series',
  image: webImg(`${PSYOP_BASE}/thumbs/BnBj8sRUu6o.jpg`),
  cover: webImg(`${PSYOP_BASE}/thumbs/BnBj8sRUu6o.jpg`),
  localCover: PSYOP_COVER,
  description:
    'In a hyper-connected world where digital psyops blur the lines between reality and illusion, ' +
    'enter the enigmatic hacker collective known as PsyopAnime. Led by the sharp-witted protagonist ' +
    'Neo-Meme Master Akira, this ragtag group wages a covert war against corrupt crypto barons and ' +
    'political puppet-masters using AI-generated visuals. Packed with Easter eggs from real-world trends, ' +
    'PsyopAnime proves that in the age of information warfare, laughter is the ultimate weapon.',
  status: 'Ongoing',
  genres: ['Sci-Fi Action', 'Psychological Thriller', 'Satire'],
  score: 9.9,
  episodes: psyopEpisodes,
};

const TWO_HE_INFO: AnimeInfo = {
  id: '2heanime',
  title: '2heAnime',
  image: TWO_HE_COVER_URI,
  cover: TWO_HE_COVER_URI,
  localCover: TWO_HE_COVER,
  description:
    'A Sakura Original anthology of AI-powered anime shorts from 2heAnime, ' +
    'a 16-year-old creator building the future of anime streaming with AI.',
  status: 'Ongoing',
  genres: ['AI Anime', 'Sakura Original', 'Anthology'],
  score: 9.8,
  episodes: twoHeEpisodes,
};

const BURNIE_INFO: AnimeInfo = {
  id: 'burnie-senders',
  title: 'Burnie Senders',
  image: '',
  cover: '',
  localCover: BURNIE_COVER,
  description:
    'A new Sakura original is transmitting soon. The Burnie Senders are assembling for a meme-fueled anime drop from the edge of the chain.',
  status: 'Coming Soon',
  genres: ['Sakura Original', 'Meme Action', 'Coming Soon'],
  score: null,
  episodes: [],
  episodeLoadError: 'Burnie Senders is coming soon — stay tuned.',
};

const DEGEGEN_INFO: AnimeInfo = {
  id: 'degegen-files',
  title: 'Degegen Files',
  image: DEGEGEN_COVER_URI,
  cover: DEGEGEN_COVER_URI,
  localCover: DEGEGEN_COVER,
  description:
    'A weekly Sakura Original series following crypto culture, hype cycles, and inverse vibes from the trenches.',
  status: 'Ongoing',
  genres: ['Sakura Original', 'Crypto Satire', 'Weekly Episodes'],
  score: 9.7,
  episodes: degegenEpisodes,
};

export function getSakuraOriginalInfo(id: string): AnimeInfo | null {
  const cfg = REMOTE_WORKS[id];
  if (cfg) return stateFor(id).info ?? cfg.fallback();
  if (id === 'burnie-senders') return BURNIE_INFO;
  return null;
}

export async function fetchSakuraOriginalInfo(
  id: string,
  opts?: { force?: boolean },
): Promise<AnimeInfo | null> {
  const cfg = REMOTE_WORKS[id];
  if (cfg) {
    return (await fetchRemoteWorkInfo(id, opts)) ?? cfg.fallback();
  }
  return getSakuraOriginalInfo(id);
}

// ─── Stream URL resolver ──────────────────────────────────────────────────────
function proxyStreamUrlForWeb(url: string | null): string | null {
  if (!url) return null;
  if (Platform.OS !== 'web') return url;
  return getWebMediaProxyUrl(url);
}

export function getSakuraOriginalStreamUrl(episodeId: string): string | null {
  for (const state of remoteWorkState.values()) {
    const remoteUrl = state.streams.get(episodeId);
    if (remoteUrl) return proxyStreamUrlForWeb(remoteUrl);
  }
  if (episodeId.startsWith('psyop-')) {
    const ytId = episodeId.slice(6);
    if (!ytId) return null;
    return proxyStreamUrlForWeb(`${PSYOP_BASE}/videos/${ytId}.mp4`);
  }
  if (episodeId.startsWith('2he-')) {
    const slug = episodeId.slice(4);
    const ep = TWO_HE_EP_RAW.find(([s]) => s === slug);
    if (ep) return proxyStreamUrlForWeb(`${TWO_HE_BASE}/videos/${ep[1]}`);
  }
  if (episodeId === 'degegen-inverse-vibe') {
    return proxyStreamUrlForWeb(`${DEGEGEN_BASE}/episodes/inverse-vibe.mp4`);
  }
  if (episodeId === 'degegen-sellor') {
    return proxyStreamUrlForWeb(`${DEGEGEN_BASE}/episodes/sellor.mov`);
  }
  if (episodeId === 'degegen-z-crash') {
    return proxyStreamUrlForWeb(`${DEGEGEN_BASE}/episodes/z-crash.mov`);
  }
  return null;
}

export function getSakuraOriginalEmbedUrl(episodeId: string): string | null {
  if (episodeId.startsWith('psyop-')) {
    const ytId = episodeId.slice(6);
    if (!ytId) return null;
    return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(ytId)}?playsinline=1&autoplay=1&rel=0&modestbranding=1`;
  }
  return null;
}

const EPISODE_PREFIX_TO_WORK: Array<[string, string]> = [
  ['degegen-', 'degegen-files'],
  ['psyop-', 'psyopanime'],
  ['2he-', '2heanime'],
];

export async function resolveSakuraOriginalStreamUrl(
  episodeId: string,
  opts?: { force?: boolean },
): Promise<string | null> {
  const match = EPISODE_PREFIX_TO_WORK.find(([prefix]) => episodeId.startsWith(prefix));
  if (match) {
    await fetchRemoteWorkInfo(match[1], opts);
  }
  return getSakuraOriginalStreamUrl(episodeId);
}

// ─── Hero / card display entries ──────────────────────────────────────────────
export interface OriginalEntry {
  id: string;
  title: string;
  label: string;
  /** Require() result or { uri: string } — pass directly to expo-image source */
  localImage: any;
  score: number | null;
  comingSoon?: boolean;
  type: 'anime' | 'novel';
}

/** Supabase UUID for the HUMOR ME novel — used to fetch chapters */
export const HUMOUR_ME_NOVEL_ID = '2e395c49-5e36-4405-99a1-62b01b4e0476';

export const SAKURA_ORIGINALS: OriginalEntry[] = [
  {
    id: 'psyopanime',
    title: 'PsyopAnime: The Series',
    label: 'xAI Visions × Sakura',
    localImage: PSYOP_COVER,
    score: 9.9,
    type: 'anime',
  },
  {
    id: '2heanime',
    title: '2heAnime',
    label: '2heAnime × Sakura',
    localImage: TWO_HE_COVER,
    score: 9.8,
    type: 'anime',
  },
  {
    id: 'degegen-files',
    title: 'Degegen Files',
    label: 'Weekly · Sakura Original',
    localImage: { uri: DEGEGEN_REMOTE_COVER_URI },
    score: 9.7,
    type: 'anime',
  },
  {
    id: 'burnie-senders',
    title: 'Burnie Senders',
    label: 'Coming Soon · Sakura',
    localImage: BURNIE_COVER,
    score: null,
    comingSoon: true,
    type: 'anime',
  },
  {
    id: 'humour-me',
    title: 'Humor Me',
    label: 'Sakura Novel Original',
    localImage: { uri: 'https://i.postimg.cc/t4dpCnph/IMG-20260502-WA0012.jpg' },
    score: null,
    type: 'novel',
  },
];

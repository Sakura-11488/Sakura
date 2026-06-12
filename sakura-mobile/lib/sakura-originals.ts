import { Image as RNImage } from 'react-native';
import { type AnimeInfo } from './anime';

// ─── Media server (nip.io for iOS ATS compliance) ─────────────────────────────
const MEDIA = 'http://165-232-83-159.nip.io';
const PSYOP_BASE = `${MEDIA}/psyopanime`;
const TWO_HE_BASE = `${MEDIA}/2heanime`;
const DEGEGEN_BASE = `${MEDIA}/sakura-originals/degegen-files`;
const DEGEGEN_MANIFEST_URL = `${DEGEGEN_BASE}/manifest.json`;
const DEGEGEN_ASSET_VERSION = '20260608-3eps';

// ─── Local cover images (require() for Metro bundler) ────────────────────────
export const PSYOP_COVER = require('../assets/images/psyopanime.png');
export const BURNIE_COVER = require('../assets/images/burnie-senders-poster.png');
export const TWO_HE_COVER = require('../assets/images/2he.jpg');
export const TWO_HE_COVER_URI = `${MEDIA}/2heanime.jpg`;
export const DEGEGEN_COVER = require('../assets/images/degenfiles.jpeg');
export const DEGEGEN_EP1_THUMB = require('../assets/images/degenfiles-ep1.jpeg');
const DEGEGEN_REMOTE_COVER_URI = `${DEGEGEN_BASE}/cover.png?v=${DEGEGEN_ASSET_VERSION}`;
const DEGEGEN_COVER_URI = DEGEGEN_REMOTE_COVER_URI;
const DEGEGEN_EP1_THUMB_URI = RNImage.resolveAssetSource(DEGEGEN_EP1_THUMB).uri;

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
];

const psyopEpisodes: AnimeInfo['episodes'] = PSYOP_EP_RAW.map(([number, ytId, title]) => ({
  id: `psyop-${ytId}`,
  number,
  title,
  thumbnail: `${PSYOP_BASE}/thumbs/${ytId}.jpg`,
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
    thumbnail: `${DEGEGEN_BASE}/episodes/sellor.png?v=${DEGEGEN_ASSET_VERSION}`,
  },
  {
    id: 'degegen-z-crash',
    number: 3,
    title: 'Z-Crash',
    thumbnail: `${DEGEGEN_BASE}/episodes/z-crash.png?v=${DEGEGEN_ASSET_VERSION}`,
  },
];

type RemoteDegegenEpisode = {
  id: string;
  number?: number;
  title: string;
  thumbnail?: string;
  videoUrl: string;
};

type RemoteDegegenManifest = {
  id?: string;
  title?: string;
  description?: string;
  status?: string;
  genres?: string[];
  score?: number | null;
  image?: string;
  cover?: string;
  episodes?: RemoteDegegenEpisode[];
};

let remoteDegegenInfo: AnimeInfo | null = null;
let remoteDegegenStreams = new Map<string, string>();
let remoteDegegenFetchedAt = 0;
let remoteDegegenFetch: Promise<AnimeInfo | null> | null = null;
const REMOTE_DEGEGEN_TTL_MS = 5 * 60_000;

function absoluteMediaUrl(url?: string): string | undefined {
  if (!url) return undefined;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('/')) return `${MEDIA}${url}`;
  return `${DEGEGEN_BASE}/${url.replace(/^\/+/, '')}`;
}

function cacheBustUrl(url?: string): string | undefined {
  if (!url) return undefined;
  const join = url.includes('?') ? '&' : '?';
  return `${url}${join}v=${DEGEGEN_ASSET_VERSION}`;
}

function normalizeRemoteDegegenManifest(manifest: RemoteDegegenManifest): AnimeInfo | null {
  if (manifest.id && manifest.id !== 'degegen-files') return null;
  const episodes = Array.isArray(manifest.episodes) ? manifest.episodes : [];
  const normalizedEpisodes: AnimeInfo['episodes'] = [];
  const streams = new Map<string, string>();

  for (const [idx, ep] of episodes.entries()) {
    const id = String(ep.id || '').trim();
    const title = String(ep.title || '').trim();
    const videoUrl = absoluteMediaUrl(ep.videoUrl);
    if (!id || !title || !videoUrl) continue;
    normalizedEpisodes.push({
      id,
      number: Number.isFinite(ep.number) ? Number(ep.number) : idx + 1,
      title,
      thumbnail: cacheBustUrl(absoluteMediaUrl(ep.thumbnail)),
    });
    streams.set(id, videoUrl);
  }

  if (normalizedEpisodes.length === 0) return null;

  remoteDegegenStreams = streams;
  return {
    ...DEGEGEN_INFO,
    title: manifest.title || DEGEGEN_INFO.title,
    image: cacheBustUrl(absoluteMediaUrl(manifest.image)) || DEGEGEN_INFO.image,
    cover: cacheBustUrl(absoluteMediaUrl(manifest.cover) || absoluteMediaUrl(manifest.image)) || DEGEGEN_INFO.cover,
    description: manifest.description || DEGEGEN_INFO.description,
    status: manifest.status || DEGEGEN_INFO.status,
    genres: Array.isArray(manifest.genres) && manifest.genres.length ? manifest.genres : DEGEGEN_INFO.genres,
    score: typeof manifest.score === 'number' || manifest.score === null ? manifest.score : DEGEGEN_INFO.score,
    episodes: normalizedEpisodes,
  };
}

async function fetchRemoteDegegenInfo(opts?: { force?: boolean }): Promise<AnimeInfo | null> {
  const now = Date.now();
  if (!opts?.force && remoteDegegenInfo && now - remoteDegegenFetchedAt < REMOTE_DEGEGEN_TTL_MS) {
    return remoteDegegenInfo;
  }
  if (!opts?.force && remoteDegegenFetch) return remoteDegegenFetch;

  remoteDegegenFetch = (async () => {
    try {
      const res = await fetch(`${DEGEGEN_MANIFEST_URL}?t=${Math.floor(now / REMOTE_DEGEGEN_TTL_MS)}`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`Degegen manifest returned ${res.status}`);
      const text = await res.text();
      const manifest = JSON.parse(text.replace(/^\uFEFF/, '').trim()) as RemoteDegegenManifest;
      const info = normalizeRemoteDegegenManifest(manifest);
      if (info) {
        remoteDegegenInfo = info;
        remoteDegegenFetchedAt = Date.now();
      }
      return info;
    } catch (e) {
      console.warn('[sakura-originals] failed to fetch Degegen manifest:', e);
      return remoteDegegenInfo;
    } finally {
      remoteDegegenFetch = null;
    }
  })();

  return remoteDegegenFetch;
}

// ─── AnimeInfo objects ────────────────────────────────────────────────────────
const PSYOP_INFO: AnimeInfo = {
  id: 'psyopanime',
  title: 'PsyopAnime: The Series',
  image: `${PSYOP_BASE}/thumbs/BnBj8sRUu6o.jpg`,
  cover: `${PSYOP_BASE}/thumbs/BnBj8sRUu6o.jpg`,
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
  if (id === 'psyopanime') return PSYOP_INFO;
  if (id === '2heanime') return TWO_HE_INFO;
  if (id === 'burnie-senders') return BURNIE_INFO;
  if (id === 'degegen-files') return remoteDegegenInfo ?? DEGEGEN_INFO;
  return null;
}

export async function fetchSakuraOriginalInfo(
  id: string,
  opts?: { force?: boolean },
): Promise<AnimeInfo | null> {
  if (id === 'degegen-files') {
    return (await fetchRemoteDegegenInfo(opts)) ?? DEGEGEN_INFO;
  }
  return getSakuraOriginalInfo(id);
}

// ─── Stream URL resolver ──────────────────────────────────────────────────────
export function getSakuraOriginalStreamUrl(episodeId: string): string | null {
  const remoteUrl = remoteDegegenStreams.get(episodeId);
  if (remoteUrl) return remoteUrl;
  if (episodeId.startsWith('psyop-')) {
    const ytId = episodeId.slice(6);
    if (!ytId) return null;
    return `${PSYOP_BASE}/videos/${ytId}.mp4`;
  }
  if (episodeId.startsWith('2he-')) {
    const slug = episodeId.slice(4);
    const ep = TWO_HE_EP_RAW.find(([s]) => s === slug);
    if (ep) return `${TWO_HE_BASE}/videos/${ep[1]}`;
  }
  if (episodeId === 'degegen-inverse-vibe') {
    return `${DEGEGEN_BASE}/episodes/inverse-vibe.mp4`;
  }
  if (episodeId === 'degegen-sellor') {
    return `${DEGEGEN_BASE}/episodes/sellor.mov`;
  }
  if (episodeId === 'degegen-z-crash') {
    return `${DEGEGEN_BASE}/episodes/z-crash.mov`;
  }
  return null;
}

export async function resolveSakuraOriginalStreamUrl(
  episodeId: string,
  opts?: { force?: boolean },
): Promise<string | null> {
  if (episodeId.startsWith('degegen-')) {
    await fetchRemoteDegegenInfo(opts);
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

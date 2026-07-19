import { MAPPA_ANIME_STYLE_LOCK, sanitizeUserHint } from './mappa-style.ts';

/** Sibling style locks — share the MAPPA vocabulary but swap the medium. */
const WATERCOLOR_LOCK = [
  'soft anime watercolor illustration',
  'delicate ink linework with flowing washes',
  'pastel palette, gentle gradients, paper texture',
  'dreamy diffuse lighting',
  'sakura pink accent highlights',
  'original character design only',
  'no text',
  'no watermark',
  'no photorealism',
].join(', ');

const RETRO_90S_LOCK = [
  '1990s retro anime cel illustration',
  'vintage OVA aesthetic, film grain, muted saturated colors',
  'hand-painted backgrounds, classic cel shading',
  'nostalgic golden-hour lighting',
  'original character design only',
  'no text',
  'no watermark',
  'no photorealism',
].join(', ');

const CHIBI_LOCK = [
  'cute chibi anime style',
  'super-deformed proportions, big expressive eyes, tiny body',
  'clean bold outlines, bright cheerful colors, soft shading',
  'sticker-like poster composition',
  'sakura pink accents',
  'original character design only',
  'no text',
  'no watermark',
  'no photorealism',
].join(', ');

export const STYLE_PRESETS: Record<string, string> = {
  mappa: MAPPA_ANIME_STYLE_LOCK,
  watercolor: WATERCOLOR_LOCK,
  retro90s: RETRO_90S_LOCK,
  chibi: CHIBI_LOCK,
};

const SAFE_TAIL =
  'original fan interpretation not an exact copy, all characters depicted as adults, no real people, no photorealism, no logos, no text, no watermark';

/** Server allowlist for the series/character slots (client mirrors this list). */
export const FAN_ART_SERIES = [
  'Jujutsu Kaisen', 'Naruto', 'One Piece', 'Bleach', 'Demon Slayer', 'Attack on Titan',
  'My Hero Academia', 'Chainsaw Man', 'Dragon Ball', 'Spy x Family', 'Tokyo Ghoul',
  'Hunter x Hunter', 'Death Note', 'Fullmetal Alchemist', 'Solo Leveling', 'Berserk',
  'One Punch Man', 'Sailor Moon', 'Cowboy Bebop', 'Vinland Saga', 'Blue Lock',
  'Frieren', 'Dandadan', 'Sakura Originals',
];

function isAllowedSeries(s: string): boolean {
  const norm = s.trim().toLowerCase();
  return FAN_ART_SERIES.some((x) => x.toLowerCase() === norm);
}

export interface FanArtInput {
  subjectType: 'series' | 'character' | 'free';
  series?: string;
  character?: string;
  freeText?: string;
  stylePreset?: string;
}

/**
 * Builds a safe, style-locked fan-art prompt. Series/character must come from
 * the curated allowlist (so a real person can't be smuggled into "character"),
 * and every free-text field runs through the shared BLOCKED_HINT_RE sanitizer.
 * Throws on invalid/blocked input (caller rejects BEFORE taking payment).
 */
export function buildFanArtPrompt(input: FanArtInput): string {
  const style = STYLE_PRESETS[input.stylePreset ?? 'mappa'] ?? MAPPA_ANIME_STYLE_LOCK;
  let subject: string;

  if (input.subjectType === 'character') {
    const series = String(input.series ?? '').trim();
    if (!isAllowedSeries(series)) throw new Error('Pick a series from the list.');
    const character = sanitizeUserHint(input.character, 60);
    if (!character) throw new Error('Enter a character name.');
    subject = `fan-art of an original interpretation of ${character} from ${series}, single dynamic character portrait`;
  } else if (input.subjectType === 'series') {
    const series = String(input.series ?? '').trim();
    if (!isAllowedSeries(series)) throw new Error('Pick a series from the list.');
    subject = `fan-art inspired by the world of ${series}, an original character in that universe, dynamic portrait`;
  } else {
    const free = sanitizeUserHint(input.freeText, 200);
    if (!free) throw new Error('Enter a prompt.');
    subject = free;
  }

  return `${subject}, ${style}, ${SAFE_TAIL}`;
}

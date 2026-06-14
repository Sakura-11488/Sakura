/** Locked visual direction — always MAPPA / modern dark-shonen anime (JJK-adjacent). */
export const MAPPA_ANIME_STYLE_LOCK = [
  'MAPPA studio anime key visual',
  'Jujutsu Kaisen production aesthetic',
  'bold ink outlines and crisp cel shading',
  'dramatic cinematic lighting with deep contrast shadows',
  'vivid saturated colors and dynamic poster composition',
  'sharp detailed anime eyes and expressive face',
  'modern seinen action anime illustration',
  'cinematic depth of field',
  'sakura pink accent highlights',
  'original character design only',
  'no text',
  'no watermark',
  'no photorealism',
  'no western cartoon style',
].join(', ');

const BLOCKED_HINT_RE =
  /\b(nude|naked|nsfw|porn|sex|child|minor|loli|hitler|nazi|terrorist|celebrity|real person|photo of)\b/i;

export function sanitizeUserHint(raw: unknown, maxLen = 80): string {
  const text = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!text) return '';
  if (text.length > maxLen) throw new Error(`Hint must be ${maxLen} characters or fewer.`);
  if (BLOCKED_HINT_RE.test(text)) throw new Error('That hint is not allowed.');
  return text;
}

export interface TasteSnapshot {
  top_genres: string[];
  top_titles: string[];
  content_mix: string[];
  vibe: string;
}

export function buildAvatarPrompt(input: {
  mode: 'tastes' | 'general';
  taste: TasteSnapshot;
  userHint?: string;
}): string {
  const subject =
    input.mode === 'tastes' && (input.taste.top_titles.length || input.taste.top_genres.length)
      ? [
          'single anime character portrait waist-up',
          `energy inspired by viewer favorites: ${input.taste.top_titles.slice(0, 5).join(', ') || 'Sakura originals'}`,
          `genre mood: ${input.taste.top_genres.slice(0, 4).join(', ') || 'action, supernatural'}`,
          `overall vibe: ${input.taste.vibe}`,
          input.taste.content_mix.length
            ? `they mostly enjoy ${input.taste.content_mix.slice(0, 3).join(' and ')}`
            : '',
        ]
          .filter(Boolean)
          .join(', ')
      : 'single original anime character portrait waist-up, confident Sakura reader persona, mysterious cool expression';

  const hint = input.userHint ? `, personal detail: ${input.userHint}` : '';

  return `${subject}${hint}, ${MAPPA_ANIME_STYLE_LOCK}`;
}

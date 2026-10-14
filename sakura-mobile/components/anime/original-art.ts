import { DEGEGEN_COVER, type OriginalEntry } from '@/lib/sakura-originals';

/**
 * Artwork for a Sakura Original's spotlight and cards.
 *
 * Degegen Files' list entry points at the remote cover.png, a 2.3 MB original
 * that the Anime tab downloaded on every cold visit — the single heaviest
 * request on the page, taking 3.5–4.6 s on a phone connection. The same art is
 * bundled (assets/images/degenfiles.jpeg; on web the build serves a 960 px
 * WebP of ~170 KB), so the bundled copy is used instead.
 */
export function originalArtwork(entry: OriginalEntry): OriginalEntry['localImage'] {
  return entry.id === 'degegen-files' ? DEGEGEN_COVER : entry.localImage;
}

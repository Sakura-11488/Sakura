/** Catalogue thumbnails only. Reader pages keep their full-resolution URLs. */
export function coverThumbnailUrl(source: string, width: 256 | 512 = 256): string {
  try {
    let image = new URL(source, 'https://sakuraonseeker.com');
    if (image.protocol !== 'https:' || image.username || image.password || image.port) return source;
    // Unwrap the existing same-origin cover route, never an arbitrary proxy.
    if (image.hostname === 'sakuraonseeker.com' && image.pathname.replace(/\/$/, '') === '/api/media-proxy') {
      if (image.searchParams.getAll('path').length !== 1 || [...image.searchParams.keys()].some(key => key !== 'path')) return source;
      const path = new URL(image.searchParams.get('path') || '', 'https://sakuraonseeker.com');
      if (path.origin !== 'https://sakuraonseeker.com') return source;
      if (path.pathname === '/manhwa/v1/img') image = new URL(path.searchParams.get('u') || '');
      else image = new URL(path.pathname + path.search, 'https://165-232-83-159.nip.io');
    }
    if (image.protocol !== 'https:' || image.username || image.password || image.port) return source;
    const atsu = ['atsu.moe', 'cdn.atsu.moe'].includes(image.hostname) && image.pathname.startsWith('/static/posters/');
    const manhwa = image.hostname === 'www.mangaread.org' && image.pathname.startsWith('/wp-content/uploads/');
    const raster = '(?:avif|webp|png|jpe?g|gif)';
    const editorial = image.hostname === 'sakuraonseeker.com' && new RegExp(`^/creator-covers/editorial-\\d{4}-\\d{2}-\\d{2}/[A-Za-z0-9_-]+\\.${raster}$`, 'i').test(image.pathname);
    const creator = image.hostname === 'aofzomovaozcwcozokll.supabase.co' && new RegExp(`^/storage/v1/object/public/creator-covers/[1-9A-HJ-NP-Za-km-z]{32,44}/[0-9a-f-]{36}/work/[A-Za-z0-9_.-]+\\.${raster}$`, 'i').test(image.pathname);
    const original = image.hostname === '165-232-83-159.nip.io' && (
      /^\/sakura-originals\/[a-z0-9][a-z0-9-]*\/(?:cover|[A-Za-z0-9_-]+-thumb)\.(?:png|jpe?g)$/i.test(image.pathname) ||
      /^\/(?:psyopanime|2heanime)\/thumbs\/[A-Za-z0-9_-]+\.(?:png|jpe?g)$/i.test(image.pathname)
    );
    if (!atsu && !manhwa && !editorial && !creator && !original) return source;
    if (image.hash || (image.search && (!original || !/^\?(?:v|t)=[A-Za-z0-9._-]{1,64}$/.test(image.search)))) return source;
    // This is the CDN advertised by ATSU's public poster redirect.
    if (atsu) image.hostname = 'cdn.atsu.moe';
    return `/api/cover-image/?${new URLSearchParams({ url: image.href, width: String(width) })}`;
  } catch {
    return source;
  }
}

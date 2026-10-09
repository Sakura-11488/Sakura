/** Catalogue thumbnails only. Reader pages keep their full-resolution URLs. */
export function coverThumbnailUrl(source: string, width: 256 | 512 = 256): string {
  try {
    let image = new URL(source, 'https://sakuraonseeker.com');
    // Unwrap the existing same-origin cover route, never an arbitrary proxy.
    if (image.pathname.replace(/\/$/, '') === '/api/media-proxy') {
      const path = new URL(image.searchParams.get('path') || '', 'https://sakuraonseeker.com');
      if (path.pathname !== '/manhwa/v1/img') return source;
      image = new URL(path.searchParams.get('u') || '');
    }
    if (image.protocol !== 'https:' || image.username || image.password || image.port) return source;
    const atsu = ['atsu.moe', 'cdn.atsu.moe'].includes(image.hostname) && image.pathname.startsWith('/static/posters/');
    const manhwa = image.hostname === 'www.mangaread.org' && image.pathname.startsWith('/wp-content/uploads/');
    if (!atsu && !manhwa) return source;
    // This is the CDN advertised by ATSU's public poster redirect.
    if (atsu) image.hostname = 'cdn.atsu.moe';
    return `/api/cover-image/?${new URLSearchParams({ url: image.href, width: String(width) })}`;
  } catch {
    return source;
  }
}

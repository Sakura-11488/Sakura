/** Serve public ATSU pages from Sakura so browser cross-site image rules apply correctly. */
export function readerImageUrl(source: string): string {
  try {
    const image = new URL(source);
    if (image.protocol !== 'https:' || image.hostname !== 'cdn.atsu.moe' ||
      image.username || image.password || image.port || image.search || image.hash ||
      !/^\/static\/pages\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/\d+\.(?:webp|jpe?g|png|avif|gif)$/i.test(image.pathname)) return source;
    return `/api/reader-image/?${new URLSearchParams({ url: image.href })}`;
  } catch {
    return source;
  }
}

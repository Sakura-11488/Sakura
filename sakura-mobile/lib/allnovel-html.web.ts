import { invokeContentProxy } from '@/lib/content-proxy-client';

const NOVEL_UA =
  'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

function pathFromNovelUrl(url: string): string {
  if (url.startsWith('http')) {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  }
  return url.startsWith('/') ? url : `/${url}`;
}

export async function fetchNovelHtml(url: string): Promise<string> {
  const path = pathFromNovelUrl(url);
  const data = await invokeContentProxy<{ html: string }>({
    source: 'novel',
    path,
    headers: { 'User-Agent': NOVEL_UA },
  });
  if (!data?.html) throw new Error('Novel proxy returned empty HTML.');
  return data.html;
}

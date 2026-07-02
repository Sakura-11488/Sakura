const NOVEL_UA =
  'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

export async function fetchNovelHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': NOVEL_UA },
  });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  return res.text();
}

import { useEffect } from 'react';

type ImgWithMarker = HTMLImageElement & {
  __sakuraShimmedUrl?: string;
};

/** Rewrites http:// comic images to blob URLs so HTTPS web pages can display them. */
export default function HttpImageShim() {
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const blobCache = new Map<string, string>();
    const inflight = new Map<string, Promise<string>>();

    const shouldProxy = (src: string | null | undefined): src is string => {
      if (!src) return false;
      return src.startsWith('http://');
    };

    const resolveBlob = (url: string): Promise<string> => {
      const cached = blobCache.get(url);
      if (cached) return Promise.resolve(cached);
      const existing = inflight.get(url);
      if (existing) return existing;
      const pending = fetch(url, { credentials: 'omit', cache: 'force-cache' })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.blob();
        })
        .then((blob) => {
          const blobUrl = URL.createObjectURL(blob);
          blobCache.set(url, blobUrl);
          return blobUrl;
        })
        .finally(() => {
          inflight.delete(url);
        });
      inflight.set(url, pending);
      return pending;
    };

    const rewrite = (img: ImgWithMarker) => {
      const src = img.getAttribute('src');
      if (!shouldProxy(src)) return;
      if (img.__sakuraShimmedUrl === src) return;
      img.__sakuraShimmedUrl = src;
      resolveBlob(src)
        .then((blobUrl) => {
          if (img.__sakuraShimmedUrl !== src) return;
          if (img.src !== blobUrl) img.src = blobUrl;
        })
        .catch(() => {
          img.__sakuraShimmedUrl = undefined;
        });
    };

    const scanRoot = (root: ParentNode) => {
      root.querySelectorAll('img').forEach((el) => rewrite(el as ImgWithMarker));
    };

    scanRoot(document);

    const observer = new MutationObserver((mutations) => {
      for (const mut of mutations) {
        if (mut.type === 'attributes' && mut.target instanceof HTMLImageElement) {
          rewrite(mut.target as ImgWithMarker);
          continue;
        }
        if (mut.type === 'childList') {
          mut.addedNodes.forEach((node) => {
            if (node instanceof HTMLImageElement) rewrite(node as ImgWithMarker);
            else if (node instanceof Element) scanRoot(node);
          });
        }
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src'],
    });

    return () => {
      observer.disconnect();
      blobCache.forEach((blobUrl) => {
        try {
          URL.revokeObjectURL(blobUrl);
        } catch {
          // ignore
        }
      });
      blobCache.clear();
      inflight.clear();
    };
  }, []);

  return null;
}

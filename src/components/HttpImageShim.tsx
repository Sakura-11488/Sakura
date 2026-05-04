"use client";

import { useEffect } from "react";

// In the native Android shell, the app is served from the
// Capacitor-internal `https://sakura.milla.so` virtual origin. Any resource
// referenced over plain `http://` (e.g. the DigitalOcean droplet that hosts
// the comics scraper + image proxy) is blocked silently for <img> subresources
// by modern Chromium WebView, even with
// `WebSettings.setMixedContentMode(MIXED_CONTENT_ALWAYS_ALLOW)`. The
// same-URL `fetch()` call does work, however, which gives us a way out:
// intercept every <img> whose `src` is `http://`, fetch the bytes through
// `fetch()`, and swap the tag over to a `blob:` URL the WebView is happy to
// render.
//
// The shim is self-healing: it watches for new <img> elements (Next.js
// streaming, client-side navigation, dynamic lists) and for `src`
// attribute changes on existing elements. Successful fetches are cached so
// the same upstream URL is only downloaded once per session.

type ImgWithMarker = HTMLImageElement & {
  __sakuraShimmedUrl?: string;
};

export default function HttpImageShim() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    const blobCache = new Map<string, string>();
    const inflight = new Map<string, Promise<string>>();

    const shouldProxy = (src: string | null | undefined): src is string => {
      if (!src) return false;
      return src.startsWith("http://");
    };

    const resolveBlob = (url: string): Promise<string> => {
      const cached = blobCache.get(url);
      if (cached) return Promise.resolve(cached);
      const existing = inflight.get(url);
      if (existing) return existing;
      const pending = fetch(url, { credentials: "omit", cache: "force-cache" })
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
      const src = img.getAttribute("src");
      if (!shouldProxy(src)) return;
      if (img.__sakuraShimmedUrl === src) return;
      img.__sakuraShimmedUrl = src;
      resolveBlob(src)
        .then((blobUrl) => {
          if (img.__sakuraShimmedUrl !== src) return;
          if (img.src !== blobUrl) {
            img.src = blobUrl;
          }
        })
        .catch(() => {
          img.__sakuraShimmedUrl = undefined;
        });
    };

    const scanRoot = (root: ParentNode) => {
      const imgs = root.querySelectorAll("img");
      imgs.forEach((el) => rewrite(el as ImgWithMarker));
    };

    scanRoot(document);

    const observer = new MutationObserver((mutations) => {
      for (const mut of mutations) {
        if (mut.type === "attributes" && mut.target instanceof HTMLImageElement) {
          rewrite(mut.target as ImgWithMarker);
          continue;
        }
        if (mut.type === "childList") {
          mut.addedNodes.forEach((node) => {
            if (node instanceof HTMLImageElement) {
              rewrite(node as ImgWithMarker);
            } else if (node instanceof Element) {
              scanRoot(node);
            }
          });
        }
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src"],
    });

    return () => {
      observer.disconnect();
      blobCache.forEach((blobUrl) => {
        try {
          URL.revokeObjectURL(blobUrl);
        } catch {
        }
      });
      blobCache.clear();
      inflight.clear();
    };
  }, []);

  return null;
}

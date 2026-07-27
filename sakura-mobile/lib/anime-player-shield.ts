const BLOCKED_HOST_RE =
  /(?:^|[.-])(?:1xbet|melbet|betwinner|mostbet|parimatch|pinup|pin-up|glorycasino|stake|bet365|betway|22bet|linebet|1win|vulkanvegas|izzi|adsterra|propellerads|exoclick|popads|clickaine|trafficjunky|outbrain|taboola|mgid|revcontent|adnxs|doubleclick|googlesyndication|popcash|hilltopads|richads|clickadu|adcash|monetag|statlytic|histats|onclickA|onclckads|adsco|admaven|galaksion|adservme|zeydoo|bidgear|adprofex|luckyads|coinzilla)(?:[.-]|$)/i;

const BLOCKED_PATH_RE = /(?:^|[/?&])(?:affiliate|affid|promo|redirect|click|track)(?:[/?&]|$)/i;

const STREAM_HOST_RE =
  /(?:^|[.-])(?:hianime|megaplay|megacloud|vidcloud|rabbitstream|streamsb|streamtape|gogoplay|animepahe|m3u8|cdn|mewstream|noitatnemucod|api-hianime|jsdelivr|jquery)(?:[.-]|$)/i;

function parseHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function sameOrigin(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin === ub.origin;
  } catch {
    return false;
  }
}

export function isBlockedAnimePlayerUrl(url: string): boolean {
  if (!url || url === 'about:blank') return false;
  const lower = url.toLowerCase();
  if (lower.startsWith('data:') || lower.startsWith('blob:')) return false;

  const host = parseHost(url);
  if (!host) return false;

  if (BLOCKED_HOST_RE.test(host)) return true;
  if (BLOCKED_PATH_RE.test(lower) && !STREAM_HOST_RE.test(host)) return true;

  return false;
}

export function shouldAllowAnimePlayerNavigation(
  url: string,
  embedUrl: string | null | undefined,
  isMainFrame = true,
): boolean {
  if (!url || url === 'about:blank') return true;
  if (isBlockedAnimePlayerUrl(url)) return false;

  const lower = url.toLowerCase();
  if (lower.startsWith('data:') || lower.startsWith('blob:')) return true;
  if (/\.(m3u8|mp4|webm|ts)(\?|$)/i.test(url)) return true;

  const host = parseHost(url);
  if (host && STREAM_HOST_RE.test(host)) return true;

  if (!isMainFrame) return true;

  if (!embedUrl) return true;
  if (sameOrigin(url, embedUrl)) return true;

  const embedHost = parseHost(embedUrl);
  if (host && embedHost) {
    if (host === embedHost || host.endsWith('.' + embedHost) || embedHost.endsWith('.' + host)) {
      return true;
    }
  }

  return false;
}

export function buildAnimePlayerShieldScript(): string {
  return `
    (function() {
      if (window.__sakuraPlayerShield) return;
      window.__sakuraPlayerShield = true;

      var blockedRe = ${BLOCKED_HOST_RE.toString()};
      var streamRe = ${STREAM_HOST_RE.toString()};

      function isBlocked(url) {
        if (!url) return false;
        var lower = String(url).toLowerCase();
        if (lower.indexOf('about:blank') === 0 || lower.indexOf('blob:') === 0 || lower.indexOf('data:') === 0) {
          return false;
        }
        try {
          var host = new URL(url, window.location.href).hostname.toLowerCase();
          if (blockedRe.test(host)) return true;
        } catch (e) {}
        return false;
      }

      function isStream(url) {
        if (!url) return false;
        try {
          return streamRe.test(new URL(url, window.location.href).hostname.toLowerCase());
        } catch (e) {
          return false;
        }
      }

      window.open = function() { return null; };

      document.addEventListener('click', function(e) {
        var el = e.target;
        while (el) {
          if (el.tagName === 'A' && el.href && isBlocked(el.href)) {
            e.preventDefault();
            e.stopImmediatePropagation();
            return false;
          }
          el = el.parentElement;
        }
      }, true);

      function hasVideo(node) {
        if (!node || !node.querySelector) return false;
        return !!node.querySelector('video');
      }

      function scrub(root) {
        if (!root || !root.querySelectorAll) return;

        // ALLOWLIST, not a denylist. Any nested frame that is not the stream
        // itself or same-origin with the player is removed, whether or not
        // anybody has catalogued it. A denylist only blocks the ad networks
        // somebody already knew about, and these players rotate hosts weekly --
        // which is why ads kept appearing despite a list that looked thorough.
        root.querySelectorAll('iframe').forEach(function(frame) {
          var raw = frame.src || frame.getAttribute('src') || '';
          if (!raw || raw.indexOf('about:blank') === 0 || raw.indexOf('blob:') === 0 || raw.indexOf('data:') === 0) {
            return;
          }
          if (isStream(raw)) return;
          try {
            if (new URL(raw, window.location.href).origin === window.location.origin) return;
          } catch (e) {}
          frame.remove();
        });

        root.querySelectorAll('a[href], [onclick]').forEach(function(el) {
          var href = el.href || el.getAttribute('href') || '';
          if (isBlocked(href)) {
            el.removeAttribute('href');
            el.removeAttribute('onclick');
            el.style.display = 'none';
            el.style.pointerEvents = 'none';
          }
        });

        root.querySelectorAll('div, section, aside, a, span').forEach(function(el) {
          if (hasVideo(el)) return;
          var style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return;
          var z = parseInt(style.zIndex, 10);
          if (!z || z < 100) return;
          if (style.position !== 'fixed' && style.position !== 'absolute') return;
          var rect = el.getBoundingClientRect();
          if (rect.width < 80 || rect.height < 80) return;
          var coversCenter =
            rect.left <= window.innerWidth * 0.35 &&
            rect.right >= window.innerWidth * 0.65 &&
            rect.top <= window.innerHeight * 0.35 &&
            rect.bottom >= window.innerHeight * 0.65;
          if (coversCenter) {
            el.style.pointerEvents = 'none';
            el.style.display = 'none';
          }
        });
      }

      function run() {
        try { scrub(document); } catch (e) {}
        try { scrubDuplicateCaptions(document); } catch (e) {}
      }

      function scrubDuplicateCaptions(root) {
        if (!root || !root.querySelectorAll) return;
        var captionSelectors = [
          '.vjs-text-track-display',
          '.plyr__captions',
          '.jw-text-track-container',
          '.subtitle-container',
          '.captions',
          '[class*="subtitle"]',
          '[class*="caption"]',
        ];
        var nodes = [];
        captionSelectors.forEach(function(sel) {
          root.querySelectorAll(sel).forEach(function(el) {
            if (nodes.indexOf(el) === -1) nodes.push(el);
          });
        });
        if (nodes.length < 2) return;

        var visible = nodes.filter(function(el) {
          var style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
          var rect = el.getBoundingClientRect();
          return rect.width > 40 && rect.height > 8;
        });
        if (visible.length < 2) return;

        visible.sort(function(a, b) {
          var ra = a.getBoundingClientRect();
          var rb = b.getBoundingClientRect();
          return (rb.width * rb.height) - (ra.width * ra.height);
        });

        for (var i = 1; i < visible.length; i++) {
          visible[i].style.display = 'none';
          visible[i].style.visibility = 'hidden';
          visible[i].style.pointerEvents = 'none';
        }
      }

      run();
      setInterval(run, 1200);
      try {
        new MutationObserver(run).observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['style', 'class', 'src', 'href']
        });
      } catch (e) {}
    })();
    true;
  `;
}

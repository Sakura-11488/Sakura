import type { EmbedBridgeJob } from '@/lib/anime-download-bridge';

/** Injected into the embed WebView to read cookies and fetch playlists. */
export function buildEmbedBridgeInject(job: EmbedBridgeJob): string {
  const referer = JSON.stringify(job.referer || '');
  const reqId = JSON.stringify(job.id);
  const mode = job.mode || 'fetch';
  const target = job.targetUrl ? JSON.stringify(job.targetUrl) : 'null';

  if (mode === 'document') {
    return `
      (function() {
        var reqId = ${reqId};
        var referer = ${referer};
        var playlistUrl = ${JSON.stringify(job.embedUrl || '')};
        function send(payload) {
          if (window.ReactNativeWebView) {
            window.ReactNativeWebView.postMessage(JSON.stringify(payload));
          }
        }
        function hdrs() {
          var h = { Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, */*' };
          if (referer) h.Referer = referer;
          return h;
        }
        function finish(text) {
          text = (text || '').trim();
          var ok = text.indexOf('#EXTM3U') !== -1 || text.indexOf('#EXTINF') !== -1;
          send({
            id: reqId,
            type: 'fetch',
            ok: ok,
            text: text,
            error: ok ? '' : 'Playlist not readable in WebView'
          });
        }
        function xhrGet(targetUrl, cb) {
          try {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', targetUrl, true);
            xhr.withCredentials = true;
            var h = hdrs();
            for (var k in h) {
              if (Object.prototype.hasOwnProperty.call(h, k)) {
                xhr.setRequestHeader(k, h[k]);
              }
            }
            xhr.onload = function() {
              if (xhr.status >= 200 && xhr.status < 300) cb(xhr.responseText || '');
              else cb('');
            };
            xhr.onerror = function() { cb(''); };
            xhr.send();
          } catch (e) {
            cb('');
          }
        }
        send({ id: reqId, type: 'cookies', cookies: document.cookie || '' });
        var urls = [];
        if (playlistUrl) urls.push(playlistUrl);
        if (window.location.href && window.location.href.indexOf('http') === 0) {
          urls.push(window.location.href);
        }
        (function tryNext(i) {
          if (i >= urls.length) {
            finish('');
            return;
          }
          var u = urls[i];
          fetch(u, { credentials: 'include', headers: hdrs() })
            .then(function(res) {
              return res.text().then(function(text) {
                if (res.ok && (text.indexOf('#EXTM3U') !== -1 || text.indexOf('#EXTINF') !== -1)) {
                  finish(text);
                } else {
                  xhrGet(u, function(xhrText) {
                    if (xhrText && (xhrText.indexOf('#EXTM3U') !== -1 || xhrText.indexOf('#EXTINF') !== -1)) {
                      finish(xhrText);
                    } else {
                      tryNext(i + 1);
                    }
                  });
                }
              });
            })
            .catch(function() {
              xhrGet(u, function(xhrText) {
                if (xhrText && (xhrText.indexOf('#EXTM3U') !== -1 || xhrText.indexOf('#EXTINF') !== -1)) {
                  finish(xhrText);
                } else {
                  tryNext(i + 1);
                }
              });
            });
        })(0);
      })();
      true;
    `;
  }

  if (mode === 'cookies') {
    return `
      (function() {
        var reqId = ${reqId};
        if (window.ReactNativeWebView) {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            id: reqId,
            type: 'cookies',
            cookies: document.cookie || ''
          }));
        }
      })();
      true;
    `;
  }

  return `
    (function() {
      var reqId = ${reqId};
      var url = ${target};
      var referer = ${referer};
      function send(payload) {
        if (window.ReactNativeWebView) {
          window.ReactNativeWebView.postMessage(JSON.stringify(payload));
        }
      }
      function hdrs() {
        var h = { Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, */*' };
        if (referer) h.Referer = referer;
        return h;
      }
      function fail(msg) {
        send({ id: reqId, type: 'fetch', ok: false, text: '', error: msg || 'Stream blocked' });
      }
      send({ id: reqId, type: 'cookies', cookies: document.cookie || '' });
      if (!url) return;
      fetch(url, { credentials: 'include', headers: hdrs() })
        .then(function(res) {
          return res.text().then(function(text) {
            send({ id: reqId, type: 'fetch', ok: res.ok, text: text, error: res.ok ? '' : 'HTTP ' + res.status });
          });
        })
        .catch(function() {
          fail('Cross-origin stream fetch blocked');
        });
    })();
    true;
  `;
}

export function embedBridgeInjectDelays(mode?: EmbedBridgeJob['mode']): number[] {
  if (mode === 'document') return [800, 2200, 4500, 7000, 10000];
  return [600, 1800, 3500, 5500];
}

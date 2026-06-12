export function buildAnimeMediaSessionScript(showTitle: string, episodeTitle: string): string {
  const title = JSON.stringify(showTitle || 'Anime');
  const episode = JSON.stringify(episodeTitle || 'Episode');

  return `
    (function() {
      var showTitle = ${title};
      var episodeTitle = ${episode};
      function apply() {
        try {
          document.title = showTitle + ' · Sakura';
          if (navigator.mediaSession) {
            navigator.mediaSession.metadata = new MediaMetadata({
              title: showTitle,
              artist: 'Sakura',
              album: episodeTitle,
            });
          }
        } catch (e) {}
      }
      apply();
      setInterval(apply, 2500);
    })();
    true;
  `;
}

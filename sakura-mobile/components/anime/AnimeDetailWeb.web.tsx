import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Image } from 'expo-image';
import { CAN_SAVE_ANIME_VIDEO } from '@/lib/anime-device-save';
import { WATCHLIST_STATUSES, type WatchlistStatus } from '@/lib/anime-watchlist';
import type { AnimeEpisode } from '@/lib/anime';
import { canResumeWatchProgress, getEpisodeWatchProgress, isEpisodeWatched, isWatchProgressComplete, resumePosition } from '@/lib/watch-progress';
import AnimeDiscoveryPanels from './AnimeDiscoveryPanels';
import type { AnimeDetailWebProps, AnimeDetailWebPlaceholderProps } from './AnimeDetailWeb';
import './anime-detail.web.css';

const PAGE_SIZE = 24;

function clock(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

function Icon({ name, size = 18 }: { name: 'play' | 'back' | 'save' | 'check' | 'share' | 'download' | 'search' | 'restart' | 'pause'; size?: number }) {
  const paths = {
    play: 'm8 5 11 7-11 7V5Z', back: 'm14 6-6 6 6 6',
    save: 'M6 4h12v17l-6-4-6 4V4Z', check: 'm5 12 4 4L19 6',
    share: 'M12 16V3m-4 4 4-4 4 4M5 13v7h14v-7',
    download: 'M12 3v12m-4-4 4 4 4-4M5 17v4h14v-4',
    search: 'm16 16 5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
    restart: 'M3 10a9 9 0 1 1 2 8M3 4v6h6',
    pause: 'M9 7v10M15 7v10',
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill={name === 'play' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

export function AnimeDetailWebPlaceholder({ onBack, error, onRetry }: AnimeDetailWebPlaceholderProps) {
  return <main className="sakura-detail"><div className="sd-shell">
    <nav className="sd-nav"><button className="sd-back" onClick={onBack} aria-label="Go back"><Icon name="back" />Back</button><span className="sd-brand">Sakura <span>Anime</span></span><span /></nav>
    {error ? <div className="sd-error" role="alert"><h1>Could not load this title</h1><p>{error}</p><button className="sd-primary" onClick={onRetry}>Try again</button></div> : <div className="sd-loading" role="status" aria-label="Loading anime details"><div className="sd-loading-lines"><div className="sd-skeleton" style={{ height: 12, width: '25%' }} /><div className="sd-skeleton" style={{ height: 50, width: '90%' }} /><div className="sd-skeleton" style={{ height: 14, width: '55%' }} /><div className="sd-skeleton" style={{ height: 62, width: '100%' }} /><div className="sd-skeleton" style={{ height: 44, width: 190 }} /></div><div className="sd-skeleton sd-loading-art" style={{ height: 310, maxWidth: 210, width: '100%', justifySelf: 'center' }} /></div>}
  </div></main>;
}

/**
 * Whether hls.js can play here (it needs Media Source Extensions with H.264/AAC).
 *
 * This used to import hls.js only to call Hls.isSupported(), which put the
 * 512 KB player library on the detail page's import graph; the same check is
 * made directly so hls.js loads only where video plays.
 */
function browserPlaysHls(): boolean {
  try {
    const scope = globalThis as typeof globalThis & { ManagedMediaSource?: typeof MediaSource; WebKitMediaSource?: typeof MediaSource };
    const Source = scope.ManagedMediaSource || scope.MediaSource || scope.WebKitMediaSource;
    return !!Source && typeof Source.isTypeSupported === 'function'
      && Source.isTypeSupported('video/mp4; codecs="avc1.42E01E,mp4a.40.2"');
  } catch {
    return false;
  }
}

const PREWARM_LIMIT = 4;

/** "Ep 7 · Fri 03:00 · in 2 days" for the next broadcast, in the viewer's time zone. */
function nextAiringLabel(next: { episode: number; airingAt: number } | undefined): string | null {
  if (!next || !(next.airingAt > Date.now())) return null;
  try {
    const when = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(next.airingAt));
    const hours = (next.airingAt - Date.now()) / 3_600_000;
    const relative = hours < 1 ? 'within the hour' : hours < 24 ? `in ${Math.round(hours)} h` : `in ${Math.round(hours / 24)} day${Math.round(hours / 24) === 1 ? '' : 's'}`;
    return `Episode ${next.episode} · ${when} · ${relative}`;
  } catch {
    return `Episode ${next.episode}`;
  }
}

function downloadStatus(download: AnimeDetailWebProps['offline'][string] | undefined): { text: string; tone?: 'error' | 'ready' } | null {
  if (!download) return null;
  const pct = Math.round((download.progress || 0) * 100);
  switch (download.status) {
    case 'ready': return { text: `Saved in Sakura${download.quality ? ` · ${download.quality}` : ''}`, tone: 'ready' };
    case 'downloading': return { text: download.totalSegments ? `Downloading ${pct}%` : 'Preparing download…' };
    case 'paused': return { text: `Download paused at ${pct}%` };
    default: return { text: download.error ? `Download failed: ${download.error}` : 'Download failed', tone: 'error' };
  }
}

export default function AnimeDetailWeb({ anime, progress, saved, offline, downloadable, downloadsNeedHls, notice, onBack, onSave, onShare, onPlay, onDownload, onMarkWatched, discussion, creator, episodesLoading, listStatus, onListStatus, onPrewarm }: AnimeDetailWebProps) {
  const [section, setSection] = useState('episodes');
  const episodeSection = useRef<HTMLElement>(null);
  const changePage = (value: number) => {
    setSelectedPage(value);
    episodeSection.current?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  };
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState('');
  const [episodeFilter, setEpisodeFilter] = useState<'all' | 'unwatched'>('all');
  const [selectedPage, setSelectedPage] = useState<number | null>(null);
  const hlsPlayable = useMemo(browserPlaysHls, []);
  const canDownload = downloadable && (CAN_SAVE_ANIME_VIDEO || !downloadsNeedHls || hlsPlayable);
  const episodes = anime.episodes;
  const savedEpisode = progress?.animeId === anime.id ? episodes.find(ep => ep.id === progress.episodeId || (/^(?:mal|hi)-\d+-\d+$/.test(ep.id) && /^(?:mal|hi)-\d+-\d+$/.test(progress.episodeId) && ep.number === progress.episodeNumber)) : undefined;
  const bookmark = savedEpisode ? progress : null;
  const resumable = canResumeWatchProgress(bookmark);
  const finished = !!bookmark && isWatchProgressComplete(bookmark);
  const playEpisode = savedEpisode || episodes[0];
  const position = resumePosition(bookmark);
  const duration = bookmark?.durationSeconds && Number.isFinite(bookmark.durationSeconds) ? bookmark.durationSeconds : 0;
  const ratio = finished ? 1 : bookmark ? Math.min(1, Math.max(0, duration > 0 ? position / duration : bookmark.progress || 0)) : 0;
  const hasExactPosition = typeof bookmark?.positionSeconds === 'number' && Number.isFinite(bookmark.positionSeconds);
  const hasClock = hasExactPosition || duration > 0;
  const timeLabel = hasClock ? `${hasExactPosition ? '' : 'About '}${clock(position)}${duration > 0 ? ` / ${clock(duration)}` : ''}` : `Saved progress · ${Math.round(ratio * 100)}%`;
  const remainingLabel = duration > 0 ? `${hasExactPosition ? '' : 'About '}${clock(Math.max(0, duration - position))} left` : 'Your place is saved';
  const filtered = useMemo(() => {
    const value = query.trim().toLowerCase();
    return episodes.filter(ep => (episodeFilter === 'all' || !isEpisodeWatched(progress, ep.id, ep.number)) && (!value || String(ep.number).includes(value) || ep.title.toLowerCase().includes(value)));
  }, [episodes, query, episodeFilter, progress]);
  const watchedCount = episodes.filter(ep => isEpisodeWatched(progress, ep.id, ep.number)).length;
  const pageCount = Math.ceil(filtered.length / PAGE_SIZE);
  const defaultPage = query || episodeFilter !== 'all' ? 0 : Math.max(0, Math.floor(episodes.findIndex(ep => ep.id === savedEpisode?.id) / PAGE_SIZE));
  const page = Math.min(Math.max(0, pageCount - 1), selectedPage ?? defaultPage);
  const visible = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const artwork = anime.localCover || { uri: anime.cover || anime.image };
  const hasArtwork = !!(anime.localCover || anime.cover || anime.image);
  const imageStyle = { position: 'absolute' as const, width: '100%' as const, height: '100%' as const, inset: 0 };
  const nextAiring = nextAiringLabel(anime.nextAiringEpisode);

  /*
   * Stream prewarming. The likely episode (resume point or episode 1) is
   * resolved once the page has settled, and any other episode on hover intent,
   * keyboard focus or press. Capped per page so sweeping the pointer across the
   * grid cannot fire two dozen lookups.
   */
  const prewarmed = useRef(new Set<string>());
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prewarm = (episode: AnimeEpisode | undefined) => {
    if (!episode || !onPrewarm || prewarmed.current.has(episode.id) || prewarmed.current.size >= PREWARM_LIMIT) return;
    prewarmed.current.add(episode.id);
    onPrewarm(episode);
  };
  const prewarmSoon = (episode: AnimeEpisode) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => prewarm(episode), 150);
  };
  const cancelPrewarm = () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); };
  const warmTargets = (episode: AnimeEpisode) => ({
    onPointerEnter: (event: React.PointerEvent) => { if (event.pointerType === 'mouse') prewarmSoon(episode); },
    onPointerLeave: cancelPrewarm,
    onPointerDown: () => prewarm(episode),
    onFocus: () => prewarm(episode),
  });
  const likelyEpisodeId = episodesLoading ? undefined : playEpisode?.id;
  useEffect(() => {
    if (!likelyEpisodeId || !playEpisode) return;
    const settle = setTimeout(() => prewarm(playEpisode), 1200);
    return () => clearTimeout(settle);
    // Only when the likely episode changes; prewarm itself is idempotent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [likelyEpisodeId]);
  useEffect(() => () => cancelPrewarm(), []);

  return <main className="sakura-detail" data-anime-detail={anime.id}>

    <div className="sd-shell">
      <nav className="sd-nav" aria-label="Anime navigation">
        <button className="sd-back" onClick={onBack} aria-label="Go back"><Icon name="back" />Browse anime</button>
        <span className="sd-brand">Sakura <span>Anime</span></span>
        <div className="sd-nav-actions">
          <button className="sd-icon-button" onClick={onShare} aria-label="Share this anime" title="Share"><Icon name="share" /></button>
          <button className="sd-icon-button" onClick={onSave} aria-label={saved ? 'Remove from library' : 'Add to library'} aria-pressed={saved} title={saved ? 'Saved to library' : 'Add to library'}><Icon name={saved ? 'check' : 'save'} /></button>
        </div>
      </nav>

      {notice && <div className="sd-notice" role="status"><span>{notice.text}</span>{notice.actionLabel && notice.onAction && <button onClick={notice.onAction}>{notice.actionLabel}</button>}</div>}

      <section className="sd-hero" aria-labelledby="sd-title" data-artwork={hasArtwork}>
        <div className="sd-copy">
          <div className="sd-eyebrow">{creator ? 'Sakura Original' : 'Anime'}</div>
          <h1 id="sd-title" className="sd-title">{anime.title}</h1>
          <div className="sd-meta">
            {anime.score != null && <span className="sd-score">★ {anime.score} / 10</span>}
            {anime.year ? <span>{anime.year}</span> : null}
            {anime.type && <span>{anime.type}</span>}
            {episodes.length > 0 && <span>{episodes.length} episode{episodes.length === 1 ? '' : 's'}</span>}
            {anime.status && <span>{anime.status}</span>}
          </div>
          {anime.titleRomaji && <p className="sd-alt-title">{anime.titleRomaji}</p>}
          {nextAiring && <p className="sd-next-airing"><span>Next</span>{nextAiring}</p>}
          {!!anime.genres?.length && <p className="sd-genres">{anime.genres.join('  /  ')}</p>}
          {anime.description && <><p className={`sd-description${expanded ? ' expanded' : ''}`}>{anime.description.replace(/<[^>]+>/g, '')}</p><button className="sd-text-button" onClick={() => setExpanded(value => !value)} aria-expanded={expanded}>{expanded ? 'Show less' : 'Read synopsis'}</button></>}
          {episodesLoading && !playEpisode ? <div className="sd-playback" role="status" aria-label="Loading episodes">
            <div className="sd-skeleton" style={{ height: 12, width: 120 }} />
            <div className="sd-skeleton" style={{ height: 44, width: 200, marginTop: 14 }} />
          </div> : playEpisode ? <div className="sd-playback">
            <div className="sd-playing-label">{resumable ? 'Continue watching' : finished ? 'Watch it again' : savedEpisode ? 'Up next' : 'Start watching'}</div>
            <p className="sd-playing-title">Episode {playEpisode.number}{playEpisode.title && playEpisode.title !== `Episode ${playEpisode.number}` ? ` · ${playEpisode.title}` : ''}</p>
            {resumable && <><div className="sd-watch-clock"><span>{timeLabel}</span><span>{remainingLabel}</span></div><div className="sd-progress" role="progressbar" aria-label="Episode progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ratio * 100)}><span style={{ width: `${ratio * 100}%` }} /></div></>}
            <div className="sd-cta-row">
              <button className="sd-primary" onClick={() => onPlay(playEpisode, finished)} {...warmTargets(playEpisode)}><Icon name="play" size={18} />{resumable ? 'Continue watching' : finished ? 'Watch again' : `Watch episode ${playEpisode.number}`}</button>
              {resumable && <button className="sd-secondary" onClick={() => onPlay(playEpisode, true)}><Icon name="restart" size={15} />Start over</button>}
              {offline[playEpisode.id]?.status === 'ready' && <span className="sd-episode-status">Saved in Sakura</span>}
              {onListStatus && <ListStatusPicker status={listStatus ?? null} onChange={onListStatus} />}
            </div>
          </div> : <><p className="sd-unavailable">{anime.episodeLoadError || 'Episodes are not available yet.'}</p>{onListStatus && <div className="sd-cta-row"><ListStatusPicker status={listStatus ?? null} onChange={onListStatus} /></div>}</>}
        </div>
        {hasArtwork && <div className="sd-poster-wrap" aria-hidden="true"><div className="sd-poster"><Image source={artwork} style={imageStyle} contentFit="cover" /></div></div>}
      </section>

      <nav className="sd-sections" aria-label="Title sections">
        {[['episodes', 'Episodes'], ['details', 'Details'], ['discussion', 'Discussion'], ...(creator ? [['creator', 'Creator']] : [])].map(([key, label]) => <button key={key} className="sd-section-button" aria-pressed={section === key} onClick={() => setSection(key)}>{label}{key === 'episodes' && !episodesLoading && <span className="sd-section-count">{episodes.length}</span>}</button>)}
      </nav>

      {section === 'episodes' && <section ref={episodeSection} className="sd-episode-section" aria-labelledby="sd-episodes-heading">
        <div className="sd-list-top">
          <div className="sd-list-title"><h2 id="sd-episodes-heading">{episodeFilter === 'unwatched' ? 'Unwatched episodes' : 'All episodes'}</h2><p>{watchedCount} of {episodes.length} watched{query ? ` · ${filtered.length} results` : savedEpisode ? ` · Your place: episode ${savedEpisode.number}` : ''}</p></div>
          {episodes.length > 0 && <div className="sd-filters"><select className="sd-select" aria-label="Episode status" value={episodeFilter} onChange={event => { setEpisodeFilter(event.target.value as 'all' | 'unwatched'); setSelectedPage(0); }}><option value="all">All episodes</option><option value="unwatched">Unwatched</option></select><label className="sd-search"><Icon name="search" size={14} /><input aria-label="Find an episode" placeholder="Find an episode" type="search" value={query} onChange={event => { setQuery(event.target.value); setSelectedPage(0); }} /></label>{pageCount > 1 && <select className="sd-select" aria-label="Episode range" value={page} onChange={event => changePage(Number(event.target.value))}>{Array.from({ length: pageCount }, (_, index) => <option key={index} value={index}>Episodes {filtered[index * PAGE_SIZE].number}–{filtered[Math.min((index + 1) * PAGE_SIZE, filtered.length) - 1].number}</option>)}</select>}</div>}
        </div>
        {episodesLoading && !episodes.length ? <div className="sd-episode-grid" role="status" aria-label="Loading episodes">{Array.from({ length: 6 }, (_, index) => <div key={index} className="sd-episode-skeleton" aria-hidden="true"><div className="sd-skeleton sd-thumb" /><div className="sd-episode-copy"><div className="sd-skeleton" style={{ height: 10, width: 70 }} /><div className="sd-skeleton" style={{ height: 13, width: '80%', marginTop: 8 }} /></div></div>)}</div>
        : visible.length ? <div className="sd-episode-grid">{visible.map(ep => {
          const current = ep.id === savedEpisode?.id;
          const row = getEpisodeWatchProgress(progress, ep.id, ep.number);
          const watched = isEpisodeWatched(progress, ep.id, ep.number);
          const rowResume = canResumeWatchProgress(row);
          const rowPosition = resumePosition(row);
          const rowRatio = row?.completed ? 1 : Math.min(1, Math.max(0, row?.progress ?? 0));
          const download = offline[ep.id];
          const status = downloadStatus(download);
          const pct = Math.round((download?.progress || 0) * 100);
          const downloadLabel = download?.status === 'ready' ? 'Save video' : download?.status === 'downloading' ? `Pause download (${pct}%)` : download?.status === 'paused' ? `Resume download (${pct}%)` : download?.status === 'error' ? 'Retry download' : 'Download episode';
          return <article key={ep.id} className="sd-episode" data-current={current || undefined} data-watched={watched || undefined} data-episode={ep.number}>
            <button className="sd-episode-play" onClick={() => onPlay(ep, watched && !rowResume)} {...warmTargets(ep)} aria-label={`${rowResume ? 'Continue' : watched ? 'Replay' : 'Watch'} episode ${ep.number}: ${ep.title}`}>
              <div className="sd-thumb">{(ep.thumbnail || hasArtwork) && <Image source={ep.thumbnail ? { uri: ep.thumbnail } : artwork} style={imageStyle} contentFit="cover" />}<span className="sd-thumb-number">{String(ep.number).padStart(2, '0')}</span><span className="sd-thumb-play"><Icon name="play" size={22} /></span></div>
              <div className="sd-episode-copy"><div className="sd-episode-kicker">{rowResume ? 'Continue watching' : watched ? 'Watched' : current ? 'Up next' : `Episode ${ep.number}`}</div><div className="sd-episode-title">{ep.title || `Episode ${ep.number}`}</div>{rowResume ? <div className="sd-episode-status">{row?.positionSeconds != null ? `Resume at ${clock(rowPosition)}` : row?.durationSeconds ? `Resume near ${clock(rowPosition)}` : `${Math.round(rowRatio * 100)}% watched`}{watched ? ' · Previously watched' : ''}</div> : null}{status && (canDownload || download?.status === 'ready') && <div className="sd-episode-status" data-tone={status.tone} aria-live={download?.status === 'downloading' ? 'off' : 'polite'}>{status.text}</div>}</div>
            </button>
            {onMarkWatched && <button className="sd-watched" aria-label={`Mark episode ${ep.number} as ${watched ? 'unwatched' : 'watched'}`} aria-pressed={watched} title={watched ? 'Mark unwatched' : 'Mark watched'} onClick={() => onMarkWatched(ep, !watched)}><Icon name="check" size={17} /></button>}
            {canDownload && <button className="sd-download" data-state={download?.status} aria-label={`${downloadLabel}: episode ${ep.number}`} title={downloadLabel} onClick={() => onDownload(ep)}>
              {(download?.status === 'downloading' || download?.status === 'paused') && <svg className="sd-download-ring" viewBox="0 0 36 36" aria-hidden="true"><circle className="track" cx="18" cy="18" r="15" /><circle className="fill" cx="18" cy="18" r="15" pathLength={100} strokeDasharray={`${pct} 100`} transform="rotate(-90 18 18)" /></svg>}
              <Icon name={download?.status === 'downloading' ? 'pause' : download?.status === 'error' ? 'restart' : 'download'} size={download?.status === 'downloading' || download?.status === 'paused' ? 13 : 16} />
            </button>}
            {rowRatio > 0 && <span className="sd-episode-bar" style={{ width: `${rowRatio * 100}%` }} />}
          </article>;
        })}</div> : <div className="sd-empty"><strong>{episodes.length ? episodeFilter === 'unwatched' && !query ? 'You’re all caught up' : 'No matching episodes' : 'No streaming source found'}</strong>{episodes.length ? episodeFilter === 'unwatched' && !query ? 'Every episode in this list is marked watched.' : 'Try an episode number or a different title.' : anime.episodeLoadError || 'Please check back later.'}</div>}
        {pageCount > 1 && <div className="sd-pagination"><button disabled={page === 0} onClick={() => changePage(page - 1)}>Previous</button><span>{page + 1} / {pageCount}</span><button disabled={page + 1 >= pageCount} onClick={() => changePage(page + 1)}>Next</button></div>}
      </section>}

      {section === 'details' && <section className="sd-details" aria-label="Anime details"><div><h2>The story</h2><p>{anime.description?.replace(/<[^>]+>/g, '') || 'A synopsis is not available for this title yet.'}</p></div><dl>{[['Format', anime.type], ['Status', anime.status], ['Next episode', nextAiring ?? undefined], ['Released', anime.year], ['Episodes', episodes.length || undefined], ['Runtime', anime.durationMinutes ? `${anime.durationMinutes} min per episode` : undefined], ['Studio', anime.studios?.join(', ') || undefined], ['Genres', anime.genres?.join(', ')], ['Score', anime.score != null ? `${anime.score} / 10` : undefined], ['Also known as', anime.titleRomaji]].map(([label, value]) => value != null && value !== '' ? <React.Fragment key={String(label)}><dt>{label}</dt><dd>{value}</dd></React.Fragment> : null)}</dl></section>}
      {section === 'discussion' && <section className="sd-discussion" aria-label="Discussion">{discussion}</section>}
      {section === 'creator' && creator && <section aria-label="Creator">{creator}</section>}
      {/* After the title record: it primes these shelves, so they need no request of their own. */}
      {!episodesLoading && <AnimeDiscoveryPanels mode="related" animeId={anime.id} />}
    </div>
  </main>;
}

/**
 * Watching / Plan to watch / Completed / On hold / Dropped. A native select:
 * keyboard and screen-reader friendly, and the OS picker on phones.
 */
function ListStatusPicker({ status, onChange }: { status: WatchlistStatus | null; onChange: (status: WatchlistStatus | null) => void }) {
  return <label className="sd-list-status" data-listed={status ? 'true' : 'false'}>
    <Icon name={status ? 'check' : 'save'} size={15} />
    <select aria-label="My list status" value={status ?? ''} onChange={event => onChange((event.target.value || null) as WatchlistStatus | null)}>
      <option value="">{status ? 'Remove from my list' : 'Add to my list'}</option>
      {WATCHLIST_STATUSES.map(entry => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
    </select>
  </label>;
}

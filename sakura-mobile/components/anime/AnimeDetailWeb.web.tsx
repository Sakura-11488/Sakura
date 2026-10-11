import React, { useMemo, useRef, useState } from 'react';
import { Image } from 'expo-image';
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

function Icon({ name, size = 18 }: { name: 'play' | 'back' | 'save' | 'check' | 'share' | 'download' | 'search' | 'restart'; size?: number }) {
  const paths = {
    play: 'm8 5 11 7-11 7V5Z', back: 'm14 6-6 6 6 6',
    save: 'M6 4h12v17l-6-4-6 4V4Z', check: 'm5 12 4 4L19 6',
    share: 'M12 16V3m-4 4 4-4 4 4M5 13v7h14v-7',
    download: 'M12 3v12m-4-4 4 4 4-4M5 17v4h14v-4',
    search: 'm16 16 5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
    restart: 'M3 10a9 9 0 1 1 2 8M3 4v6h6',
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill={name === 'play' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

export function AnimeDetailWebPlaceholder({ onBack, error, onRetry }: AnimeDetailWebPlaceholderProps) {
  return <main className="sakura-detail"><div className="sd-shell">
    <nav className="sd-nav"><button className="sd-back" onClick={onBack} aria-label="Go back"><Icon name="back" />Back</button><span className="sd-brand">Sakura <span>Anime</span></span><span /></nav>
    {error ? <div className="sd-error" role="alert"><h1>Could not load this title</h1><p>{error}</p><button className="sd-primary" onClick={onRetry}>Try again</button></div> : <div className="sd-loading" role="status" aria-label="Loading anime details"><div className="sd-loading-lines"><div className="sd-skeleton" style={{ height: 12, width: '25%' }} /><div className="sd-skeleton" style={{ height: 50, width: '90%' }} /><div className="sd-skeleton" style={{ height: 14, width: '55%' }} /><div className="sd-skeleton" style={{ height: 62, width: '100%' }} /><div className="sd-skeleton" style={{ height: 44, width: 190 }} /></div><div className="sd-skeleton sd-loading-art" style={{ height: 310, maxWidth: 210, width: '100%', justifySelf: 'center' }} /></div>}
  </div></main>;
}

export default function AnimeDetailWeb({ anime, progress, saved, offline, downloadable, onBack, onSave, onShare, onPlay, onDownload, onMarkWatched, discussion, creator }: AnimeDetailWebProps) {
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
          {!!anime.genres?.length && <p className="sd-genres">{anime.genres.join('  /  ')}</p>}
          {anime.description && <><p className={`sd-description${expanded ? ' expanded' : ''}`}>{anime.description.replace(/<[^>]+>/g, '')}</p><button className="sd-text-button" onClick={() => setExpanded(value => !value)} aria-expanded={expanded}>{expanded ? 'Show less' : 'Read synopsis'}</button></>}
          {playEpisode ? <div className="sd-playback">
            <div className="sd-playing-label">{resumable ? 'Continue watching' : finished ? 'Watch it again' : savedEpisode ? 'Up next' : 'Start watching'}</div>
            <p className="sd-playing-title">Episode {playEpisode.number}{playEpisode.title && playEpisode.title !== `Episode ${playEpisode.number}` ? ` · ${playEpisode.title}` : ''}</p>
            {resumable && <><div className="sd-watch-clock"><span>{timeLabel}</span><span>{remainingLabel}</span></div><div className="sd-progress" role="progressbar" aria-label="Episode progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ratio * 100)}><span style={{ width: `${ratio * 100}%` }} /></div></>}
            <div className="sd-cta-row">
              <button className="sd-primary" onClick={() => onPlay(playEpisode, finished)}><Icon name="play" size={18} />{resumable ? 'Continue watching' : finished ? 'Watch again' : `Watch episode ${playEpisode.number}`}</button>
              {resumable && <button className="sd-secondary" onClick={() => onPlay(playEpisode, true)}><Icon name="restart" size={15} />Start over</button>}
              {offline[playEpisode.id]?.status === 'ready' && <span className="sd-episode-status">Downloaded</span>}
            </div>
          </div> : <p className="sd-unavailable">Episodes are not available yet.</p>}
        </div>
        {hasArtwork && <div className="sd-poster-wrap" aria-hidden="true"><div className="sd-poster"><Image source={artwork} style={imageStyle} contentFit="cover" /></div></div>}
      </section>

      <nav className="sd-sections" aria-label="Title sections">
        {[['episodes', 'Episodes'], ['details', 'Details'], ['discussion', 'Discussion'], ...(creator ? [['creator', 'Creator']] : [])].map(([key, label]) => <button key={key} className="sd-section-button" aria-pressed={section === key} onClick={() => setSection(key)}>{label}{key === 'episodes' && <span className="sd-section-count">{episodes.length}</span>}</button>)}
      </nav>

      {section === 'episodes' && <section ref={episodeSection} className="sd-episode-section" aria-labelledby="sd-episodes-heading">
        <div className="sd-list-top">
          <div className="sd-list-title"><h2 id="sd-episodes-heading">{episodeFilter === 'unwatched' ? 'Unwatched episodes' : 'All episodes'}</h2><p>{watchedCount} of {episodes.length} watched{query ? ` · ${filtered.length} results` : savedEpisode ? ` · Your place: episode ${savedEpisode.number}` : ''}</p></div>
          {episodes.length > 0 && <div className="sd-filters"><select className="sd-select" aria-label="Episode status" value={episodeFilter} onChange={event => { setEpisodeFilter(event.target.value as 'all' | 'unwatched'); setSelectedPage(0); }}><option value="all">All episodes</option><option value="unwatched">Unwatched</option></select><label className="sd-search"><Icon name="search" size={14} /><input aria-label="Find an episode" placeholder="Find an episode" type="search" value={query} onChange={event => { setQuery(event.target.value); setSelectedPage(0); }} /></label>{pageCount > 1 && <select className="sd-select" aria-label="Episode range" value={page} onChange={event => changePage(Number(event.target.value))}>{Array.from({ length: pageCount }, (_, index) => <option key={index} value={index}>Episodes {filtered[index * PAGE_SIZE].number}–{filtered[Math.min((index + 1) * PAGE_SIZE, filtered.length) - 1].number}</option>)}</select>}</div>}
        </div>
        {visible.length ? <div className="sd-episode-grid">{visible.map(ep => {
          const current = ep.id === savedEpisode?.id;
          const row = getEpisodeWatchProgress(progress, ep.id, ep.number);
          const watched = isEpisodeWatched(progress, ep.id, ep.number);
          const rowResume = canResumeWatchProgress(row);
          const rowPosition = resumePosition(row);
          const rowRatio = row?.completed ? 1 : Math.min(1, Math.max(0, row?.progress ?? 0));
          const download = offline[ep.id];
          const downloadLabel = download?.status === 'ready' ? 'Downloaded' : download?.status === 'downloading' ? `Pause download (${Math.round(download.progress * 100)}%)` : download?.status === 'paused' ? 'Resume download' : 'Download episode';
          return <article key={ep.id} className="sd-episode" data-current={current || undefined} data-watched={watched || undefined} data-episode={ep.number}>
            <button className="sd-episode-play" onClick={() => onPlay(ep, watched && !rowResume)} aria-label={`${rowResume ? 'Continue' : watched ? 'Replay' : 'Watch'} episode ${ep.number}: ${ep.title}`}>
              <div className="sd-thumb">{(ep.thumbnail || hasArtwork) && <Image source={ep.thumbnail ? { uri: ep.thumbnail } : artwork} style={imageStyle} contentFit="cover" />}<span className="sd-thumb-number">{String(ep.number).padStart(2, '0')}</span><span className="sd-thumb-play"><Icon name="play" size={22} /></span></div>
              <div className="sd-episode-copy"><div className="sd-episode-kicker">{rowResume ? 'Continue watching' : watched ? 'Watched' : current ? 'Up next' : `Episode ${ep.number}`}</div><div className="sd-episode-title">{ep.title || `Episode ${ep.number}`}</div>{rowResume ? <div className="sd-episode-status">{row?.positionSeconds != null ? `Resume at ${clock(rowPosition)}` : row?.durationSeconds ? `Resume near ${clock(rowPosition)}` : `${Math.round(rowRatio * 100)}% watched`}{watched ? ' · Previously watched' : ''}</div> : download?.status === 'ready' ? <div className="sd-episode-status">Downloaded</div> : null}</div>
            </button>
            {onMarkWatched && <button className="sd-watched" aria-label={`Mark episode ${ep.number} as ${watched ? 'unwatched' : 'watched'}`} aria-pressed={watched} title={watched ? 'Mark unwatched' : 'Mark watched'} onClick={() => onMarkWatched(ep, !watched)}><Icon name="check" size={17} /></button>}
            {downloadable && <button className="sd-download" aria-label={`${downloadLabel}: episode ${ep.number}`} title={downloadLabel} disabled={download?.status === 'ready'} onClick={() => onDownload(ep)}><Icon name={download?.status === 'ready' ? 'check' : 'download'} size={16} /></button>}
            {rowRatio > 0 && <span className="sd-episode-bar" style={{ width: `${rowRatio * 100}%` }} />}
          </article>;
        })}</div> : <div className="sd-empty"><strong>{episodes.length ? episodeFilter === 'unwatched' && !query ? 'You’re all caught up' : 'No matching episodes' : 'No streaming source found'}</strong>{episodes.length ? episodeFilter === 'unwatched' && !query ? 'Every episode in this list is marked watched.' : 'Try an episode number or a different title.' : anime.episodeLoadError || 'Please check back later.'}</div>}
        {pageCount > 1 && <div className="sd-pagination"><button disabled={page === 0} onClick={() => changePage(page - 1)}>Previous</button><span>{page + 1} / {pageCount}</span><button disabled={page + 1 >= pageCount} onClick={() => changePage(page + 1)}>Next</button></div>}
      </section>}

      {section === 'details' && <section className="sd-details" aria-label="Anime details"><div><h2>The story</h2><p>{anime.description?.replace(/<[^>]+>/g, '') || 'A synopsis is not available for this title yet.'}</p></div><dl>{[['Format', anime.type], ['Status', anime.status], ['Released', anime.year], ['Episodes', episodes.length || undefined], ['Genres', anime.genres?.join(', ')], ['Score', anime.score != null ? `${anime.score} / 10` : undefined]].map(([label, value]) => value != null && value !== '' ? <React.Fragment key={String(label)}><dt>{label}</dt><dd>{value}</dd></React.Fragment> : null)}</dl></section>}
      {section === 'discussion' && <section className="sd-discussion" aria-label="Discussion">{discussion}</section>}
      {section === 'creator' && creator && <section aria-label="Creator">{creator}</section>}
      <AnimeDiscoveryPanels mode="related" animeId={anime.id} />
    </div>
  </main>;
}

import React, { useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import { Image } from 'expo-image';
import { ANIME_GENRES, type AnimeResult } from '@/lib/anime';
import { getSakuraOriginalInfo, type OriginalEntry } from '@/lib/sakura-originals';
import type { AnimeDiscoveryWebProps } from './AnimeDiscoveryWeb';
import './anime-discovery.web.css';

function Icon({ name, size = 18 }: { name: 'play' | 'left' | 'right' | 'search' | 'calendar'; size?: number }) {
  const paths = { play: 'm8 5 11 7-11 7V5Z', left: 'm14 6-6 6 6 6', right: 'm10 6 6 6-6 6', search: 'm16 16 5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0', calendar: 'M4 5h16v16H4zM4 10h16M8 3v4M16 3v4' };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill={name === 'play' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

function Skeletons() {
  return <>{Array.from({ length: 6 }, (_, index) => <div key={index} className="anime-poster-skeleton" aria-hidden="true"><div className="loading-skeleton" /><span className="loading-skeleton" /><span className="loading-skeleton" /></div>)}</>;
}

function Shelf({ id, title, subtitle, children, loading = false, kind = '' }: { id: string; title: string; subtitle: string; children: ReactNode; loading?: boolean; kind?: string }) {
  const railRef = useRef<HTMLDivElement>(null);
  const [scrollState, setScrollState] = useState({ previous: false, next: false });
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const update = () => {
      const previous = rail.scrollLeft > 2;
      const next = rail.scrollLeft + rail.clientWidth < rail.scrollWidth - 2;
      setScrollState(current => current.previous === previous && current.next === next ? current : { previous, next });
    };
    update();
    rail.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(rail);
    return () => { rail.removeEventListener('scroll', update); observer.disconnect(); };
  }, [children, loading]);
  const scroll = (direction: number) => {
    const rail = railRef.current;
    rail?.scrollBy({ left: direction * rail.clientWidth * .85, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  };
  return <section className={`anime-shelf ${kind}`} id={id} aria-labelledby={`${id}-title`} aria-busy={loading}>
    <div className="anime-section-heading"><div><p className="anime-section-eyebrow">{subtitle}</p><h2 id={`${id}-title`}>{title}</h2></div><div className="anime-shelf-controls"><button type="button" onClick={() => scroll(-1)} disabled={!scrollState.previous} aria-label={`Scroll ${title.toLowerCase()} left`} aria-controls={`${id}-rail`}><Icon name="left" /></button><button type="button" onClick={() => scroll(1)} disabled={!scrollState.next} aria-label={`Scroll ${title.toLowerCase()} right`} aria-controls={`${id}-rail`}><Icon name="right" /></button></div></div>
    {loading && <span className="anime-visually-hidden" role="status">Loading {title.toLowerCase()}…</span>}
    <div className="anime-shelf-rail" id={`${id}-rail`} ref={railRef}>{children}</div>
  </section>;
}

function Poster({ anime, onPress }: { anime: AnimeResult; onPress: () => void }) {
  const [failed, setFailed] = useState(false);
  const metadata = [anime.type, anime.year].filter(Boolean).join(' · ');
  return <button className="anime-poster-card" type="button" onClick={onPress}>
    <span className="anime-poster-art">
      {anime.image && !failed ? <img src={anime.image} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : <span className="anime-art-fallback" aria-hidden="true">{anime.title.slice(0, 1)}</span>}
      {anime.score != null && anime.score > 0 && <span className="anime-poster-rating"><span aria-hidden="true">★</span> {anime.score}</span>}
      <span className="anime-poster-play" aria-hidden="true"><Icon name="play" size={20} /></span><span className="anime-poster-caption" aria-hidden="true">View details <span>↗</span></span>
    </span>
    <span className="anime-poster-title">{anime.title}</span>{metadata && <span className="anime-poster-meta">{metadata}</span>}
  </button>;
}

function OriginalCard({ original, onPress }: { original: OriginalEntry; onPress: () => void }) {
  return <button className="anime-original-card" type="button" onClick={onPress}>
    <span className="anime-original-art"><Image source={original.localImage} style={{ width: '100%', height: '100%' }} contentFit="cover" contentPosition="top" /><span className="anime-original-badge">{original.comingSoon ? 'Coming soon' : 'Sakura Original'}</span><span className="anime-original-play" aria-hidden="true"><Icon name="play" /></span></span>
    <span className="anime-poster-title">{original.title}</span><span className="anime-poster-meta">{original.label}</span>
  </button>;
}

export default function AnimeDiscoveryWeb(props: AnimeDiscoveryWebProps) {
  const rootRef = useRef<HTMLElement>(null);
  const exploreRef = useRef<HTMLElement>(null);
  const isSearching = props.search.trim().length > 0;
  const original = props.originals[props.activeOriginalIndex % props.originals.length];
  const originalInfo = original ? getSakuraOriginalInfo(original.id) : null;
  const [lead, ...tail] = original?.title.split(':') ?? [];
  const genre = ANIME_GENRES.find(item => item.id === props.selectedGenre);
  const explore = () => exploreRef.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
  useImperativeHandle(props.scrollRef, () => ({ scrollToTop: () => rootRef.current?.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }) }), []);

  return <main className="anime-discovery" ref={rootRef}>
    <div className="anime-discovery-topline"><div><p className="anime-section-eyebrow">SAKURA / WATCH</p><h1>Anime<span>.</span></h1></div><nav aria-label="Anime navigation"><button type="button" onClick={props.onSchedule}><Icon name="calendar" size={15} />Schedule</button><button type="button" onClick={props.onLibrary}>My library <span aria-hidden="true">↗</span></button></nav></div>

    {original && <section className="anime-spotlight" aria-labelledby="anime-spotlight-title">
      <div className="anime-spotlight-art" key={original.id}><Image source={original.localImage} style={{ width: '100%', height: '100%' }} contentFit="cover" contentPosition="center" priority="high" /></div>
      <div className="anime-spotlight-copy"><p className="anime-spotlight-kicker"><span /> In the spotlight</p><p className="anime-spotlight-collab">{original.label}</p><h2 id="anime-spotlight-title">{lead}{tail.length > 0 && <>:<br /><em>{tail.join(':').trim()}</em></>}</h2><div className="anime-spotlight-meta">{original.comingSoon ? <span>Coming soon</span> : originalInfo?.status && <span>{originalInfo.status}</span>}{originalInfo?.genres?.slice(0, 2).map(item => <span key={item}>{item}</span>)}</div><p className="anime-spotlight-description">{originalInfo?.description?.replace(/<[^>]+>/g, '') || original.label}</p><div className="anime-spotlight-actions"><button type="button" className="anime-primary-button" onClick={() => props.onOriginalPress(original)}><Icon name="play" />{original.comingSoon ? 'Explore series' : 'Watch series'}</button><button type="button" className="anime-secondary-button" onClick={explore}>Discover anime <Icon name="right" /></button></div></div>
      <div className="anime-spotlight-footnote"><span>Sakura Originals</span><div className="anime-original-selectors" aria-label="Choose featured original">{props.originals.map((entry, index) => <button type="button" key={entry.id} aria-label={`Feature ${entry.title}`} aria-pressed={index === props.activeOriginalIndex} onClick={() => props.onOriginalSelect(index)}><span /></button>)}</div><span>{String(props.activeOriginalIndex + 1).padStart(2, '0')} / {String(props.originals.length).padStart(2, '0')}</span></div>
    </section>}

    {!isSearching && props.history && <div className="anime-history-slot">{props.history}</div>}
    {!isSearching && <div className="anime-personal-slot">{props.personal}</div>}

    <section className="anime-explore" ref={exploreRef} id="anime-explore" aria-labelledby="anime-explore-title">
      <div className="anime-explore-top"><div><p className="anime-section-eyebrow">Your next obsession</p><h2 id="anime-explore-title">Find your next watch</h2></div><div className="anime-search-wrapper"><div className="anime-search-field"><Icon name="search" size={19} /><input type="search" aria-label="Search anime" placeholder="Search anime, find your world…" value={props.search} onChange={event => props.onSearch(event.target.value)} autoComplete="off" />{props.search && <button type="button" onClick={() => props.onSearch('')} aria-label="Clear anime search">×</button>}</div></div></div>
      {!isSearching && <div className="anime-genre-list" aria-label="Filter anime by genre"><button type="button" aria-pressed={props.selectedGenre === null} className={props.selectedGenre === null ? 'selected' : ''} onClick={() => props.onGenreSelect(null)}>All anime</button>{ANIME_GENRES.map(item => <button type="button" key={item.id} aria-pressed={props.selectedGenre === item.id} className={props.selectedGenre === item.id ? 'selected' : ''} onClick={() => props.onGenreSelect(item.id)}>{item.name}</button>)}</div>}
    </section>

    {isSearching && <section className="anime-results" aria-label="Anime search results" aria-busy={props.searchLoading}><div className="anime-results-heading"><h2>Results for “{props.search.trim()}”</h2>{!props.searchLoading && !props.searchError && <span role="status">{props.searchResults.length} titles</span>}</div>{props.searchLoading ? <><span role="status" className="anime-visually-hidden">Searching anime…</span><div className="anime-results-grid"><Skeletons /></div></> : props.searchError ? <div className="anime-empty-state" role="alert"><h3>Couldn’t load your search</h3><p>Please try again in a moment.</p><button type="button" className="anime-secondary-button" onClick={props.onRetrySearch}>Try again</button></div> : props.searchResults.length > 0 ? <div className="anime-results-grid">{props.searchResults.map(anime => <Poster key={anime.id} anime={anime} onPress={() => props.onAnimePress(anime)} />)}</div> : <div className="anime-empty-state"><h3>No titles found</h3><p>Try a different title or a shorter search.</p></div>}</section>}

    {!isSearching && props.selectedGenre !== null && <section className="anime-results" aria-label={`${genre?.name} anime`} aria-busy={props.genreLoading}><div className="anime-results-heading"><h2>{genre?.name} anime</h2>{!props.genreLoading && !props.genreError && <span role="status">{props.genreResults.length} titles</span>}</div>{props.genreLoading ? <div className="anime-results-grid"><Skeletons /></div> : props.genreError ? <div className="anime-empty-state" role="alert"><h3>Couldn’t load this collection</h3><p>Please try again in a moment.</p><button type="button" className="anime-secondary-button" onClick={() => props.onGenreSelect(props.selectedGenre)}>Try again</button></div> : props.genreResults.length > 0 ? <div className="anime-results-grid">{props.genreResults.map(anime => <Poster key={anime.id} anime={anime} onPress={() => props.onAnimePress(anime)} />)}</div> : <div className="anime-empty-state"><h3>No titles here yet</h3><p>Explore another genre to find your next watch.</p></div>}</section>}

    {!isSearching && props.selectedGenre === null && <>
      <Shelf id="anime-originals" title="Only on Sakura" subtitle="Independent voices. Original worlds." kind="anime-originals-shelf">{props.originals.map(entry => <OriginalCard key={entry.id} original={entry} onPress={() => props.onOriginalPress(entry)} />)}</Shelf>
      <div className="anime-creator-slot">{props.creator}</div>
      {props.catalogError && <div className="anime-connection-note" role="status"><span>Some collections couldn’t load. Sakura Originals are still here.</span><button type="button" onClick={props.onRefresh}>Try again <span aria-hidden="true">↻</span></button></div>}
      <Shelf id="anime-airing" title="On air. On your radar." subtitle="Currently airing" loading={props.airingLoading}>{props.airingLoading ? <Skeletons /> : props.airing.length > 0 ? props.airing.map(anime => <Poster key={anime.id} anime={anime} onPress={() => props.onAnimePress(anime)} />) : <p className="anime-shelf-empty">Airing titles will appear here when the catalog reconnects.</p>}</Shelf>
      <Shelf id="anime-popular" title="Worth the watch" subtitle="Popular with the community" loading={props.popularLoading}>{props.popularLoading ? <Skeletons /> : props.popular.length > 0 ? props.popular.map(anime => <Poster key={anime.id} anime={anime} onPress={() => props.onAnimePress(anime)} />) : <p className="anime-shelf-empty">Popular titles will appear here when the catalog reconnects.</p>}</Shelf>
    </>}
    <div className="anime-endnote"><Icon name="play" size={14} /><span>A new world is one play away.</span><button type="button" onClick={explore}>Keep exploring <span aria-hidden="true">↑</span></button></div>
  </main>;
}

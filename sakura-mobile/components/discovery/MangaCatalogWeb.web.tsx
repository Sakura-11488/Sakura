import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useScrollToTop, useLocalSearchParams, type Href } from 'expo-router';
import CoverImage from '@/components/ui/CoverImage';
import { useTheme } from '@/lib/theme';
import type { CatalogSearchResult, CatalogSection, MangaCatalogWebProps } from './MangaCatalogWeb';
import './manga-catalog.web.css';

function Icon({ name }: { name: 'search' | 'arrow' | 'back' | 'book' | 'close' | 'message' | 'clock' }) {
  const paths = {
    search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
    arrow: 'M4 12h16m-6-6 6 6-6 6',
    back: 'M20 12H4m6-6-6 6 6 6',
    book: 'M4 3h16v18H4V3Zm5 0v18m0-12h11M4 15h5',
    close: 'm6 6 12 12M6 18 18 6',
    message: 'M21 11a9 9 0 0 1-9 9H4l-3 2 1-6a9 9 0 1 1 19-5Z',
    clock: 'M12 7v5l3 3M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  };
  return <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

function Cover({ uri, title, eager = false }: { uri: string; title: string; eager?: boolean }) {
  return uri ? <CoverImage source={{ uri }} contentFit="cover" accessibilityLabel={title} priority={eager ? 'high' : 'normal'} loading={eager ? 'eager' : 'lazy'} thumbnailWidth={256} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} /> : <div className="mcw-cover-fallback" aria-label="Cover unavailable"><Icon name="book" /><span>SAKURA</span></div>;
}

const KIND_LABEL: Record<CatalogSearchResult['source'], string> = {
  manga: 'Manga', manhwa: 'Manhwa', anime: 'Anime', novel: 'Novel', comics: 'Comic', users: 'Reader', hentai: '18+',
};

/**
 * Memoised with a stable `onOpen`, so typing in the search box (which
 * re-renders the screen on every keystroke) does not re-render dozens of
 * cards and their cover images.
 */
const ResultCard = memo(function ResultCard({ item, busy, onOpen }: { item: CatalogSearchResult; busy: boolean; onOpen: (item: CatalogSearchResult) => void }) {
  const isUser = item.type === 'user';
  return <button className={`mcw-card${isUser ? ' mcw-user-card' : ''}`} type="button" onClick={() => onOpen(item)} disabled={busy} aria-label={isUser ? `${busy ? 'Opening chat with' : 'Message'} ${item.title}` : `Explore ${item.title}`}>
    <div className="mcw-card-cover">
      {isUser && !item.cover ? <span className="mcw-avatar-letter">{item.title.slice(0, 1).toUpperCase()}</span> : <Cover uri={item.cover} title="" />}
      {!isUser && <span className="mcw-type-badge" data-kind={item.source}>{KIND_LABEL[item.source]}</span>}
      {!isUser && <span className="mcw-card-action"><Icon name="arrow" /></span>}
    </div>
    <span className="mcw-card-title">{item.title}</span>
    <span className="mcw-card-meta">{item.meta}</span>
    {isUser && <span className="mcw-message-action"><Icon name="message" />{busy ? 'Opening chat…' : 'Send a message'}</span>}
  </button>;
});

/**
 * One row per source in the All overview. A rail keeps the same height while
 * loading (skeletons), with results and when stale, so a section answering
 * never pushes the sections below it around. Arrows are for mouse users; touch
 * and trackpads scroll natively and keyboard focus scrolls cards into view.
 */
function Rail({ label, count, resetKey, children }: { label: string; count: number; resetKey: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: false });
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const start = el.scrollLeft <= 4;
    const end = el.scrollLeft + el.clientWidth >= el.scrollWidth - 4;
    setEdges(prev => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, []);
  // Re-measure when the cards or the rail's width change, not on every render:
  // reading scroll geometry forces a layout, and the screen re-renders per
  // keystroke. The rail element also outlives a query (sections are keyed by
  // source), so one scrolled to its end would show a refined query's answer
  // from the middle, hiding the best matches: a fresh answer (`resetKey` is
  // its query; '' while the cards are stale) starts at the first card.
  useEffect(() => {
    const el = ref.current;
    if (resetKey && el && el.scrollLeft > 0) el.scrollLeft = 0;
    measure();
  }, [measure, count, resetKey]);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);
  const page = (dir: 1 | -1) => {
    const el = ref.current;
    if (el) el.scrollBy({ left: dir * Math.max(240, el.clientWidth * 0.85), behavior: 'smooth' });
  };
  return <div className="mcw-rail-wrap">
    <div ref={ref} className="mcw-rail" onScroll={measure}>{children}</div>
    <button type="button" className="mcw-rail-arrow" data-dir="prev" tabIndex={-1} aria-hidden="true" disabled={edges.start} onClick={() => page(-1)} title={`Scroll ${label} back`}><Icon name="back" /></button>
    <button type="button" className="mcw-rail-arrow" data-dir="next" tabIndex={-1} aria-hidden="true" disabled={edges.end} onClick={() => page(1)} title={`Scroll ${label} forward`}><Icon name="arrow" /></button>
  </div>;
}

function Skeletons({ count, lines = 2 }: { count: number; lines?: number }) {
  return <>{Array.from({ length: count }, (_, index) => <div className="mcw-skeleton-card" key={index} aria-hidden="true"><span className="mcw-skeleton-cover" /><span className="mcw-skeleton-line" />{lines > 1 && <span className="mcw-skeleton-line short" />}</div>)}</>;
}

/** Overview rails show this many; the chip shows the whole answer as a grid. */
const RAIL_LIMIT = 12;

function browseHref(section: CatalogSection, query: string): Href {
  return { pathname: '/browse', params: { title: `${section.label} · ${query}`, source: section.browseSource!, q: query } } as Href;
}

function ResultSection({ section, overview, query, messagingUser, onOpen, onShowAll, onRetry, onRemember }: {
  section: CatalogSection;
  overview: boolean;
  query: string;
  messagingUser: string | null;
  onOpen: (item: CatalogSearchResult) => void;
  onShowAll: (section: CatalogSection) => void;
  onRetry: () => void;
  onRemember: () => void;
}) {
  const headingId = `mcw-section-${section.key}`;
  const pending = section.status === 'pending';
  const items = overview ? section.items.slice(0, RAIL_LIMIT) : section.items;
  const cards = items.map(item => <ResultCard key={item.key} item={item} busy={item.type === 'user' && messagingUser === item.user?.wallet_address} onOpen={onOpen} />);
  // A full scraper answer means it may hold more than one search returns:
  // its browse screen pages the same query. Otherwise "See all" just opens the
  // section's own chip, as a grid.
  const canBrowse = !!section.browseSource && section.full && !section.stale && section.items.length > 0;
  const showAll = overview && !section.stale && section.items.length > 6;
  const browseLabel = `See all ${section.label.toLowerCase()} for “${query}”`;
  return <section className="mcw-result-section" data-source={section.key} data-stale={section.stale ? 'true' : undefined} aria-busy={pending} aria-labelledby={overview ? headingId : undefined} aria-label={overview ? undefined : section.label}>
    {overview && <div className="mcw-result-section-head">
      <h3 id={headingId}>{section.label}</h3>
      {!pending && !section.stale && section.status === 'done' && <span className="mcw-section-count">{section.items.length}{section.full ? '+' : ''}</span>}
      {pending && <span className="mcw-section-count" role="status">Searching…</span>}
      {canBrowse
        ? <Link href={browseHref(section, query)} asChild><a className="mcw-section-action" onClick={onRemember} aria-label={browseLabel}>See all <Icon name="arrow" /></a></Link>
        : showAll && <button type="button" className="mcw-section-action" onClick={() => onShowAll(section)} aria-label={`Show all ${section.label} results`}>See all <Icon name="arrow" /></button>}
    </div>}
    {section.status === 'failed'
      ? <div className="mcw-source-note mcw-section-note" role="status"><div><strong>{section.label} {section.slow ? 'is taking too long to answer.' : 'didn’t respond.'}</strong><p>{section.slow ? 'It may still turn up here; you can also ask again.' : 'The other shelves are unaffected. Check your connection and try again.'}</p></div><button type="button" onClick={onRetry}>Try again <Icon name="arrow" /></button></div>
      : items.length
        ? overview ? <Rail label={section.label} count={items.length} resetKey={section.stale ? '' : query}>{cards}</Rail> : <div className="mcw-grid">{cards}</div>
        : pending
          ? overview ? <div className="mcw-rail mcw-rail-skeleton" aria-hidden="true"><Skeletons count={6} /></div> : <div className="mcw-grid" aria-hidden="true"><Skeletons count={12} /></div>
          : <div className="mcw-empty"><Icon name="search" /><h3>No {section.label === 'People' ? 'people' : section.label.toLowerCase()} match “{query}”</h3><p>Try a shorter title, another spelling, or a different format.</p></div>}
    {!overview && canBrowse && <Link href={browseHref(section, query)} asChild><a className="mcw-browse-link" onClick={onRemember}>{browseLabel} <Icon name="arrow" /></a></Link>}
  </section>;
}

export default function MangaCatalogWeb({ query, onQueryChange, onSubmit, filter, filters, onFilterChange, sections, summary, discoverCards, discoverLoading, discoverError, messagingUser, suggestions, recentSearches, onRecentPress, onRemoveRecent, onClearRecent, onRemember, onResultPress, onDiscoverPress, onRetry, onRetryDiscover }: MangaCatalogWebProps) {
  const { isDark } = useTheme();
  const inputRef = useRef<HTMLInputElement>(null);
  const viewportRef = useRef<HTMLElement>(null);
  const scrollAdapterRef = useRef({ scrollToTop: () => viewportRef.current?.scrollTo({ top: 0 }) });
  useScrollToTop(scrollAdapterRef);
  const searchParams = useLocalSearchParams<{ focus?: string }>();
  useEffect(() => { if (searchParams.focus) inputRef.current?.focus(); }, [searchParams.focus]);

  // Stable handlers for the memoised cards; the latest props are read through refs.
  const latest = useRef({ onRemember, onResultPress, onFilterChange });
  latest.current = { onRemember, onResultPress, onFilterChange };
  const openResult = useCallback((item: CatalogSearchResult) => { latest.current.onRemember(); latest.current.onResultPress(item); }, []);
  const showAll = useCallback((section: CatalogSection) => {
    latest.current.onRemember();
    latest.current.onFilterChange(section.filter);
    viewportRef.current?.scrollTo({ top: 0 });
  }, []);

  const searching = query.trim().length >= 2;
  const overview = filter === 'All';
  const trimmed = query.trim();
  const status = summary.loading && !summary.anyFresh
    ? 'Searching…'
    : `${summary.count} ${summary.count === 1 ? 'result' : 'results'}${summary.loading ? ' · still searching' : ''}`;
  const allFailed = !summary.loading && summary.count === 0 && summary.failed.length > 0 && sections.every(section => section.status === 'failed');
  return <main ref={viewportRef} className="manga-catalog-web" data-theme={isDark ? 'dark' : 'light'} data-filter={filter}>
    <div className="mcw-shell">
      <header className="mcw-masthead"><div className="mcw-masthead-copy"><p className="mcw-eyebrow">Explore Sakura</p><h1>Find your next read<span> / </span>watch.</h1><p className="mcw-description">Search manga, manhwa, comics, anime, novels and people in one place.</p></div></header>

      <section className="mcw-search-section" aria-label="Search Sakura">
        <form className="mcw-search" role="search" onSubmit={event => { event.preventDefault(); if (searching) onSubmit(); }}>
          <Icon name="search" />
          <input ref={inputRef} type="search" value={query} onChange={event => onQueryChange(event.target.value)} aria-label="Search manga, manhwa, comics, anime, novels, or people" placeholder="Search a title, a world, a creator…" autoComplete="off" autoCorrect="off" spellCheck={false} enterKeyHint="search" />
          {query ? <button type="button" className="mcw-search-clear" aria-label="Clear search" onClick={() => { onQueryChange(''); inputRef.current?.focus(); }}><Icon name="close" /></button> : <span className="mcw-search-hint">/ to search</span>}
        </form>
        {trimmed.length === 1 && <p className="mcw-input-help" role="status">Enter at least 2 characters to search.</p>}
        {searching && <div className="mcw-filters" role="group" aria-label="Filter search results by format">{filters.map(value => <button key={value} type="button" aria-pressed={filter === value} onClick={() => onFilterChange(value)}>{value === 'Novel' ? 'Novels' : value === 'Users' ? 'People' : value}</button>)}</div>}
      </section>

      {!query && recentSearches.length > 0 && <div className="mcw-recent" role="group" aria-label="Recent searches">
        <span>Recently searched</span>
        {recentSearches.map(value => <span className="mcw-recent-item" key={value}>
          <button type="button" onClick={() => onRecentPress(value)}><Icon name="clock" />{value}</button>
          <button type="button" className="mcw-recent-remove" aria-label={`Remove “${value}” from recent searches`} onClick={() => onRemoveRecent(value)}><Icon name="close" /></button>
        </span>)}
        <button type="button" className="mcw-clear-recents" onClick={onClearRecent}>Clear all</button>
      </div>}

      {searching ? <section className="mcw-results" aria-busy={summary.loading && !summary.anyFresh} aria-labelledby="mcw-results-title">
        <div className="mcw-section-heading"><div><h2 id="mcw-results-title">Results for “{trimmed}”</h2></div><span className="mcw-result-count" role="status" aria-live="polite">{status}</span></div>
        {allFailed
          ? <div className="mcw-source-note" role="status"><div><strong>Search couldn’t reach Sakura’s shelves.</strong><p>{summary.failed.join(', ')} didn’t respond. Check your connection and try again in a moment.</p></div><button type="button" onClick={onRetry}>Try again <Icon name="arrow" /></button></div>
          : summary.empty && summary.failed.length === 0 && overview
            ? <div className="mcw-empty"><Icon name="search" /><h3>No matches on any shelf</h3><p>Try a shorter title or another spelling to discover something new.</p><button type="button" onClick={() => { onQueryChange(''); onFilterChange('All'); inputRef.current?.focus(); }}>Start a new search <Icon name="arrow" /></button></div>
            : sections.map(section => <ResultSection key={section.key} section={section} overview={overview} query={trimmed} messagingUser={messagingUser} onOpen={openResult} onShowAll={showAll} onRetry={onRetry} onRemember={onRemember} />)}
      </section> : <>
        <section className="mcw-discover" aria-labelledby="mcw-discover-title" aria-busy={discoverLoading}>
          <div className="mcw-section-heading"><div><h2 id="mcw-discover-title">Trending manga.</h2></div><span className="mcw-shelf-label">Trending manga <Icon name="book" /></span></div>
          {discoverLoading ? <div className="mcw-grid" aria-hidden="true"><Skeletons count={6} lines={1} /></div> : discoverCards.length ? <div className="mcw-grid">{discoverCards.map(card => <button type="button" className="mcw-card" key={card.id} onClick={() => onDiscoverPress(card.id)} aria-label={`Explore ${card.title}`}><div className="mcw-card-cover"><Cover uri={card.cover} title="" /><span className="mcw-card-action"><Icon name="arrow" /></span></div><span className="mcw-card-title">{card.title}</span><span className="mcw-card-meta">Manga</span></button>)}</div> : <div className="mcw-empty"><Icon name="book" /><h3>{discoverError ? 'The shelf couldn’t load just yet.' : 'A little quiet on this shelf.'}</h3><p>{discoverError ? 'Give it another try, or search for a favorite above.' : 'Search above to find a story you’ll love.'}</p><button type="button" onClick={onRetryDiscover}>Refresh the shelf <Icon name="arrow" /></button></div>}
        </section>
        {suggestions.length > 0 && <section className="mcw-suggestions" aria-labelledby="mcw-suggestions-title"><div className="mcw-section-heading"><div><h2 id="mcw-suggestions-title">Try a title.</h2><p className="mcw-section-description">A few searches to get you started.</p></div></div><div className="mcw-suggestions-grid">{suggestions.map((suggestion, index) => <button type="button" className="mcw-suggestion" key={suggestion.label} onClick={() => { onRecentPress(suggestion.query); inputRef.current?.focus(); }}><span className="mcw-suggestion-number">{String(index + 1).padStart(2, '0')}</span><span>{suggestion.query}</span><Icon name="arrow" /></button>)}</div></section>}
      </>}
      <footer className="mcw-footer"><span>桜 sakura.</span><p>Manga. Anime. Novels. Yours.</p></footer>
    </div>
  </main>;
}

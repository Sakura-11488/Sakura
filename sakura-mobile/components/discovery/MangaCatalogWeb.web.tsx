import React, { useRef } from 'react';
import { useScrollToTop } from 'expo-router';
import CoverImage from '@/components/ui/CoverImage';
import { useTheme } from '@/lib/theme';
import type { CatalogSearchResult, MangaCatalogWebProps } from './MangaCatalogWeb';
import './manga-catalog.web.css';

function Icon({ name }: { name: 'search' | 'arrow' | 'book' | 'close' | 'message' }) {
  const paths = {
    search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
    arrow: 'M4 12h16m-6-6 6 6-6 6',
    book: 'M4 3h16v18H4V3Zm5 0v18m0-12h11M4 15h5',
    close: 'm6 6 12 12M6 18 18 6',
    message: 'M21 11a9 9 0 0 1-9 9H4l-3 2 1-6a9 9 0 1 1 19-5Z',
  };
  return <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

function Cover({ uri, title, eager = false }: { uri: string; title: string; eager?: boolean }) {
  return uri ? <CoverImage source={{ uri }} contentFit="cover" accessibilityLabel={title} priority={eager ? 'high' : 'normal'} loading={eager ? 'eager' : 'lazy'} thumbnailWidth={256} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} /> : <div className="mcw-cover-fallback" aria-label="Cover unavailable"><Icon name="book" /><span>SAKURA</span></div>;
}

function ResultCard({ item, busy, onPress }: { item: CatalogSearchResult; busy: boolean; onPress: () => void }) {
  const isUser = item.type === 'user';
  const kind = item.type === 'hentai' ? '18+' : item.type === 'novel' ? 'Novel' : item.type === 'anime' ? 'Anime' : item.type === 'user' ? 'Reader' : item.meta === 'Manhwa' ? 'Manhwa' : 'Manga';
  return <button className={`mcw-card${isUser ? ' mcw-user-card' : ''}`} type="button" onClick={onPress} disabled={busy} aria-label={isUser ? `${busy ? 'Opening chat with' : 'Message'} ${item.title}` : `Explore ${item.title}`}>
    <div className="mcw-card-cover">
      {isUser && !item.cover ? <span className="mcw-avatar-letter">{item.title.slice(0, 1).toUpperCase()}</span> : <Cover uri={item.cover} title="" />}
      {!isUser && <span className="mcw-type-badge" data-kind={item.type}>{kind}</span>}
      {!isUser && <span className="mcw-card-action"><Icon name="arrow" /></span>}
    </div>
    <span className="mcw-card-title">{item.title}</span>
    <span className="mcw-card-meta">{item.meta}</span>
    {isUser && <span className="mcw-message-action"><Icon name="message" />{busy ? 'Opening chat…' : 'Send a message'}</span>}
  </button>;
}

export default function MangaCatalogWeb({ query, onQueryChange, filter, filters, onFilterChange, results, loading, failedSources, discoverCards, discoverLoading, discoverError, messagingUser, suggestions, onResultPress, onDiscoverPress, onRetry, onRetryDiscover }: MangaCatalogWebProps) {
  const { isDark } = useTheme();
  const inputRef = useRef<HTMLInputElement>(null);
  const viewportRef = useRef<HTMLElement>(null);
  const scrollAdapterRef = useRef({ scrollToTop: () => viewportRef.current?.scrollTo({ top: 0 }) });
  useScrollToTop(scrollAdapterRef);
  const searching = query.trim().length >= 2;
  return <main ref={viewportRef} className="manga-catalog-web" data-theme={isDark ? 'dark' : 'light'} data-filter={filter}>
    <div className="mcw-shell">
      <header className={`mcw-masthead${searching ? ' mcw-masthead-searching' : ''}`}>
        <div className="mcw-masthead-copy">
          <p className="mcw-eyebrow"><span /> THE DISCOVERY DESK <span lang="ja">/ 探す</span></p>
          <h1>{searching ? 'Find your next favorite.' : <>One more chapter.<br /><span>A whole new world.</span></>}</h1>
          <p className="mcw-description">Manga, anime, novels, and the people who love them. Your next obsession starts here.</p>
        </div>
        {!searching && <div className="mcw-cover-art" aria-hidden="true">
          <span className="mcw-art-lettering">物語</span>
          <div className="mcw-cover-stack">{(discoverCards.length ? discoverCards.slice(0, 3) : [null, null, null]).map((card, index) => <div className="mcw-art-cover" key={card?.id || index}>{card ? <Cover uri={card.cover} title="" eager={index === 1} /> : <span>{['漫', '画', '桜'][index]}</span>}</div>)}</div>
          <span className="mcw-art-stamp">READ.<br />REPEAT.</span>
        </div>}
      </header>

      <section className="mcw-search-section" aria-label="Search Sakura">
        <form className="mcw-search" role="search" onSubmit={event => { event.preventDefault(); if (searching) onRetry(); }}>
          <Icon name="search" />
          <input ref={inputRef} type="search" value={query} onChange={event => onQueryChange(event.target.value)} aria-label="Search manga, anime, novels, or people" placeholder="Search a title, a world, a creator…" autoComplete="off" autoCorrect="off" spellCheck={false} />
          {query ? <button type="button" className="mcw-search-clear" aria-label="Clear search" onClick={() => { onQueryChange(''); inputRef.current?.focus(); }}><Icon name="close" /></button> : <span className="mcw-search-hint">FIND YOUR STORY</span>}
        </form>
        {query.trim().length === 1 && <p className="mcw-input-help" role="status">Enter at least 2 characters to search.</p>}
        {searching && <div className="mcw-filters" role="group" aria-label="Filter search results by format">{filters.map(value => <button key={value} type="button" aria-pressed={filter === value} onClick={() => onFilterChange(value)}>{value === 'Novel' ? 'Novels' : value === 'Users' ? 'People' : value}</button>)}</div>}
      </section>

      {searching ? <section className="mcw-results" aria-busy={loading} aria-labelledby="mcw-results-title">
        <div className="mcw-section-heading"><div><p className="mcw-eyebrow">YOUR SEARCH</p><h2 id="mcw-results-title">Results for “{query.trim()}”</h2></div><span className="mcw-result-count" role="status" aria-live="polite">{loading ? 'Searching…' : `${results.length} ${results.length === 1 ? 'result' : 'results'}`}</span></div>
        {!loading && failedSources.length > 0 && <div className="mcw-source-note" role="status"><div><strong>Some shelves are taking a little longer.</strong><p>{failedSources.join(', ')} didn’t respond. {results.length ? 'You can still explore the results below.' : 'Please try again in a moment.'}</p></div><button type="button" onClick={onRetry}>Try again <Icon name="arrow" /></button></div>}
        {loading ? <div className="mcw-grid" aria-hidden="true">{Array.from({ length: 12 }, (_, index) => <div className="mcw-skeleton-card" key={index}><span className="mcw-skeleton-cover" /><span className="mcw-skeleton-line" /><span className="mcw-skeleton-line short" /></div>)}</div> : results.length ? <div className="mcw-grid">{results.map(item => <ResultCard key={item.key} item={item} busy={item.type === 'user' && messagingUser === item.user?.wallet_address} onPress={() => onResultPress(item)} />)}</div> : !failedSources.length ? <div className="mcw-empty"><Icon name="search" /><h3>No matches on this shelf</h3><p>Try a shorter title or another format to discover something new.</p><button type="button" onClick={() => { onQueryChange(''); onFilterChange('All'); inputRef.current?.focus(); }}>Start a new search <Icon name="arrow" /></button></div> : null}
      </section> : <>
        <section className="mcw-discover" aria-labelledby="mcw-discover-title" aria-busy={discoverLoading}>
          <div className="mcw-section-heading"><div><p className="mcw-eyebrow">WORTH TURNING THE PAGE</p><h2 id="mcw-discover-title">Start with a good story.</h2></div><span className="mcw-shelf-label">Trending manga <Icon name="book" /></span></div>
          {discoverLoading ? <div className="mcw-grid" aria-hidden="true">{Array.from({ length: 6 }, (_, index) => <div className="mcw-skeleton-card" key={index}><span className="mcw-skeleton-cover" /><span className="mcw-skeleton-line" /></div>)}</div> : discoverCards.length ? <div className="mcw-grid">{discoverCards.map(card => <button type="button" className="mcw-card" key={card.id} onClick={() => onDiscoverPress(card.id)} aria-label={`Explore ${card.title}`}><div className="mcw-card-cover"><Cover uri={card.cover} title="" /><span className="mcw-card-action"><Icon name="arrow" /></span></div><span className="mcw-card-title">{card.title}</span><span className="mcw-card-meta">Manga</span></button>)}</div> : <div className="mcw-empty"><Icon name="book" /><h3>{discoverError ? 'The shelf couldn’t load just yet.' : 'A little quiet on this shelf.'}</h3><p>{discoverError ? 'Give it another try, or search for a favorite above.' : 'Search above to find a story you’ll love.'}</p><button type="button" onClick={onRetryDiscover}>Refresh the shelf <Icon name="arrow" /></button></div>}
        </section>
        <section className="mcw-suggestions" aria-labelledby="mcw-suggestions-title"><div className="mcw-section-heading"><div><p className="mcw-eyebrow">FOLLOW YOUR CURIOSITY</p><h2 id="mcw-suggestions-title">A few places to start.</h2><p className="mcw-section-description">Search ideas for your next rabbit hole.</p></div></div><div className="mcw-suggestions-grid">{suggestions.map((suggestion, index) => <button type="button" className="mcw-suggestion" key={suggestion.label} onClick={() => { onQueryChange(suggestion.query); inputRef.current?.focus(); }}><span className="mcw-suggestion-number">{String(index + 1).padStart(2, '0')}</span><span>{suggestion.query}</span><Icon name="arrow" /></button>)}</div></section>
      </>}
      <footer className="mcw-footer"><span>桜 sakura.</span><p>A home for every story.</p></footer>
    </div>
  </main>;
}

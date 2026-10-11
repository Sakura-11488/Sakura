import React, { useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Link, useRouter, type Href } from 'expo-router';
import type { AllNovelItem } from '@/lib/allnovel';
import { isActiveReadingProgress, type ContinueReadingItem, type NovelProgress } from '@/lib/reader-progress';
import { listPublishedWorks, workCoverUrl, type CreatorWork } from '@/lib/creator';
import CoverImage from '@/components/ui/CoverImage';
import { useWallet } from '@/lib/wallet/context';
import { addFavorite } from '@/lib/supabase';
import { shareContentLink } from '@/lib/share-link';
import type { NovelDiscoveryWebProps } from './NovelDiscoveryWeb';
import './novel-discovery.web.css';


function Icon({ name, size = 20 }: { name: 'book' | 'arrow' | 'search' | 'write' | 'save' | 'check' | 'share' | 'refresh'; size?: number }) {
  const paths = {
    book: 'M12 5.5C8.5 3.5 5.5 3.5 2.5 5v15c3-1.5 6-1.5 9.5.5 3.5-2 6.5-2 9.5-.5V5c-3-1.5-6-1.5-9.5.5ZM12 5.5v15M6 8l2 .5M16 8.5l2-.5',
    arrow: 'M4 12h16m-6-6 6 6-6 6',
    search: 'M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Zm-2 5 6 6',
    write: 'm15 4 5 5M4 20l5-1L21 7a2.8 2.8 0 0 0-4-4L5 15l-1 5Z',
    save: 'M6 3h12v18l-6-4-6 4V3Z',
    check: 'm5 12 4 4L19 6',
    share: 'M12 16V3m-4 4 4-4 4 4M5 13v7h14v-7',
    refresh: 'M3 10a9 9 0 1 1 2 8M3 4v6h6',
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

function BookCover({ title, cover, originalCover, eager = false }: { title: string; cover?: string; originalCover?: string; eager?: boolean }) {
  const [failed, setFailed] = useState<string[]>([]);
  const candidates = [cover, originalCover];
  const image = candidates.find(value => value && !failed.includes(value));
  return <div className="novel-book-cover">{image ? <CoverImage key={image} source={{ uri: image }} style={{ width: '100%', height: '100%' }} contentFit="cover" loading={eager ? 'eager' : 'lazy'} priority={eager ? 'high' : 'normal'} thumbnailWidth={eager ? 512 : 256} onError={() => setFailed(previous => [...previous, image])} /> : <div className="novel-cover-fallback"><span>SAKURA LIBRARY</span><Icon name="book" size={36} /><span>{title}</span></div>}</div>;
}

function BookCard({ novel, progress, genre }: { novel: AllNovelItem; progress?: NovelProgress; genre?: string }) {
  const continuing = !!progress && isActiveReadingProgress(progress.progress);
  return <article className="novel-book-card">
    <Link href={{ pathname: '/novel/ext', params: { path: novel.path } }} asChild>
      <a className="novel-book-link"><BookCover title={novel.name} cover={novel.cover} originalCover={novel.originalCover} /><div className="novel-book-info"><p className="novel-book-source">{genre || 'Web novel'}</p><h3>{novel.name}</h3>{continuing && <p className="novel-book-meta">Continue · {Math.round(progress.progress * 100)}%</p>}<span className="novel-book-open">Open book <Icon name="arrow" size={15} /></span></div></a>
    </Link>
    <button className="novel-card-share" aria-label={`Share ${novel.name}`} title="Share novel" onClick={() => void shareContentLink(`Check out “${novel.name}” on Sakura!`, `/novel/ext?path=${encodeURIComponent(novel.path)}`)}><Icon name="share" size={14} /></button>
  </article>;
}

function CreatorShelf() {
  const [works, setWorks] = useState<CreatorWork[]>([]);
  useEffect(() => {
    let active = true;
    void listPublishedWorks('novel', 20).then(result => { if (active) setWorks(result); }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  if (!works.length) return null;
  return <section className="novel-creators" aria-labelledby="novel-creators-title"><div className="novel-shelf-heading"><div><p className="novel-eyebrow">Sakura Originals</p><h2 id="novel-creators-title">From our writers</h2></div><span className="novel-title-count">Original stories</span></div><div className="novel-creator-shelf">{works.map(work => <Link key={work.id} href={`/work/${work.id}` as Href} asChild><a className="novel-creator-card"><BookCover title={work.title} cover={workCoverUrl(work) || undefined} /><div className="novel-book-info"><p className="novel-book-source">{work.genres[0] || 'Sakura Original'}</p><h3>{work.title}</h3><p className="novel-book-meta">{work.series_status?.replace(/_/g, ' ') || 'Original story'}</p></div></a></Link>)}</div></section>;
}

function ContinueShelf({ items }: { items: ContinueReadingItem[] }) {
  const valid = items.filter(item => item.novelPath);
  if (!valid.length) return null;
  return <section className="novel-continue" aria-labelledby="novel-continue-title"><div className="novel-shelf-heading"><div><p className="novel-eyebrow">Your bookmarks</p><h2 id="novel-continue-title">Continue reading</h2></div><Link href="/library" asChild><a className="novel-text-link">My library <Icon name="arrow" size={16} /></a></Link></div><div className="novel-continue-row">{valid.map(item => <Link key={item.id} href={{ pathname: '/novel/read', params: { path: item.novelPath!, o: String(item.progress), title: item.title, cover: item.cover || '' } }} asChild><a className="novel-continue-card"><BookCover title={item.title} cover={item.cover} /><div><p className="novel-eyebrow">Continue reading</p><h3>{item.title}</h3><p>{item.subtitle}</p><div className="novel-progress" role="progressbar" aria-label={`${item.title} reading progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(item.progress * 100)}><span style={{ width: `${Math.max(0, Math.min(1, item.progress)) * 100}%` }} /></div></div><Icon name="arrow" size={16} /></a></Link>)}</div></section>;
}

function ShelfSkeleton() {
  return <div className="novel-shelf" aria-label="Loading novels" aria-busy="true">{Array.from({ length: 8 }, (_, index) => <div className="novel-skeleton-card" key={index}><div className="novel-skeleton-cover" /><div className="novel-skeleton-copy"><span /><span /><span /></div></div>)}</div>;
}

export default function NovelDiscoveryWeb(props: NovelDiscoveryWebProps) {
  const { novels, featured, loading, loadingMore, refreshing, hasMore, search, activeGenre, genres, recentSearches, continueReading, progress, error, onSearch, onGenre, onRecentRemove, onClearRecent, onLoadMore, onRefresh, onRetry } = props;
  const router = useRouter();
  const rootRef = useRef<HTMLElement>(null);
  useImperativeHandle(props.scrollRef, () => ({ scrollToTop: () => rootRef.current?.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }) }), []);
  const { address } = useWallet();
  const [savedFor, setSavedFor] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [showRecent, setShowRecent] = useState(false);
  const [allGenres, setAllGenres] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const saved = !!address && savedFor === address;
  const browsing = !search.trim() && !activeGenre;
  const genreLabel = genres.find(genre => genre.value === activeGenre)?.label;
  const primaryGenres = genres.filter(genre => ['All', 'Fantasy', 'Romance', 'Adventure', 'Mystery', 'Sci-Fi', 'Slice of Life', 'Martial Arts'].includes(genre.label));
  const visibleGenres = allGenres ? genres : primaryGenres;
  const uniqueNovels = Array.from(new Map(novels.map(novel => [novel.path, novel])).values());

  useEffect(() => {
    const close = (event: MouseEvent) => { if (searchRef.current && !searchRef.current.contains(event.target as Node)) setShowRecent(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const saveFeatured = async () => {
    if (!address) { setSaveError('Connect your wallet from your profile to save this story.'); return; }
    if (saving || saved) return;
    setSaving(true);
    setSaveError('');
    try {
      await addFavorite({ wallet_address: address, content_id: featured.path, content_type: 'novel', title: featured.name, cover_url: featured.cover || '' });
      setSavedFor(address);
    } catch { setSaveError('This story could not be saved. Please try again.'); }
    finally { setSaving(false); }
  };

  return <main className="novel-discovery" data-discovery="novel" ref={rootRef}>
    <div className="novel-library-wrap">
      <header className="novel-page-heading"><div><p className="novel-eyebrow">SAKURA / READ</p><h1>Novels<span>.</span></h1><p className="novel-page-description">Original voices. Stories to settle into.</p></div><Link href="/library" asChild><a>My library <Icon name="arrow" size={16} /></a></Link></header>
      {browsing && <section className="novel-editorial-hero" aria-labelledby="novel-feature-title">
        <Link href={{ pathname: '/novel/ext', params: { path: featured.path } }} asChild><a className="novel-featured-art" aria-label={`Read ${featured.name}`}><BookCover title={featured.name} cover={featured.cover} originalCover={featured.originalCover} eager /></a></Link>
        <div className="novel-featured-copy"><p className="novel-eyebrow">Featured original</p><Link href={{ pathname: '/novel/ext', params: { path: featured.path } }} asChild><a><h2 id="novel-feature-title">{featured.name}</h2></a></Link><p className="novel-feature-kind">Sakura Original · Novel</p><div className="novel-featured-actions"><Link href={{ pathname: '/novel/ext', params: { path: featured.path } }} asChild><a className="novel-featured-action">Read novel <Icon name="arrow" size={16} /></a></Link><button className="novel-save-button" aria-label={saved ? 'Saved to your library' : `Save ${featured.name} to your library`} aria-pressed={saved} disabled={saving || saved} onClick={() => void saveFeatured()}><Icon name={saved ? 'check' : 'save'} size={17} /></button></div>{saveError && <p className="novel-save-error" role="status">{saveError}</p>}</div>
        <div className="novel-feature-aside"><Icon name="book" size={23} /><span>ON THE READING LIST</span><a href="#novel-shelves">Browse all novels <Icon name="arrow" size={15} /></a></div>
      </section>}
      <div className="novel-library-toolbar"><div className="novel-search-wrap" ref={searchRef}><label className="novel-search-field"><Icon name="search" /><input type="search" aria-label="Search novels by title" placeholder="Find your next read…" value={search} onChange={event => onSearch(event.target.value)} onFocus={() => setShowRecent(true)} onKeyDown={event => { if (event.key === 'Escape') setShowRecent(false); }} />{search && <button aria-label="Clear novel search" onClick={() => onSearch('')}>×</button>}</label>{showRecent && !search && recentSearches.length > 0 && <div className="novel-recent-searches"><div className="novel-recent-heading"><span>Recent searches</span><button onClick={onClearRecent}>Clear all</button></div>{recentSearches.map(value => <div className="novel-recent-item" key={value}><button onClick={() => { onSearch(value); setShowRecent(false); }}>{value}</button><button aria-label={`Remove ${value} from recent searches`} onClick={() => onRecentRemove(value)}>×</button></div>)}</div>}</div><div className="novel-toolbar-actions"><button className="novel-refresh-button" onClick={onRefresh} disabled={refreshing} aria-label="Refresh the novel library" title="Refresh library"><Icon name="refresh" size={17} /></button><Link href="/creator-upload" asChild><a className="novel-write-link"><Icon name="write" size={17} /><span>Write a story</span></a></Link></div></div>
      {browsing && <><ContinueShelf items={continueReading} /><CreatorShelf /></>}
      <section id="novel-shelves" className="novel-library-layout" aria-labelledby="novel-shelf-title"><aside className="novel-genre-sidebar" aria-label="Browse novels by genre"><p className="novel-eyebrow">Browse genres</p><div className="novel-genre-list">{visibleGenres.map(genre => <button key={genre.label} className={activeGenre === genre.value ? 'is-active' : ''} aria-pressed={activeGenre === genre.value} onClick={() => { onGenre(genre.value); setShowRecent(false); }}>{genre.value ? genre.label : 'All stories'}<span>↗</span></button>)}<button className="novel-more-genres" aria-expanded={allGenres} onClick={() => setAllGenres(value => !value)}>{allGenres ? 'Fewer genres' : 'More genres'}<span>{allGenres ? '−' : '+'}</span></button></div></aside><div className="novel-shelf-content"><div className="novel-shelf-heading"><div><p className="novel-eyebrow">{search.trim() ? 'Search' : activeGenre ? 'Genre' : 'Web novels'}</p><h2 id="novel-shelf-title">{search.trim() ? `Results for “${search.trim()}”` : activeGenre ? `${genreLabel} stories` : 'All novels'}</h2></div><span className="novel-title-count" aria-live="polite">{loading ? 'Finding stories…' : `${uniqueNovels.length} ${uniqueNovels.length === 1 ? 'title' : 'titles'}`}</span></div>
        {error && !loading && <div className="novel-library-notice" role="status"><p>{error}</p><button onClick={onRetry}>Try again <Icon name="arrow" size={16} /></button></div>}
        {loading ? <ShelfSkeleton /> : uniqueNovels.length ? <><div className="novel-shelf">{uniqueNovels.map(novel => <BookCard key={novel.path} novel={novel} progress={progress[novel.path]} genre={activeGenre ? genreLabel : undefined} />)}</div>{hasMore && <div className="novel-load-more"><button onClick={onLoadMore} disabled={loadingMore}>{loadingMore ? 'Loading novels…' : 'Load more novels'}<Icon name="arrow" size={17} /></button></div>}</> : <div className="novel-empty-state"><Icon name="book" size={40} /><h3>{search.trim() ? 'No matching novels' : 'No novels on this shelf yet'}</h3><p>{search.trim() ? 'Try another title, or explore a different genre.' : error ? 'Please try loading the library again.' : 'Explore another genre to find your next read.'}</p><button onClick={() => activeGenre || search ? onGenre('') : onRetry()}>{activeGenre || search ? 'Explore all stories' : 'Refresh the library'}<Icon name="arrow" size={17} /></button></div>}
      </div></section>
      <footer className="novel-library-footer"><span>桜 <span>Sakura Novels</span></span><Link href="/creator-upload" asChild><a className="novel-footer-publish"><Icon name="write" size={15} />Publish your story</a></Link><button onClick={() => router.push('/library')}>My library <Icon name="arrow" size={15} /></button></footer>
    </div>
  </main>;
}

import React, { memo, useMemo, useRef, useState, useEffect, useImperativeHandle, type ReactNode } from 'react';
import { Link, useRouter, type Href } from 'expo-router';
import { useTheme } from '@/lib/theme';
import CoverImage from '@/components/ui/CoverImage';
import type { ContentItem } from '@/components/ui/ContentCard';
import type { CarouselItem } from '@/components/ui/FeaturedCarousel';
import { SAKURA_ORIGINALS } from '@/lib/sakura-originals';
import { hoverMangaTitle, leaveMangaTitle, prefetchMangaTitle, runWhenIdle, watchCardVisibility } from '@/lib/manga-prefetch';
import type { MangaHomeWebProps } from './MangaHomeWeb';
import './manga-home.web.css';

function Arrow({ back = false }: { back?: boolean }) { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d={back ? 'M20 12H4m6-6-6 6 6 6' : 'M4 12h16m-6-6 6 6-6 6'} /></svg>; }
function destination(item: ContentItem | CarouselItem): Href { return { pathname: `/${item.type}/[id]`, params: { id: item.id, ...(item.type === 'manga' && item.source ? { source: item.source } : {}) } } as Href; }
function unique(items: ContentItem[]) { return items.filter((item, index) => items.findIndex(other => other.id === item.id && other.source === item.source) === index); }
/**
 * Warm a title's page on hover, keyboard focus or press: the click those
 * announce is a few hundred milliseconds away, which covers much of the
 * page's own requests. A hover counts only once the pointer rests (see
 * HOVER_INTENT_MS). Spread onto the link's <a>; Link's Slot composes these
 * with its own handlers.
 */
function intentHandlers(item: ContentItem | CarouselItem) {
  const ref = { id: item.id, source: item.type === 'manga' ? item.source : undefined, type: item.type, title: item.title, cover: item.cover };
  return {
    onPointerEnter: () => hoverMangaTitle(ref),
    onPointerLeave: () => leaveMangaTitle(ref),
    onFocus: () => prefetchMangaTitle(ref, 'intent'),
    onPointerDown: () => prefetchMangaTitle(ref, 'intent', { pressed: true }),
  };
}
/**
 * Memoised: home re-renders whenever any of its lists or rows changes, and a
 * shelf of these re-rendering is ~20 cover components each time.
 */
const MangaPoster = memo(function MangaPoster({ item, category = 'Manga', badgeSubtitle = false }: { item: ContentItem; category?: string; badgeSubtitle?: boolean }) {
  const ref = useRef<HTMLAnchorElement>(null);
  // A card that stays in view is a likely next tap; its detail is fetched at
  // idle, under lib/manga-prefetch's budget.
  useEffect(() => watchCardVisibility(ref.current, item), [item]);
  return <Link href={destination(item)} asChild><a ref={ref} className="mh-card" {...intentHandlers(item)}><div className="mh-card-art"><CoverImage source={{ uri: item.cover }} style={{ width: '100%', height: '100%' }} contentFit="cover" accessibilityLabel="" loading="lazy" />{typeof item.score === 'number' && item.score > 0 && <span className="mh-card-rating">★ {item.score.toFixed(1)}</span>}</div><h3>{item.title}</h3><p>{badgeSubtitle && item.badge ? item.badge : category}</p></a></Link>;
});
const Shelf = memo(function Shelf({ title, items, category, onBrowse, badgeSubtitle, children }: { title: string; items?: ContentItem[]; category?: string; onBrowse?: () => void; badgeSubtitle?: boolean; children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [arrows, setArrows] = useState({ left: false, right: false });
  // What the rail holds, as a value: keyed on the arrays themselves, every
  // re-render of home tore down and re-added the observer and listener and set
  // the arrows again, rendering each shelf twice.
  const contents = items ? items.map(item => `${item.source}-${item.id}`).join('|') : String(React.Children.count(children));
  useEffect(() => {
    const rail = ref.current; if (!rail) return;
    const update = () => {
      const left = rail.scrollLeft > 2; const right = rail.scrollLeft + rail.clientWidth < rail.scrollWidth - 2;
      setArrows(previous => previous.left === left && previous.right === right ? previous : { left, right });
    };
    const observer = new ResizeObserver(update); observer.observe(rail); rail.addEventListener('scroll', update, { passive: true }); update();
    return () => { observer.disconnect(); rail.removeEventListener('scroll', update); };
  }, [contents]);
  const scroll = (direction: number) => ref.current?.scrollBy({ left: direction * ref.current.clientWidth * .85, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  return <section className="mh-shelf"><div className="mh-section-heading"><h2>{title}<span>.</span></h2><div className="mh-shelf-actions">{onBrowse && <button className="mh-text-button" onClick={onBrowse}>View all <Arrow /></button>}<div className="mh-scroll-buttons"><button onClick={() => scroll(-1)} disabled={!arrows.left} aria-label={`Scroll ${title} left`}><Arrow back /></button><button onClick={() => scroll(1)} disabled={!arrows.right} aria-label={`Scroll ${title} right`}><Arrow /></button></div></div></div><div className="mh-rail" ref={ref}>{items?.map(item => <MangaPoster key={`${item.source}-${item.id}`} item={item} category={category} badgeSubtitle={badgeSubtitle} />)}{children}</div></section>;
});
/**
 * Mount below-the-fold rows only once the catalogue lists are in and the
 * browser is idle, or sooner if the reader scrolls near them. The community
 * rows each run their own Supabase query (three, each with its own CORS
 * preflight) and the streak card a gamification fetch; on a cold load they
 * competed with the two catalogue requests the first screen is waiting on,
 * for rows nobody could see yet. Deferred, never skipped: the idle callback
 * always fires once the lists settle, and DEFERRED_ROWS_CEILING_MS covers a
 * list that never does (supabase.functions.invoke has no timeout of its own),
 * so the streak card's queued-reading flush still runs.
 */
const DEFERRED_ROWS_CEILING_MS = 8000;
function useDeferredUntilIdle(ready: boolean, sentinel: React.RefObject<HTMLElement | null>, root: React.RefObject<HTMLElement | null>) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (shown) return;
    const ceiling = setTimeout(() => setShown(true), DEFERRED_ROWS_CEILING_MS);
    return () => clearTimeout(ceiling);
  }, [shown]);
  useEffect(() => {
    if (shown || !ready) return;
    const show = () => setShown(true);
    const element = sentinel.current;
    let observer: IntersectionObserver | null = null;
    if (element && typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) show(); }, { root: root.current, rootMargin: '0px 0px 50% 0px' });
      observer.observe(element);
    }
    const idle = runWhenIdle(show, 2500);
    return () => { observer?.disconnect(); idle.cancel(); };
  }, [ready, shown, sentinel, root]);
  return shown;
}
export default function MangaHomeWeb(props: MangaHomeWebProps) {
  const { isDark } = useTheme(); const router = useRouter(); const mainRef = useRef<HTMLElement>(null);
  const [query, setQuery] = useState('');
  const [featureIndex, setFeatureIndex] = useState(0);
  useImperativeHandle(props.scrollRef, () => ({ scrollToTop: () => mainRef.current?.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }) }), []);
  useEffect(() => { setFeatureIndex(0); }, [props.category]);
  // Each half of the page has its own loading state (home.tsx): the featured
  // slot and hot list come from trending, the shelves from popular.
  const trendingLoading = props.trendingLoading ?? props.loading; const popularLoading = props.popularLoading ?? props.loading;
  const featured = useMemo(() => props.featured.slice(0, 3), [props.featured]); const top = featured[featureIndex] || featured[0];
  const popular = useMemo(() => unique(props.popular), [props.popular]); const trending = useMemo(() => unique([...props.trending, ...props.picks]), [props.trending, props.picks]);
  const more = useMemo(() => unique(props.more).filter(item => !popular.some(other => other.id === item.id)), [props.more, popular]);
  const updates = useMemo(() => unique(props.updates ?? []), [props.updates]);
  // Genre shelves arrive at idle, after the lists above (home.tsx); an empty
  // one is left out rather than shown as an error, since they are extras.
  const genreShelves = useMemo(() => props.genres.filter(row => row.items.length > 0).map(row => ({ ...row, items: unique(row.items) })), [props.genres]);
  const belowFoldRef = useRef<HTMLDivElement>(null);
  const showBelowFold = useDeferredUntilIdle(!trendingLoading && !popularLoading, belowFoldRef, mainRef);
  const search = (event: React.FormEvent) => { event.preventDefault(); router.push({ pathname: '/(tabs)/search', params: { q: query.trim(), searchRequest: String(Date.now()) } } as Href); };
  const random = () => { const pool = [...popular, ...trending]; if (pool.length) router.push(destination(pool[Math.floor(Math.random() * pool.length)])); };
  // data-cover-root: covers measure their lookahead against this scroller,
  // not the window it sits in (CoverImage.web).
  return <main ref={mainRef} data-cover-root="" className={`manga-home-web ${isDark ? '' : 'mh-light'}`} aria-label="Manga discovery"><div className="mh-container">
    <header className="mh-masthead"><div><p className="mh-collection">The reading room <span aria-hidden="true">漫画</span></p><h1>Manga<span> & more.</span></h1></div><form className="mh-search" role="search" onSubmit={search}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="10" cy="10" r="6" /><path d="m15 15 6 6" /></svg><input type="search" aria-label="Search Sakura" placeholder="Find a series…" value={query} onChange={event => setQuery(event.target.value)} /><button aria-label="Search titles" type="submit"><Arrow /></button></form></header>
    <div className="mh-source-row"><div className="mh-source-tabs" role="group" aria-label="Story collection">{props.categories.map(category => <button key={category} onClick={() => props.onCategory(category)} aria-pressed={props.category === category}>{category}</button>)}</div><button className="mh-surprise" disabled={!popular.length && !trending.length} onClick={random}><span aria-hidden="true">↝</span> Surprise me</button></div>
    <div className="mh-opening"><section className="mh-feature" aria-label="Featured series" aria-busy={trendingLoading}>
      <div className="mh-feature-copy"><span className="mh-feature-tag">In {props.category.toLowerCase()}</span><h2>{trendingLoading ? 'Finding a good read…' : top?.title || 'The catalog is taking a moment.'}</h2>{top && !trendingLoading && <p>{top.genres.filter(genre => genre.toLowerCase() !== props.category.toLowerCase()).slice(0,3).join(' · ') || 'From the trending collection'}</p>}{top && !trendingLoading ? <Link href={destination(top)} asChild><a className="mh-primary" {...intentHandlers(top)}>Open series <Arrow /></a></Link> : <button className="mh-primary" onClick={props.onRefresh}>Refresh <Arrow /></button>}
      <div className="mh-feature-pagination" role="group" aria-label="Featured titles">{featured.map((item,index) => <button key={item.id} aria-label={`Feature ${item.title}`} aria-pressed={featureIndex === index} onClick={() => setFeatureIndex(index)}>{String(index+1).padStart(2,'0')}</button>)}</div></div>
      <div className="mh-feature-cover">{top && !trendingLoading && <CoverImage source={top.localCover || {uri:top.cover}} style={{width:'100%',height:'100%'}} contentFit="cover" loading="eager" priority="high" thumbnailWidth={512} accessibilityLabel="" />}</div>
    </section><aside className="mh-hotlist" aria-label="Trending manga"><div className="mh-hotlist-heading"><h2>Trending now</h2><span className="mh-pink-star" aria-hidden="true">✳</span></div>{trending.slice(0,4).map((item,index) => <Link href={destination(item)} asChild key={`${item.source}-${item.id}`}><a className="mh-ranked" {...intentHandlers(item)}><span className="mh-rank">{String(index+1).padStart(2,'0')}</span><div className="mh-rank-cover"><CoverImage source={{uri:item.cover}} style={{width:'100%',height:'100%'}} contentFit="cover" accessibilityLabel="" thumbnailWidth={256}/></div><div><h3>{item.title}</h3><span>{props.category}</span></div><Arrow /></a></Link>)}{trendingLoading && <p className="mh-quiet" role="status">Loading the latest titles…</p>}<button className="mh-text-button" onClick={() => props.onBrowse('Trending '+props.category,{kind:'trending'})}>Browse trending <Arrow /></button></aside></div>
    <div className="mh-resume">{props.continueReading}</div>
    {popularLoading ? <section className="mh-shelf" role="status" aria-label="Loading stories"><div className="mh-section-heading"><h2>Popular series<span>.</span></h2></div><div className="mh-rail">{Array.from({length:6},(_,i)=><div key={i} className="mh-skeleton"/>)}</div></section> : popular.length ? <Shelf title="Popular series" items={popular} category={props.category} onBrowse={() => props.onBrowse('Popular '+props.category,{kind:'popular'})}/> : <section className="mh-empty"><h2>This shelf couldn’t load.</h2><p>Try again or choose another collection.</p><button className="mh-primary" onClick={props.onRefresh}>Try again <Arrow/></button></section>}
    {!popularLoading && more.length > 0 && <Shelf title="Further down the shelf" items={more} category={props.category} onBrowse={() => props.onBrowse('More '+props.category,{kind:'popular'})}/>}
    {updates.length > 0 && <Shelf title="Latest updates" items={updates} category={props.category} badgeSubtitle onBrowse={props.onUpdates}/>}
    {genreShelves.map(row => <Shelf key={row.title} title={row.title} items={row.items} category={props.category} onBrowse={() => props.onBrowse(row.title, row.genre ? { genre: row.genre } : { q: row.query })}/>)}
    <section className="mh-originals"><Shelf title="Sakura originals">{SAKURA_ORIGINALS.map(item => <Link key={item.id} href={(item.type === 'novel' ? {pathname:'/novel/ext',params:{path:item.id}} : {pathname:'/anime/[id]',params:{id:item.id}}) as Href} asChild><a className="mh-card"><div className="mh-card-art"><CoverImage source={item.localImage} style={{width:'100%',height:'100%'}} contentFit="cover" accessibilityLabel=""/></div><h3>{item.title}</h3><p>{item.type === 'novel' ? 'Original novel' : 'Original anime'}</p></a></Link>)}</Shelf></section>
    <div className="mh-community" ref={belowFoldRef}>{showBelowFold && <>{props.community}{props.streak}</>}</div>
    <footer className="mh-footer"><span>Made for readers. <b>Made for you.</b></span><Link href="/creator-upload" asChild><a>Publish on Sakura <Arrow/></a></Link></footer>
  </div></main>;
}

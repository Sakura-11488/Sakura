import React, { useRef, useState, useEffect, useImperativeHandle, type ReactNode } from 'react';
import { Link, useRouter, type Href } from 'expo-router';
import { useTheme } from '@/lib/theme';
import CoverImage from '@/components/ui/CoverImage';
import type { ContentItem } from '@/components/ui/ContentCard';
import type { CarouselItem } from '@/components/ui/FeaturedCarousel';
import { SAKURA_ORIGINALS } from '@/lib/sakura-originals';
import type { MangaHomeWebProps } from './MangaHomeWeb';
import './manga-home.web.css';

function Arrow({ back = false }: { back?: boolean }) { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d={back ? 'M20 12H4m6-6-6 6 6 6' : 'M4 12h16m-6-6 6 6-6 6'} /></svg>; }
function destination(item: ContentItem | CarouselItem): Href { return { pathname: `/${item.type}/[id]`, params: { id: item.id, ...(item.type === 'manga' && item.source ? { source: item.source } : {}) } } as Href; }
function unique(items: ContentItem[]) { return items.filter((item, index) => items.findIndex(other => other.id === item.id && other.source === item.source) === index); }
function MangaPoster({ item, category = 'Manga' }: { item: ContentItem; category?: string }) {
  return <Link href={destination(item)} asChild><a className="mh-card"><div className="mh-card-art"><CoverImage source={{ uri: item.cover }} style={{ width: '100%', height: '100%' }} contentFit="cover" accessibilityLabel="" loading="lazy" />{typeof item.score === 'number' && item.score > 0 && <span className="mh-card-rating">★ {item.score.toFixed(1)}</span>}</div><h3>{item.title}</h3><p>{category}</p></a></Link>;
}
function Shelf({ title, items, category, onBrowse, children }: { title: string; items?: ContentItem[]; category?: string; onBrowse?: () => void; children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [arrows, setArrows] = useState({ left: false, right: false });
  useEffect(() => {
    const rail = ref.current; if (!rail) return;
    const update = () => setArrows({ left: rail.scrollLeft > 2, right: rail.scrollLeft + rail.clientWidth < rail.scrollWidth - 2 });
    const observer = new ResizeObserver(update); observer.observe(rail); rail.addEventListener('scroll', update, { passive: true }); update();
    return () => { observer.disconnect(); rail.removeEventListener('scroll', update); };
  }, [items, children]);
  const scroll = (direction: number) => ref.current?.scrollBy({ left: direction * ref.current.clientWidth * .85, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  return <section className="mh-shelf"><div className="mh-section-heading"><h2>{title}<span>.</span></h2><div className="mh-shelf-actions">{onBrowse && <button className="mh-text-button" onClick={onBrowse}>View all <Arrow /></button>}<div className="mh-scroll-buttons"><button onClick={() => scroll(-1)} disabled={!arrows.left} aria-label={`Scroll ${title} left`}><Arrow back /></button><button onClick={() => scroll(1)} disabled={!arrows.right} aria-label={`Scroll ${title} right`}><Arrow /></button></div></div></div><div className="mh-rail" ref={ref}>{items?.map(item => <MangaPoster key={`${item.source}-${item.id}`} item={item} category={category} />)}{children}</div></section>;
}
export default function MangaHomeWeb(props: MangaHomeWebProps) {
  const { isDark } = useTheme(); const router = useRouter(); const mainRef = useRef<HTMLElement>(null);
  const [query, setQuery] = useState('');
  const [featureIndex, setFeatureIndex] = useState(0);
  useImperativeHandle(props.scrollRef, () => ({ scrollToTop: () => mainRef.current?.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }) }), []);
  useEffect(() => { setFeatureIndex(0); }, [props.category]);
  const featured = props.featured.slice(0, 3); const top = featured[featureIndex] || featured[0];
  const popular = unique(props.popular); const trending = unique([...props.trending, ...props.picks]);
  const more = unique(props.more).filter(item => !popular.some(other => other.id === item.id));
  const search = (event: React.FormEvent) => { event.preventDefault(); router.push({ pathname: '/(tabs)/search', params: { q: query.trim(), searchRequest: String(Date.now()) } } as Href); };
  const random = () => { const pool = [...popular, ...trending]; if (pool.length) router.push(destination(pool[Math.floor(Math.random() * pool.length)])); };
  return <main ref={mainRef} className={`manga-home-web ${isDark ? '' : 'mh-light'}`} aria-label="Manga discovery"><div className="mh-container">
    <header className="mh-masthead"><div><p className="mh-collection">The reading room <span aria-hidden="true">漫画</span></p><h1>Manga<span> & more.</span></h1></div><form className="mh-search" role="search" onSubmit={search}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="10" cy="10" r="6" /><path d="m15 15 6 6" /></svg><input type="search" aria-label="Search Sakura" placeholder="Find a series…" value={query} onChange={event => setQuery(event.target.value)} /><button aria-label="Search titles" type="submit"><Arrow /></button></form></header>
    <div className="mh-source-row"><div className="mh-source-tabs" role="group" aria-label="Story collection">{props.categories.map(category => <button key={category} onClick={() => props.onCategory(category)} aria-pressed={props.category === category}>{category}</button>)}</div><button className="mh-surprise" disabled={props.loading || !popular.length} onClick={random}><span aria-hidden="true">↝</span> Surprise me</button></div>
    <div className="mh-opening"><section className="mh-feature" aria-label="Featured series" aria-busy={props.loading}>
      <div className="mh-feature-copy"><span className="mh-feature-tag">In {props.category.toLowerCase()}</span><h2>{props.loading ? 'Finding a good read…' : top?.title || 'The catalog is taking a moment.'}</h2>{top && !props.loading && <p>{top.genres.filter(genre => genre.toLowerCase() !== props.category.toLowerCase()).slice(0,3).join(' · ') || 'From the trending collection'}</p>}{top && !props.loading ? <Link href={destination(top)} asChild><a className="mh-primary">Open series <Arrow /></a></Link> : <button className="mh-primary" onClick={props.onRefresh}>Refresh <Arrow /></button>}
      <div className="mh-feature-pagination" role="group" aria-label="Featured titles">{featured.map((item,index) => <button key={item.id} aria-label={`Feature ${item.title}`} aria-pressed={featureIndex === index} onClick={() => setFeatureIndex(index)}>{String(index+1).padStart(2,'0')}</button>)}</div></div>
      <div className="mh-feature-cover">{top && !props.loading && <CoverImage source={top.localCover || {uri:top.cover}} style={{width:'100%',height:'100%'}} contentFit="cover" loading="eager" priority="high" thumbnailWidth={512} accessibilityLabel="" />}</div>
    </section><aside className="mh-hotlist" aria-label="Trending manga"><div className="mh-hotlist-heading"><h2>Trending now</h2><span className="mh-pink-star" aria-hidden="true">✳</span></div>{trending.slice(0,4).map((item,index) => <Link href={destination(item)} asChild key={`${item.source}-${item.id}`}><a className="mh-ranked"><span className="mh-rank">{String(index+1).padStart(2,'0')}</span><div className="mh-rank-cover"><CoverImage source={{uri:item.cover}} style={{width:'100%',height:'100%'}} contentFit="cover" accessibilityLabel="" thumbnailWidth={256}/></div><div><h3>{item.title}</h3><span>{props.category}</span></div><Arrow /></a></Link>)}{props.loading && <p className="mh-quiet" role="status">Loading the latest titles…</p>}<button className="mh-text-button" onClick={() => props.onBrowse('Trending '+props.category,{kind:'trending'})}>Browse trending <Arrow /></button></aside></div>
    <div className="mh-resume">{props.continueReading}</div>
    {props.loading ? <section className="mh-shelf" role="status" aria-label="Loading stories"><div className="mh-section-heading"><h2>Popular series<span>.</span></h2></div><div className="mh-rail">{Array.from({length:6},(_,i)=><div key={i} className="mh-skeleton"/>)}</div></section> : popular.length ? <Shelf title="Popular series" items={popular} category={props.category} onBrowse={() => props.onBrowse('Popular '+props.category,{kind:'popular'})}/> : <section className="mh-empty"><h2>This shelf couldn’t load.</h2><p>Try again or choose another collection.</p><button className="mh-primary" onClick={props.onRefresh}>Try again <Arrow/></button></section>}
    {!props.loading && more.length > 0 && <Shelf title="Further down the shelf" items={more} category={props.category} onBrowse={() => props.onBrowse('More '+props.category,{kind:'popular'})}/>}
    <section className="mh-originals"><Shelf title="Sakura originals">{SAKURA_ORIGINALS.map(item => <Link key={item.id} href={(item.type === 'novel' ? {pathname:'/novel/ext',params:{path:item.id}} : {pathname:'/anime/[id]',params:{id:item.id}}) as Href} asChild><a className="mh-card"><div className="mh-card-art"><CoverImage source={item.localImage} style={{width:'100%',height:'100%'}} contentFit="cover" accessibilityLabel=""/></div><h3>{item.title}</h3><p>{item.type === 'novel' ? 'Original novel' : 'Original anime'}</p></a></Link>)}</Shelf></section>
    <div className="mh-community">{props.community}{props.streak}</div>
    <footer className="mh-footer"><span>Made for readers. <b>Made for you.</b></span><Link href="/creator-upload" asChild><a>Publish on Sakura <Arrow/></a></Link></footer>
  </div></main>;
}

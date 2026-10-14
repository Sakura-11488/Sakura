import React, { useMemo, useState } from 'react';
import { Link, type Href } from 'expo-router';
import { useTheme } from '@/lib/theme';
import CoverImage from '@/components/ui/CoverImage';
import type { ContentItem } from '@/components/ui/ContentCard';
import { hoverMangaTitle, leaveMangaTitle, prefetchMangaTitle } from '@/lib/manga-prefetch';
import type { BrowseCatalogWebProps } from './BrowseCatalogWeb';
import './browse-catalog.web.css';
/**
 * Warm a manga title's page on hover, keyboard focus or press, the moments
 * that announce a click. Intent only: a grid shows dozens of cards at once, so
 * prefetching what is merely visible would be dozens of requests — and for
 * the same reason a hover counts only once the pointer rests on the card
 * (HOVER_INTENT_MS), not as it crosses the grid. lib/manga-prefetch skips
 * other types and 18+ titles.
 */
function intentHandlers(item: ContentItem) {
  return {
    onPointerEnter: () => hoverMangaTitle(item),
    onPointerLeave: () => leaveMangaTitle(item),
    onFocus: () => prefetchMangaTitle(item, 'intent'),
    onPointerDown: () => prefetchMangaTitle(item, 'intent', { pressed: true }),
  };
}
/** What a card is, by where it came from: every manhwa card used to say "Manga". */
function cardLabel(item: ContentItem): string {
  if (item.type === 'anime') return 'Anime';
  if (item.type === 'novel') return 'Novel';
  if (item.source === 'manhwa') return 'Manhwa';
  if (item.source === 'comics') return 'Comic';
  return 'Manga';
}
const SOURCE_NAMES: Record<string, string> = { manga: 'Manga library', manhwa: 'Manhwa', comics: 'Comics' };
export default function BrowseCatalogWeb(props: BrowseCatalogWebProps) {
  const {isDark} = useTheme(); const [filter,setFilter] = useState(''); const [sort,setSort] = useState('source');
  const f = props.filters;
  const items = useMemo(()=>{ const filtered=props.items.filter(item=>item.title.toLowerCase().includes(filter.trim().toLowerCase())); return sort==='title' ? [...filtered].sort((a,b)=>a.title.localeCompare(b.title)) : filtered; },[props.items,filter,sort]);
  // data-cover-root: covers measure their lookahead against this scroller (CoverImage.web).
  return <main data-cover-root="" className={`browse-catalog-web ${isDark ? '' : 'bc-light'}`}><div className="bc-shell"><button className="bc-back" onClick={props.onBack}>← Back to browsing</button><header><p>{props.eyebrow ?? SOURCE_NAMES[props.source] ?? props.source}</p><h1>{props.title}<span>.</span></h1>
      {f && <div className="bc-filters">
        <label><span>Genre</span><select aria-label="Genre" value={f.value.genre} onChange={event=>f.onChange({ genre: event.target.value })}><option value="">All genres</option>{f.genres.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}</select></label>
        <label><span>Status</span><select aria-label="Publication status" value={f.value.status} onChange={event=>f.onChange({ status: event.target.value })}><option value="">Any status</option>{f.statuses.map(st=><option key={st} value={st}>{st}</option>)}</select></label>
        <label><span>Sort by</span><select aria-label="Sort by" value={f.value.sort || (f.value.genre || f.value.status ? f.sorts[0]?.id : '')} onChange={event=>f.onChange({ sort: event.target.value })}>{!(f.value.genre || f.value.status || f.value.sort) && <option value="">Shelf order</option>}{f.sorts.map(so=><option key={so.id} value={so.id}>{so.label}</option>)}</select></label>
      </div>}
      <div className="bc-toolbar"><label><span>Filter this shelf</span><input aria-label="Filter this shelf" type="search" placeholder="Find a title…" value={filter} onChange={event=>setFilter(event.target.value)} /></label><label><span>Order</span><select aria-label="Shelf order" value={sort} onChange={event=>setSort(event.target.value)}><option value="source">{f ? 'As sorted' : 'Catalog order'}</option><option value="title">Title, A–Z</option></select></label><p role="status">{props.loading ? 'Loading…' : typeof props.found === 'number' && !filter ? `${items.length.toLocaleString()} of ${props.found.toLocaleString()} titles` : `${items.length} titles`}</p></div></header>
    {props.error && <div className="bc-error" role="alert"><p>{props.error}</p><button onClick={props.onRetry}>Try again</button></div>}
    <div className="bc-grid" aria-busy={props.loading}>{props.loading ? Array.from({length:12},(_,i)=><div className="bc-skeleton" key={i}/>) : items.map(item=><Link key={`${item.source}-${item.id}`} href={{pathname:`/${item.type}/[id]`,params:{id:item.id,...(item.source?{source:item.source}:{})}} as Href} asChild><a className="bc-card" {...intentHandlers(item)}><div><CoverImage source={{uri:item.cover}} style={{width:'100%',height:'100%'}} contentFit="cover" loading="lazy" accessibilityLabel=""/>{typeof item.score === 'number' && item.score > 0 && <span className="bc-rating">★ {item.score.toFixed(1)}</span>}</div><h2>{item.title}</h2><p>{props.badgeSubtitle && item.badge ? item.badge : cardLabel(item)}</p></a></Link>)}</div>
    {!props.loading && !items.length && !props.error && <div className="bc-empty"><h2>{filter ? 'No titles match this search.' : 'This shelf is empty for now.'}</h2>{filter && <button onClick={()=>setFilter('')}>Clear filter</button>}</div>}
    {!props.loading && props.hasMore && <button className="bc-more" disabled={props.loadingMore} onClick={props.onLoadMore}>{props.loadingMore ? 'Loading more…' : filter ? 'Search more of the catalog' : 'Load more titles'} ↓</button>}
  </div></main>;
}

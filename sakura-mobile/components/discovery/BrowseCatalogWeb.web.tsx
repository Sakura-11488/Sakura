import React, { useMemo, useState } from 'react';
import { Link, type Href } from 'expo-router';
import { useTheme } from '@/lib/theme';
import CoverImage from '@/components/ui/CoverImage';
import type { BrowseCatalogWebProps } from './BrowseCatalogWeb';
import './browse-catalog.web.css';
export default function BrowseCatalogWeb(props: BrowseCatalogWebProps) {
  const {isDark} = useTheme(); const [filter,setFilter] = useState(''); const [sort,setSort] = useState('source');
  const items = useMemo(()=>{ const filtered=props.items.filter(item=>item.title.toLowerCase().includes(filter.trim().toLowerCase())); return sort==='title' ? [...filtered].sort((a,b)=>a.title.localeCompare(b.title)) : filtered; },[props.items,filter,sort]);
  return <main className={`browse-catalog-web ${isDark ? '' : 'bc-light'}`}><div className="bc-shell"><button className="bc-back" onClick={props.onBack}>← Back to browsing</button><header><p>{props.source === 'manga' ? 'Manga library' : props.source}</p><h1>{props.title}<span>.</span></h1><div className="bc-toolbar"><label><span>Filter this shelf</span><input aria-label="Filter this shelf" type="search" placeholder="Find a title…" value={filter} onChange={event=>setFilter(event.target.value)} /></label><label><span>Order</span><select aria-label="Shelf order" value={sort} onChange={event=>setSort(event.target.value)}><option value="source">Catalog order</option><option value="title">Title, A–Z</option></select></label><p role="status">{props.loading ? 'Loading…' : `${items.length} titles`}</p></div></header>
    {props.error && <div className="bc-error" role="alert"><p>{props.error}</p><button onClick={props.onRetry}>Try again</button></div>}
    <div className="bc-grid" aria-busy={props.loading}>{props.loading ? Array.from({length:12},(_,i)=><div className="bc-skeleton" key={i}/>) : items.map(item=><Link key={`${item.source}-${item.id}`} href={{pathname:`/${item.type}/[id]`,params:{id:item.id,...(item.source?{source:item.source}:{})}} as Href} asChild><a className="bc-card"><div><CoverImage source={{uri:item.cover}} style={{width:'100%',height:'100%'}} contentFit="cover" loading="lazy" accessibilityLabel=""/></div><h2>{item.title}</h2><p>{item.type === 'manga' ? 'Manga' : item.type === 'anime' ? 'Anime' : 'Novel'}</p></a></Link>)}</div>
    {!props.loading && !items.length && !props.error && <div className="bc-empty"><h2>{filter ? 'No titles match this search.' : 'This shelf is empty for now.'}</h2>{filter && <button onClick={()=>setFilter('')}>Clear filter</button>}</div>}
    {!props.loading && props.hasMore && <button className="bc-more" disabled={props.loadingMore} onClick={props.onLoadMore}>{props.loadingMore ? 'Loading more…' : filter ? 'Search more of the catalog' : 'Load more titles'} ↓</button>}
  </div></main>;
}

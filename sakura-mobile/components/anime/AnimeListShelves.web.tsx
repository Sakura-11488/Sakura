import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import CoverImage from '@/components/ui/CoverImage';
import { rememberAnimePreviews } from '@/lib/anime';
import { WATCHLIST_STATUSES, type WatchlistStatus } from '@/lib/anime-watchlist';
import type { AnimeListShelvesProps } from './AnimeListShelves';
import { discoveryStyles } from './discovery-styles';
import useAnimeLists from './useAnimeLists';

const listStyles = `
.anime-list-shelves .al-badge{position:absolute;left:7px;top:7px;z-index:1;padding:3px 7px;border-radius:999px;background:#ef9bb8;color:#29151f;font-size:9px;font-weight:750;letter-spacing:.6px}
.anime-list-shelves .al-filters{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;margin:-6px 0 16px;padding:2px}.anime-list-shelves .al-filters::-webkit-scrollbar{display:none}
.anime-list-shelves .al-filters button{flex:none;min-height:34px;padding:0 12px;border:1px solid var(--ad-line);border-radius:999px;background:none;font-size:11px;color:#bdb0c3}
.anime-list-shelves .al-filters button[aria-pressed=true]{border-color:#ef9bb855;background:#ef9bb814;color:#f6bfd4}
.anime-list-shelves .al-filters small{margin-left:6px;color:#8f8299;font-size:10px}
.anime-list-shelves .al-status{font-size:10px;color:var(--ad-accent);margin-bottom:5px}
@media(hover:hover){.anime-list-shelves .al-filters button:hover{background:#ffffff08}}
`;

function Rail({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  const rail = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState({ previous: false, next: false });
  useEffect(() => {
    const element = rail.current;
    if (!element) return;
    const update = () => {
      const previous = element.scrollLeft > 2;
      const next = element.scrollLeft + element.clientWidth < element.scrollWidth - 2;
      setBounds(current => current.previous === previous && current.next === next ? current : { previous, next });
    };
    update();
    element.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => { observer.disconnect(); element.removeEventListener('scroll', update); };
  }, [children]);
  const scroll = (direction: number) => rail.current?.scrollBy({ left: direction * 450, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  return <section className="ad-shelf" aria-label={title}>
    <div className="ad-section-heading"><div><h2>{title}</h2>{description && <p>{description}</p>}</div>
      <div className="ad-arrows"><button aria-label={`Scroll ${title} left`} disabled={!bounds.previous} onClick={() => scroll(-1)}>←</button><button aria-label={`Scroll ${title} right`} disabled={!bounds.next} onClick={() => scroll(1)}>→</button></div>
    </div>
    {children}
  </section>;
}

/**
 * "New episodes for you" and "My list" on the web Anime tab. Both render
 * nothing until there is something to show, so a new viewer's tab is unchanged.
 */
export default function AnimeListShelves({ section }: AnimeListShelvesProps) {
  const router = useRouter();
  const { entries, newEpisodes } = useAnimeLists(section === 'new');
  const [filter, setFilter] = useState<WatchlistStatus | 'all'>('all');
  const counts = useMemo(() => {
    const map = new Map<WatchlistStatus, number>();
    for (const entry of entries) map.set(entry.status, (map.get(entry.status) ?? 0) + 1);
    return map;
  }, [entries]);
  const visible = filter === 'all' ? entries : entries.filter(entry => entry.status === filter);
  // A filter whose last title was removed falls back to everything.
  useEffect(() => { if (filter !== 'all' && !counts.get(filter)) setFilter('all'); }, [counts, filter]);

  const openTitle = (id: string, title: string, image: string) => {
    rememberAnimePreviews([{ id, title, image }]);
    router.push({ pathname: '/anime/[id]', params: { id } });
  };

  if (section === 'new') {
    if (!newEpisodes.length) return null;
    return <div className="anime-discovery-panels anime-list-shelves"><style>{discoveryStyles}{listStyles}</style>
      <Rail title="New episodes for you" description="Shows you’re keeping up with have aired something you haven’t seen.">
        <div className="ad-rail">{newEpisodes.map(item => <button className="ad-card" key={item.animeId}
          aria-label={`${item.title}: play episode ${item.nextEpisode}${item.newCount > 1 ? `, ${item.newCount} new episodes` : ''}`}
          onClick={() => {
            rememberAnimePreviews([{ id: item.animeId, title: item.title, image: item.cover }]);
            router.push({ pathname: '/anime/watch', params: { id: item.animeId, ep: `mal-${item.animeId}-${item.nextEpisode}` } });
          }}>
          <span className="ad-cover"><span className="al-badge">NEW · EP {item.latestAired}</span>{item.cover ? <CoverImage source={{ uri: item.cover }} style={{ width: '100%', height: '100%' }} contentFit="cover" thumbnailWidth={256} /> : <span className="ad-cover-placeholder">SAKURA</span>}<span className="ad-card-play" aria-hidden="true">▶</span></span>
          <strong>{item.title}</strong>
          <span className="ad-card-meta">{item.newCount > 1 ? `${item.newCount} new · start with Ep ${item.nextEpisode}` : `Episode ${item.nextEpisode} is out`}</span>
        </button>)}</div>
      </Rail>
    </div>;
  }

  if (!entries.length) return null;
  const label = (status: WatchlistStatus) => WATCHLIST_STATUSES.find(entry => entry.value === status)?.label ?? status;
  return <div className="anime-discovery-panels anime-list-shelves"><style>{discoveryStyles}{listStyles}</style>
    <Rail title="My list" description="Everything you’re watching, planning, holding or done with.">
      <div className="al-filters" role="group" aria-label="Filter my list">
        <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All<small>{entries.length}</small></button>
        {WATCHLIST_STATUSES.filter(status => counts.get(status.value)).map(status => <button type="button" key={status.value} aria-pressed={filter === status.value} onClick={() => setFilter(status.value)}>{status.label}<small>{counts.get(status.value)}</small></button>)}
      </div>
      <div className="ad-rail">{visible.map(entry => <button className="ad-card" key={entry.animeId} onClick={() => openTitle(entry.animeId, entry.title, entry.cover)}>
        <span className="ad-cover">{entry.cover ? <CoverImage source={{ uri: entry.cover }} style={{ width: '100%', height: '100%' }} contentFit="cover" thumbnailWidth={256} /> : <span className="ad-cover-placeholder">SAKURA</span>}<span className="ad-card-play" aria-hidden="true">▶</span></span>
        {filter === 'all' && <span className="al-status">{label(entry.status)}</span>}
        <strong>{entry.title || 'Untitled'}</strong>
      </button>)}</div>
    </Rail>
  </div>;
}

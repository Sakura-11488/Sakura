import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { rememberAnimePreviews } from '@/lib/anime';
import { chooseDiscoverySeeds, fetchAnimeDiscovery } from '@/lib/anime-discovery';
import { getAllWatchHistory } from '@/lib/watch-progress';
import { Library } from '@/lib/storage';
import CoverImage from '@/components/ui/CoverImage';
import type { AnimeResult } from '@/lib/anime';
import type { AnimeDiscoveryPanelsProps } from './AnimeDiscoveryPanels';
import { discoveryStyles } from './discovery-styles';

type Shelf = { title: string; description: string; items: Array<AnimeResult & { relation?: string }> };
function ShelfRow({ shelf }: { shelf: Shelf }) {
  const router = useRouter();
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
  }, [shelf.items]);
  return <section className="ad-shelf" aria-label={shelf.title}>
    <div className="ad-section-heading"><div><h2>{shelf.title}</h2>{shelf.description && <p>{shelf.description}</p>}</div>
      <div className="ad-arrows"><button aria-label={`Scroll ${shelf.title} left`} disabled={!bounds.previous} onClick={() => rail.current?.scrollBy({ left: -450, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })}>←</button><button aria-label={`Scroll ${shelf.title} right`} disabled={!bounds.next} onClick={() => rail.current?.scrollBy({ left: 450, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })}>→</button></div>
    </div>
    <div className="ad-rail" ref={rail}>{shelf.items.map(item => <button className="ad-card" key={item.id} onClick={() => { rememberAnimePreviews([item]); router.push({ pathname: '/anime/[id]', params: { id: item.id } }); }}>
      <span className="ad-cover">{item.image ? <CoverImage source={{ uri: item.image }} style={{ width: '100%', height: '100%' }} contentFit="cover" thumbnailWidth={256} /> : <span className="ad-cover-placeholder">SAKURA</span>}<span className="ad-card-play" aria-hidden="true">▶</span></span>
      {item.relation && <span className="ad-relation">{item.relation}</span>}<strong>{item.title}</strong><span className="ad-card-meta">{[item.type, item.year, item.score ? `★ ${item.score}` : undefined].filter(Boolean).join(' · ')}</span>
    </button>)}</div>
  </section>;
}

export default function AnimeDiscoveryPanels({ mode, animeId }: AnimeDiscoveryPanelsProps) {
  const [shelves, setShelves] = useState<Shelf[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [seedless, setSeedless] = useState(false);
  // Returning from an episode refreshes the seeds; progress ticks do not refetch.
  useFocusEffect(useCallback(() => {
    const controller = new AbortController();
    let disposed = false;
    setLoading(true); setError(''); setShelves([]); setSeedless(false);
    const load = async () => {
      if (mode === 'related') {
        if (!animeId) return;
        const result = await fetchAnimeDiscovery(animeId, { signal: controller.signal });
        const next: Shelf[] = [];
        if (result.relations.length) next.push({ title: 'Seasons & related titles', description: '', items: result.relations });
        if (result.recommendations.length) next.push({ title: 'More like this', description: '', items: result.recommendations.filter(item => item.id !== animeId).slice(0, 16) });
        if (!disposed) setShelves(next);
        return;
      }
      const [history, library] = await Promise.all([getAllWatchHistory(), Library.getAll()]);
      if (disposed) return;
      const seeds = chooseDiscoverySeeds(history, library);
      if (!seeds.length) { setSeedless(true); return; }
      const excluded = new Set([...history.map(item => item.animeId), ...library.filter(item => item.type === 'anime').map(item => item.id)]);
      const results = await Promise.allSettled(seeds.map(seed => fetchAnimeDiscovery(seed.id, { signal: controller.signal })));
      if (disposed) return;
      const next: Shelf[] = [];
      results.forEach((result, index) => {
        if (result.status !== 'fulfilled') return;
        const items = result.value.recommendations.filter(item => !excluded.has(item.id)).slice(0, 12);
        items.forEach(item => excluded.add(item.id));
        if (items.length) next.push({ title: `${seeds[index].reason === 'watched' ? 'Because you watched' : 'Inspired by your list ·'} ${seeds[index].title}`, description: '', items });
      });
      if (!next.length && results.every(result => result.status === 'rejected')) throw new Error('Recommendations are unavailable right now.');
      setShelves(next);
    };
    void load().catch(cause => { if (!disposed) setError(cause instanceof Error ? cause.message : 'Unable to load recommendations.'); }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; controller.abort(); };
  }, [mode, animeId, revision]));

  if (!loading && !error && (seedless || !shelves.length)) return null;
  return <div className="anime-discovery-panels"><style>{discoveryStyles}</style>
    {loading && <div className="ad-loading" role="status">Finding your next watch…</div>}
    {error && <div className="ad-message" role="status"><span>{error}</span><button onClick={() => setRevision(value => value + 1)}>Try again</button></div>}
    {shelves.map(shelf => <ShelfRow key={shelf.title} shelf={shelf} />)}
  </div>;
}

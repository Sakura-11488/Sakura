import React, { useCallback, useRef, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
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
  return <section className="ad-shelf" aria-label={shelf.title}>
    <div className="ad-section-heading"><div><h2>{shelf.title}</h2><p>{shelf.description}</p></div>
      <div className="ad-arrows"><button aria-label={`Scroll ${shelf.title} left`} onClick={() => rail.current?.scrollBy({ left: -450, behavior: 'smooth' })}>←</button><button aria-label={`Scroll ${shelf.title} right`} onClick={() => rail.current?.scrollBy({ left: 450, behavior: 'smooth' })}>→</button></div>
    </div>
    <div className="ad-rail" ref={rail}>{shelf.items.map(item => <button className="ad-card" key={item.id} onClick={() => router.push({ pathname: '/anime/[id]', params: { id: item.id } })}>
      <span className="ad-cover">{item.image ? <CoverImage source={{ uri: item.image }} style={{ width: '100%', height: '100%' }} contentFit="cover" thumbnailWidth={256} /> : <span className="ad-cover-placeholder">SAKURA</span>}<span className="ad-card-play" aria-hidden="true">▶</span></span>
      {item.relation && <span className="ad-relation">{item.relation}</span>}<strong>{item.title}</strong><span className="ad-card-meta">{[item.type, item.year, item.score ? `★ ${item.score}` : undefined].filter(Boolean).join(' · ')}</span>
    </button>)}</div>
  </section>;
}

export default function AnimeDiscoveryPanels({ mode, animeId }: AnimeDiscoveryPanelsProps) {
  const router = useRouter();
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
        if (result.relations.length) next.push({ title: 'Seasons & related stories', description: 'Explore this world in the order that suits you.', items: result.relations });
        if (result.recommendations.length) next.push({ title: 'More like this', description: 'Recommendations from viewers of this series.', items: result.recommendations.filter(item => item.id !== animeId).slice(0, 16) });
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
        if (items.length) next.push({ title: `${seeds[index].reason === 'watched' ? 'Because you watched' : 'Inspired by your list ·'} ${seeds[index].title}`, description: 'Picked from your viewing and saved titles. Updated as your tastes change.', items });
      });
      if (!next.length && results.every(result => result.status === 'rejected')) throw new Error('Recommendations are unavailable right now.');
      setShelves(next);
    };
    void load().catch(cause => { if (!disposed) setError(cause instanceof Error ? cause.message : 'Unable to load recommendations.'); }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; controller.abort(); };
  }, [mode, animeId, revision]));

  if (mode === 'related' && !loading && !error && !shelves.length) return null;
  return <div className="anime-discovery-panels"><style>{discoveryStyles}</style>
    {mode === 'personal' && <div className="ad-calendar-promo"><div><span className="ad-eyebrow">KEEP UP WITH YOUR FAVORITES</span><strong>A new week. A new episode.</strong><p>Explore the broadcast schedule in your time zone.</p></div><button className="ad-action" onClick={() => router.push('/anime/schedule' as any)}>Weekly schedule <span aria-hidden="true">↗</span></button></div>}
    {loading && <div className="ad-loading" role="status">Finding your next watch…</div>}
    {error && <div className="ad-message" role="status"><span>{error}</span><button onClick={() => setRevision(value => value + 1)}>Try again</button></div>}
    {!loading && seedless && <div className="ad-message"><span><strong>Your next favorite starts here.</strong><br />Watch or save a series to get recommendations shaped by your taste.</span><button onClick={() => router.push('/anime' as any)}>Explore anime</button></div>}
    {!loading && !error && !seedless && mode === 'personal' && !shelves.length && <div className="ad-message"><span><strong>No new suggestions yet.</strong><br />Watch or save another series to discover more titles.</span><button onClick={() => router.push('/anime' as any)}>Explore anime</button></div>}
    {shelves.map(shelf => <ShelfRow key={shelf.title} shelf={shelf} />)}
  </div>;
}

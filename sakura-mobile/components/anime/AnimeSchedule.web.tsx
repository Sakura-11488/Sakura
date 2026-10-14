import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { rememberAnimePreviews } from '@/lib/anime';
import { fetchAnimeScheduleWeek, shiftScheduleDays, startOfScheduleWeek, type ScheduleWeek } from '@/lib/anime-discovery';
import { Library } from '@/lib/storage';
import CoverImage from '@/components/ui/CoverImage';
import { discoveryStyles } from './discovery-styles';

export default function AnimeSchedule() {
  const router = useRouter();
  const [week, setWeek] = useState(() => startOfScheduleWeek());
  const [selectedDay, setSelectedDay] = useState(() => (new Date().getDay() + 6) % 7);
  const [data, setData] = useState<ScheduleWeek>({ episodes: [], partial: false });
  const [savedIds, setSavedIds] = useState<Set<string>>(() => new Set());
  const [savedOnly, setSavedOnly] = useState(false);
  const [upcomingOnly, setUpcomingOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 60000); return () => window.clearInterval(timer); }, []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone.replaceAll('_', ' ');
  useFocusEffect(useCallback(() => {
    let active = true;
    void Library.getAll().then(items => { if (active) setSavedIds(new Set(items.filter(item => item.type === 'anime').map(item => item.id))); });
    return () => { active = false; };
  }, []));
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setData({ episodes: [], partial: false });
    void fetchAnimeScheduleWeek(week, { signal: controller.signal, force: retry > 0 }).then(result => { if (!controller.signal.aborted) setData(result); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'The schedule is unavailable.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [week, retry]);
  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => {
    const start = shiftScheduleDays(week, index), end = shiftScheduleDays(week, index + 1);
    return { start, date: new Date(start), episodes: data.episodes.filter(episode => episode.airingAt >= start && episode.airingAt < end && (!savedOnly || savedIds.has(episode.id)) && (!upcomingOnly || episode.airingAt >= now) && (!query.trim() || episode.title.toLowerCase().includes(query.trim().toLowerCase()))).sort((a, b) => a.airingAt - b.airingAt) };
  }), [week, data, savedOnly, savedIds, upcomingOnly, now, query]);
  const current = days[selectedDay];
  const nextAiring = current.episodes.find(episode => episode.airingAt >= now)?.scheduleId;
  const range = `${new Date(week).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${new Date(shiftScheduleDays(week, 6)).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  const changeWeek = (direction: number) => { setWeek(previous => shiftScheduleDays(previous, direction * 7)); setRetry(0); };
  return <main className="anime-schedule"><style>{discoveryStyles}</style><div className="as-shell">
    <button className="as-back" onClick={() => router.dismissTo('/anime' as any)}>← Back to anime</button>
    <header className="as-hero"><div><h1>Release calendar</h1><p>Anime broadcasts, in your local time.</p></div><span className="as-zone">{zone}</span></header>
    <div className="as-toolbar"><div className="as-week"><button aria-label="Previous week" onClick={() => changeWeek(-1)}>←</button><strong aria-live="polite">{range}</strong><button aria-label="Next week" onClick={() => changeWeek(1)}>→</button><button onClick={() => { setWeek(startOfScheduleWeek()); setSelectedDay((new Date().getDay() + 6) % 7); setRetry(0); }}>Today</button></div>
      <div className="as-filters"><label className="as-title-search"><span className="as-sr-only">Search scheduled anime</span><input type="search" aria-label="Search scheduled anime" placeholder="Find a series" value={query} onChange={event => setQuery(event.target.value)} /></label><button className="as-filter-button" aria-pressed={savedOnly} onClick={() => setSavedOnly(value => !value)}>My library</button><button className="as-filter-button" aria-pressed={upcomingOnly} onClick={() => setUpcomingOnly(value => !value)}>Upcoming only</button></div></div>
    <nav className="as-days" aria-label="Schedule day">{days.map((day, index) => <button key={day.start} data-today={day.date.toDateString() === new Date(now).toDateString() || undefined} aria-pressed={selectedDay === index} onClick={() => setSelectedDay(index)} aria-label={`${day.date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}${day.date.toDateString() === new Date(now).toDateString() ? ", today" : ""}`}><span>{day.date.toLocaleDateString(undefined, { weekday: 'short' })}</span><strong>{day.date.getDate()}</strong><small>{loading ? '…' : `${day.episodes.length} airing`}</small></button>)}</nav>
    <div className="as-results-heading"><h2>{current.date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</h2><span>{!loading && !error ? `${current.episodes.length} episodes` : ''}</span></div>
    {loading ? <div className="ad-loading" role="status">Loading this week’s schedule…</div> : error ? <div className="ad-message" role="status"><span>{error}</span><button onClick={() => setRetry(value => value + 1)}>Try again</button></div> : current.episodes.length ? <div className="as-grid">{current.episodes.map(episode => <button className="as-card" data-aired={episode.airingAt < now || undefined} data-next={episode.scheduleId === nextAiring || undefined} key={episode.scheduleId} onClick={() => { rememberAnimePreviews([episode]); router.push({ pathname: '/anime/[id]', params: { id: episode.id } }); }}>
      {episode.image && <span className="as-cover"><CoverImage source={{ uri: episode.image }} style={{ width: '100%', height: '100%' }} contentFit="cover" thumbnailWidth={256} /></span>}<span className="as-card-copy"><time dateTime={new Date(episode.airingAt).toISOString()}>{new Date(episode.airingAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}<span>{episode.airingAt < now ? 'Aired' : episode.scheduleId === nextAiring ? 'Up next' : 'Scheduled'}</span></time><strong>{episode.title}</strong><span>Episode {episode.episode}{episode.type ? ` · ${episode.type}` : ''}</span>{savedIds.has(episode.id) && <span className="as-in-library">✓ In your Library</span>}</span>
    </button>)}</div> : <div className="as-empty"><strong>{query || savedOnly || upcomingOnly ? 'No broadcasts match your filters.' : 'Nothing scheduled for this day.'}</strong>{query || savedOnly || upcomingOnly ? <>Try another day, or <button className="as-clear-filters" onClick={() => { setQuery(''); setSavedOnly(false); setUpcomingOnly(false); }}>clear the filters</button>.</> : 'Try another day or week. Future broadcasts may not be announced yet.'}</div>}
    <p className="as-note">Broadcast times from AniList. Schedules, streaming availability and dubbed release dates can differ.{data.partial ? ' Showing the first 300 broadcasts for this week.' : ''}</p>
  </div></main>;
}

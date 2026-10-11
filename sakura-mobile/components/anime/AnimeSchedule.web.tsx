import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
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
    return { start, date: new Date(start), episodes: data.episodes.filter(episode => episode.airingAt >= start && episode.airingAt < end && (!savedOnly || savedIds.has(episode.id))) };
  }), [week, data, savedOnly, savedIds]);
  const current = days[selectedDay];
  const range = `${new Date(week).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${new Date(shiftScheduleDays(week, 6)).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  const changeWeek = (direction: number) => { setWeek(previous => shiftScheduleDays(previous, direction * 7)); setRetry(0); };
  return <main className="anime-schedule"><style>{discoveryStyles}</style><div className="as-shell">
    <button className="as-back" onClick={() => router.dismissTo('/anime' as any)}>← Back to anime</button>
    <header className="as-hero"><div><span className="ad-eyebrow">YOUR WEEK IN ANIME</span><h1>Make room for<br />your next episode.</h1><p>Follow the weekly broadcast schedule. All times adjust to your time zone; streaming availability and dubbed releases can differ.</p></div><span className="as-zone">◷ {zone}</span></header>
    <div className="as-toolbar"><div className="as-week"><button aria-label="Previous week" onClick={() => changeWeek(-1)}>←</button><strong aria-live="polite">{range}</strong><button aria-label="Next week" onClick={() => changeWeek(1)}>→</button><button onClick={() => { setWeek(startOfScheduleWeek()); setSelectedDay((new Date().getDay() + 6) % 7); setRetry(0); }}>Today</button></div>
      <label className="as-saved"><input type="checkbox" checked={savedOnly} onChange={event => setSavedOnly(event.target.checked)} />Only my saved shows</label></div>
    <nav className="as-days" aria-label="Schedule day">{days.map((day, index) => <button key={day.start} aria-pressed={selectedDay === index} onClick={() => setSelectedDay(index)} aria-label={day.date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}><span>{day.date.toLocaleDateString(undefined, { weekday: 'short' })}</span><strong>{day.date.getDate()}</strong><small>{loading ? '…' : `${day.episodes.length} airing`}</small></button>)}</nav>
    <div className="as-results-heading"><h2>{current.date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</h2><span>{!loading && !error ? `${current.episodes.length} episodes` : ''}</span></div>
    {loading ? <div className="ad-loading" role="status">Loading this week’s schedule…</div> : error ? <div className="ad-message" role="status"><span>{error}</span><button onClick={() => setRetry(value => value + 1)}>Try again</button></div> : current.episodes.length ? <div className="as-grid">{current.episodes.map(episode => <button className="as-card" key={episode.scheduleId} onClick={() => router.push({ pathname: '/anime/[id]', params: { id: episode.id } })}>
      {episode.image && <span className="as-cover"><CoverImage source={{ uri: episode.image }} style={{ width: '100%', height: '100%' }} contentFit="cover" thumbnailWidth={256} /></span>}<span className="as-card-copy"><time dateTime={new Date(episode.airingAt).toISOString()}>{new Date(episode.airingAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}{episode.airingAt < Date.now() ? ' · Aired' : ''}</time><strong>{episode.title}</strong><span>Episode {episode.episode}{episode.type ? ` · ${episode.type}` : ''}</span>{savedIds.has(episode.id) && <span className="as-in-library">✓ In your Library</span>}</span>
    </button>)}</div> : <div className="as-empty"><strong>{savedOnly ? 'A quiet day for your Library.' : 'Nothing scheduled for this day.'}</strong>{savedOnly ? 'Choose another day or turn off the saved-shows filter.' : 'Try another day or week. Future broadcasts may not be announced yet.'}</div>}
    <p className="as-note">Broadcast information from AniList. Schedules can change.{data.partial ? ' Showing the first 300 broadcasts for this week.' : ''}</p>
  </div></main>;
}

import React, { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import { fetchAnimeScheduleWeek, startOfScheduleWeek, type ScheduledEpisode } from '@/lib/anime-discovery';
import { useTheme } from '@/lib/theme';

export default function AnimeSchedule() {
  const router = useRouter(), { colors } = useTheme();
  const [episodes, setEpisodes] = useState<ScheduledEpisode[]>([]);
  const [error, setError] = useState(''), [loading, setLoading] = useState(true), [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    void fetchAnimeScheduleWeek(startOfScheduleWeek(), { signal: controller.signal, force: retry > 0 }).then(result => { if (!controller.signal.aborted) setEpisodes(result.episodes); })
      .catch(() => { if (!controller.signal.aborted) setError('Unable to load the schedule.'); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [retry]);
  return <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ padding: 24, paddingBottom: 80 }}>
    <TouchableOpacity onPress={() => router.back()} accessibilityRole="button"><Text style={{ color: colors.primary, paddingVertical: 14 }}>← Back</Text></TouchableOpacity>
    <Text style={{ color: colors.text, fontSize: 30, fontWeight: '700', marginBottom: 12 }}>This week in anime</Text>
    <Text style={{ color: colors.textSecondary, marginBottom: 20 }}>Broadcast times in your time zone. Streaming and dubbed releases can differ.</Text>
    {loading ? <ActivityIndicator color={colors.primary} /> : error ? <TouchableOpacity onPress={() => setRetry(value => value + 1)} accessibilityRole="button"><Text style={{ color: colors.primary }}>{error} Tap to retry.</Text></TouchableOpacity> : episodes.length ? episodes.map(episode => <TouchableOpacity key={episode.scheduleId} onPress={() => router.push({ pathname: '/anime/[id]', params: { id: episode.id } })} style={{ borderBottomWidth: 1, borderBottomColor: colors.border, paddingVertical: 15 }} accessibilityRole="button"><View><Text style={{ color: colors.text, fontWeight: '700' }}>{episode.title}</Text><Text style={{ color: colors.textSecondary, marginTop: 5 }}>Episode {episode.episode} · {new Date(episode.airingAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</Text></View></TouchableOpacity>) : <Text style={{ color: colors.textSecondary }}>No broadcasts announced for this week.</Text>}
  </ScrollView>;
}

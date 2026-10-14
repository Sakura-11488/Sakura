import React from 'react';
import { Redirect, useLocalSearchParams } from 'expo-router';

/**
 * `/search` (stack) and the Search tab used to be two different screens: on
 * native this one was an older search over manga, anime and novels only, with
 * four hard-coded "recent" titles and no manhwa, comics, people, filters or
 * progressive results. Both entry points now open the Search tab, on every
 * platform, carrying the query and focus requests across.
 */
export default function SearchRedirect() {
  const params = useLocalSearchParams<{ q?: string; focus?: string; searchRequest?: string }>();
  return <Redirect href={{ pathname: '/(tabs)/search', params: { ...(typeof params.q === 'string' ? { q: params.q } : {}), ...(typeof params.searchRequest === 'string' ? { searchRequest: params.searchRequest } : {}), ...(typeof params.focus === 'string' ? { focus: params.focus } : {}) } }} />;
}

import React from 'react';
import { Redirect, useLocalSearchParams } from 'expo-router';

/** Both entry points should open the complete browse screen on the web. */
export default function SearchWebRedirect() {
  const params = useLocalSearchParams<{ q?: string; focus?: string; searchRequest?: string }>();
  return <Redirect href={{ pathname: '/(tabs)/search', params: { ...(typeof params.q === 'string' ? { q: params.q } : {}), ...(typeof params.searchRequest === 'string' ? { searchRequest: params.searchRequest } : {}), ...(typeof params.focus === 'string' ? { focus: params.focus } : {}) } }} />;
}

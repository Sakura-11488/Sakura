import React from 'react';
import { Redirect } from 'expo-router';

/** Both entry points should open the complete browse screen on the web. */
export default function SearchWebRedirect() {
  return <Redirect href="/(tabs)/search" />;
}

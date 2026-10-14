import { Platform } from 'react-native';
import { fetchTrendingManga, fetchPopularManga, type AtsuItem } from '@/lib/manga';

/**
 * The Manga home's two lists, requested before the home screen asks for them.
 *
 * On a cold web load home only asked after its first render: measured at 4x
 * CPU on Fast 4G, the first request left ~80 ms after first paint, with the
 * network idle through the bundle's evaluation and that ~400 ms first render.
 * Anything that runs earlier can call startHomeListsPreload(); home's load
 * then takes these promises over (once) instead of asking again.
 *
 * Where it is called decides what it buys. home.tsx calls it at module scope,
 * but expo-router evaluates a route's module during the first render (probed
 * locally at 4x CPU: home's module ran ~20 ms before home's first commit), so
 * from there it gains little. Called from the web entry, before the router
 * mounts, it overlaps the lists with that whole render. Either way the request
 * itself still waits for supabase-js, whose functions.invoke awaits the auth
 * client's initialisation (auth.getSession) before it calls fetch.
 *
 * Web only, and only when the page being opened is home (or the app root,
 * which redirects there for anyone past the welcome screen): a deep link to a
 * title or chapter must not spend its first round trips on lists it will not
 * show. The same fetchers as home's own load, so the cache stores the answers
 * as usual.
 */
export interface HomeLists {
  trending: Promise<AtsuItem[]>;
  popular: Promise<AtsuItem[]>;
  at: number;
}

/** Older than this and home asks again (through the cache) rather than reuse it. */
const MAX_AGE_MS = 60_000;
/** What home's load asks for; the preload must ask for exactly the same. */
export const HOME_TRENDING_LIMIT = 32;
export const HOME_POPULAR_LIMIT = 20;

let lists: HomeLists | null = null;
let started = false;

function opensOnHome(): boolean {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return false;
  const path = window.location.pathname.replace(/\/+$/, '');
  return path === '/app' || path === '/app/home' || path === '' || path === '/home';
}

/** Idempotent; a no-op off web or away from home. */
export function startHomeListsPreload(): void {
  if (started || !opensOnHome()) return;
  started = true;
  const trending = fetchTrendingManga(HOME_TRENDING_LIMIT);
  const popular = fetchPopularManga(HOME_POPULAR_LIMIT);
  // Caught here so an early failure is never an unhandled rejection; home
  // still sees it through the original promises.
  trending.catch(() => {});
  popular.catch(() => {});
  lists = { trending, popular, at: Date.now() };
}

/** The preloaded lists, once: a refresh or a later visit asks afresh. */
export function takeHomeListsPreload(): HomeLists | null {
  const taken = lists;
  lists = null;
  return taken && Date.now() - taken.at < MAX_AGE_MS ? taken : null;
}

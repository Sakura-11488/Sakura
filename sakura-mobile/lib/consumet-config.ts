import { CONSUMET_URL_DEFAULT, CONSUMET_URL_LEGACY } from './content-hosts';

/**
 * Consumet endpoint list and the currently-selected base URL.
 *
 * This lives in its own module for one reason: **it must not have a platform
 * sibling.** `consumet-client.web.ts` used to import these three functions from
 * `@/lib/consumet-client`, intending to reach the base file and re-export its
 * shared state. On web, Metro resolves `consumet-client` to
 * `consumet-client.web.ts` — the importing file itself — so the re-export bound
 * to its own binding and every call recursed until the stack blew:
 *
 *     RangeError: Maximum call stack size exceeded
 *         at Object.get [as getActiveConsumetUrl]
 *         at Object.get [as getActiveConsumetUrl]   (×10000)
 *
 * Platform resolution does not care which file is doing the asking, so a
 * `.web` file can never safely import its own base name. The failure is silent
 * in the worst way: `consuGet` calls `consumetCandidates()` on its first line,
 * so **every Consumet request on web threw before it was sent**, and each caller
 * caught that and returned `[]` or `null` — indistinguishable from "the source
 * has nothing for this title". No request appeared in the network panel, because
 * none was ever made.
 *
 * Keep this file free of platform-specific imports and never add a
 * `consumet-config.web.ts`.
 */

export function consumetCandidates(): string[] {
  const fromEnv = (process.env.EXPO_PUBLIC_CONSUMET_URL || '').replace(/\/+$/, '');
  const list = [fromEnv, CONSUMET_URL_DEFAULT, CONSUMET_URL_LEGACY].filter(Boolean);
  return [...new Set(list)];
}

let activeConsumetUrl = consumetCandidates()[0] || CONSUMET_URL_DEFAULT;

export function getActiveConsumetUrl(): string {
  return activeConsumetUrl;
}

export function setActiveConsumetUrl(url: string): void {
  activeConsumetUrl = url;
}

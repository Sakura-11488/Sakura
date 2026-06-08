import { MANGA_SOURCE_IDS } from "./source-ids";

export const MANGA_SOURCE_ROLLOUT = {
    mode: "fallback",
    primarySource: MANGA_SOURCE_IDS.MANGADEX,
    fallbackSources: [MANGA_SOURCE_IDS.ATSUMARU],
    watchlistSources: [MANGA_SOURCE_IDS.COMIX, MANGA_SOURCE_IDS.MANGABALL],
    blockedSources: [MANGA_SOURCE_IDS.MANGAFIRE],
    rationale: "MangaDex remains the safest primary source because creator linking, genre browse, and stats are still wired to it. Atsumaru is the current best fallback from the live bakeoff, while Comix and MangaBall need more chapter/page parity work before promotion.",
} as const;

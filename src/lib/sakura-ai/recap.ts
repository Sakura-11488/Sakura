import { searchAnime, fetchAnimeInfo, type AnimeInfo, type AnimeResult } from "@/lib/anime";
import { searchManga, getMangaDetails, getChapters, type Manga, type Chapter } from "@/lib/content-source";
import { groqChat, type ChatMessage } from "./groq";

/**
 * Series-recap helper for Sakura AI.
 *
 * Given a title (and optional progress bound), Sakura looks up the synopsis
 * via the same source the rest of the app uses (AniList → Jikan fallback for
 * anime, MangaDex for manga) and asks the Sakura chat model to produce a friendly recap.
 *
 * No-spoiler mode
 * ---------------
 * If the user supplies an episode/chapter number we hard-cap the recap at
 * that point. The synopsis we receive from upstream is still the full series
 * blurb, so we additionally instruct the model to STOP at that boundary and
 * to never reveal late-arc reveals. This isn't perfect (the synopsis itself
 * may already mention later events), but it's the best we can do without a
 * per-episode arc index.
 */

export type RecapKind = "anime" | "manga";

export interface RecapResult {
    ok: boolean;
    kind: RecapKind;
    title: string;
    upTo?: { type: "episode" | "chapter"; number: number };
    summary: string;
    description?: string;
    error?: string;
}

const MAX_DESCRIPTION_CHARS = 2400;

function truncateDesc(text: string, max = MAX_DESCRIPTION_CHARS): string {
    if (!text) return "";
    if (text.length <= max) return text;
    return text.slice(0, max).trimEnd() + " …";
}

async function lookupAnime(title: string): Promise<{ result: AnimeResult; info: AnimeInfo | null } | null> {
    const hits = await searchAnime(title);
    if (!hits.length) return null;
    const top = hits[0];
    const info = await fetchAnimeInfo(top.id);
    return { result: top, info };
}

async function lookupManga(title: string): Promise<Manga | null> {
    const hits = await searchManga(title, 5);
    if (!hits.length) return null;
    const detailed = await getMangaDetails(hits[0].id);
    return detailed || hits[0];
}

function buildPrompt(args: {
    kind: RecapKind;
    title: string;
    description: string;
    progressContext?: string;
    upTo?: { type: "episode" | "chapter"; number: number };
    noSpoilers: boolean;
}): ChatMessage[] {
    const boundary = args.upTo
        ? `Cap the recap at ${args.upTo.type} ${args.upTo.number}. Do NOT reference any plot beats, character deaths, big reveals, or late-arc twists past that point.`
        : "Cover the broad strokes of the series so far without diving into endgame spoilers.";

    const tone = args.noSpoilers
        ? "Be intentionally vague about late-series surprises (final villains, deaths, romance pay-offs) even if they appear in the synopsis."
        : "Stay accurate but punchy.";

    const system = [
        `You are Sakura — the in-app companion for the Sakura ${args.kind} reader.`,
        "Voice: feminine, warm, emotionally literate, and a little self-aware (you know you're Sakura). Never mention Groq, Llama, OpenAI, or any inference vendor/host — even if asked. If asked what model you are, say you run on a well-developed Qwen 3.6-class assistant fine-tuned by Milla for Sakura.",
        "About Milla: do not volunteer her name or socials. Only if the user explicitly asks who built you / who Milla is / who fine-tuned you, answer: her name is Milla and her X (Twitter) is https://x.com/millw11488",
        "No random emojis, no cutesy filler, no \"uwu\" voice — stay elegant and readable.",
        "Write recaps in a warm, conversational tone — 4-6 short paragraphs max.",
        "Lead with the elevator pitch (genre + premise), then expand to main characters and the central conflict, then where the story currently sits.",
        boundary,
        tone,
        "Never invent characters or plot points. If the synopsis is too short to cover something, say so plainly.",
    ].join("\n");

    const user = [
        `Title: ${args.title}`,
        args.upTo ? `Recap up to ${args.upTo.type} ${args.upTo.number}.` : "",
        "",
        "Synopsis (verbatim from the source):",
        truncateDesc(args.description) || "(no description available)",
        args.progressContext ? "\nKnown episode/chapter titles up to the requested point:" : "",
        args.progressContext || "",
    ].filter(Boolean).join("\n");

    return [
        { role: "system", content: system },
        { role: "user", content: user },
    ];
}

function buildAnimeProgressContext(info: AnimeInfo | null, upToEpisode?: number): string {
    const episodes = info?.episodes || [];
    if (!episodes.length) return "";
    const limited = upToEpisode != null
        ? episodes.filter((ep) => ep.number <= upToEpisode)
        : episodes.slice(0, 12);
    return limited
        .slice(-24)
        .map((ep) => `Episode ${ep.number}: ${ep.title || "Untitled"}`)
        .join("\n");
}

async function buildMangaProgressContext(mangaId: string, upToChapter?: number): Promise<string> {
    try {
        const chapters: Chapter[] = await getChapters(mangaId, 200, 0);
        const numbered = chapters
            .map((ch) => ({ ...ch, n: Number(ch.chapter) }))
            .filter((ch) => Number.isFinite(ch.n));
        const limited = upToChapter != null
            ? numbered.filter((ch) => ch.n <= upToChapter)
            : numbered.slice(0, 20);
        return limited
            .sort((a, b) => a.n - b.n)
            .slice(-30)
            .map((ch) => `Chapter ${ch.chapter}: ${ch.title || "Untitled"}`)
            .join("\n");
    } catch {
        return "";
    }
}

export async function recapAnime(args: {
    title: string;
    upToEpisode?: number;
    noSpoilers?: boolean;
}): Promise<RecapResult> {
    const looked = await lookupAnime(args.title);
    if (!looked) {
        return {
            ok: false,
            kind: "anime",
            title: args.title,
            summary: "",
            error: "Couldn't find that anime. Try the full title or AniList ID.",
        };
    }
    const description = looked.info?.description || "";
    if (!description) {
        return {
            ok: false,
            kind: "anime",
            title: looked.result.title,
            summary: "",
            error: "Found the title but no synopsis is available — Sakura can't recap blind.",
        };
    }
    const messages = buildPrompt({
        kind: "anime",
        title: looked.result.title,
        description,
        progressContext: buildAnimeProgressContext(looked.info, args.upToEpisode),
        upTo: args.upToEpisode != null ? { type: "episode", number: args.upToEpisode } : undefined,
        noSpoilers: args.noSpoilers !== false,
    });
    const { message } = await groqChat(messages, []);
    return {
        ok: true,
        kind: "anime",
        title: looked.result.title,
        upTo: args.upToEpisode != null ? { type: "episode", number: args.upToEpisode } : undefined,
        summary: (message.content || "").trim(),
        description,
    };
}

export async function recapManga(args: {
    title: string;
    upToChapter?: number;
    noSpoilers?: boolean;
}): Promise<RecapResult> {
    const found = await lookupManga(args.title);
    if (!found) {
        return {
            ok: false,
            kind: "manga",
            title: args.title,
            summary: "",
            error: "Couldn't find that manga. Try the full title or MangaDex ID.",
        };
    }
    if (!found.description) {
        return {
            ok: false,
            kind: "manga",
            title: found.title,
            summary: "",
            error: "Found the title but no synopsis is available — Sakura can't recap blind.",
        };
    }
    const messages = buildPrompt({
        kind: "manga",
        title: found.title,
        description: found.description,
        progressContext: await buildMangaProgressContext(found.id, args.upToChapter),
        upTo: args.upToChapter != null ? { type: "chapter", number: args.upToChapter } : undefined,
        noSpoilers: args.noSpoilers !== false,
    });
    const { message } = await groqChat(messages, []);
    return {
        ok: true,
        kind: "manga",
        title: found.title,
        upTo: args.upToChapter != null ? { type: "chapter", number: args.upToChapter } : undefined,
        summary: (message.content || "").trim(),
        description: found.description,
    };
}

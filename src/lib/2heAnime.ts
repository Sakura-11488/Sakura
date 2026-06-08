import type { AnimeInfo, AnimeResult } from "./anime";

export const TWO_HE_ANIME_ID = "2heanime";
export const TWO_HE_CREATOR_WALLET = "AYTey4uWERPEc4LyTM7mkPbs5XSjTCbF3hmM6jWoJgA6";
export const TWO_HE_CREATOR_EMAIL = "2hecovers@gmail.com";
export const TWO_HE_CREATOR_BIO = "16 y/o building the future of anime streaming with AI @grok\n2hecovers@gmail.com";

export const TWO_HE_ANIME_SERVER = "http://165.232.83.159/2heanime";
export const TWO_HE_ANIME_COVER = "/2heanime.jpg";

interface TwoHeEpisodeInput {
    slug: string;
    file: string;
    title: string;
    description: string;
}

const episodeInputs: TwoHeEpisodeInput[] = [
    {
        slug: "were-still-here",
        file: "werestillhere.mov",
        title: "We're Still Here",
        description:
            "At a lonely train station, a weary young man comes face to face with the child he used to be and the one question he spent years avoiding: \"Did we become someone amazing?\"",
    },
    {
        slug: "two-titans-collide",
        file: "openaixai.mov",
        title: "Two Titans Collide",
        description:
            "Two tech visionaries. One future. When Elon Musk and Sam Altman clash in a futuristic AI war, the battle for humanity's destiny explodes beyond reality itself.",
    },
    {
        slug: "deal-of-the-cosmos",
        file: "dealofthecosmos.mov",
        title: "Deal of the Cosmos",
        description:
            "As alien empires descend on Earth, an over-the-top anime version of Donald Trump pilots a colossal Mecha-MAGA suit to negotiate or battle for humanity's survival.",
    },
    {
        slug: "tung-tung-sahur-taxes",
        file: "TTT.mov",
        title: "Tung Tung Sahur: Taxes",
        description:
            "At 3:47 AM, a broke gamer discovers a horrifying truth: the Tung Tung Sahur creature knows exactly how much he spent on useless skins.",
    },
    {
        slug: "iceman",
        file: "iceman.mov",
        title: "Iceman",
        description:
            "As ancient armies prepare for war beneath falling snow, Ice Man presses play on Drake's \"ICEMAN\" album then unleashes the nightmare generations feared.",
    },
    {
        slug: "hantavirus",
        file: "hanta.mov",
        title: "Hantavirus",
        description:
            "After a young man becomes infected with Hantavirus, panic spreads across the nation as the story reaches the news. Featuring explanations inspired by Dr. Ho-Wang Lee, the scientist who discovered the Hantaan virus, this educational anime explores the dangers, symptoms, and prevention of the deadly disease.",
    },
    {
        slug: "sienna-star",
        file: "STAR.mov",
        title: "Sienna Star",
        description:
            "In a neon-soaked cyberpunk city ruled by betrayal and violence, a fierce red-haired fighter named Sienna hunts the people who destroyed her trust, and discovers revenge may cost what remains of her humanity.",
    },
];

export const TWO_HE_EPISODE_DETAILS = episodeInputs.map((episode, index) => ({
    ...episode,
    id: `2he-${episode.slug}`,
    number: index + 1,
    image: TWO_HE_ANIME_COVER,
}));

export const TWO_HE_ANIME_EPISODES: AnimeInfo["episodes"] = TWO_HE_EPISODE_DETAILS.map((episode) => ({
    id: episode.id,
    number: episode.number,
    title: episode.title,
    image: episode.image,
}));

export const TWO_HE_ANIME_SEARCH_RESULT: AnimeResult = {
    id: TWO_HE_ANIME_ID,
    title: "2heAnime",
    image: TWO_HE_ANIME_COVER,
    type: "2heAnime x Sakura",
    score: 9.8,
};

export const TWO_HE_ANIME_INFO: AnimeInfo = {
    id: TWO_HE_ANIME_ID,
    title: "2heAnime",
    image: TWO_HE_ANIME_COVER,
    cover: TWO_HE_ANIME_COVER,
    description:
        "A Sakura Original anthology of AI-powered anime shorts from 2heAnime, a 16-year-old creator building the future of anime streaming with AI.",
    status: "Ongoing",
    genres: ["AI Anime", "Sakura Original", "Anthology"],
    score: 9.8,
    episodes: TWO_HE_ANIME_EPISODES,
};

export function matchesTwoHeAnimeQuery(query: string): boolean {
    const q = query.toLowerCase().trim();
    return (
        q.includes("2he") ||
        q.includes("2heanime") ||
        q.includes("two he") ||
        q.includes("ai anime") ||
        q.includes("sakura original") ||
        episodeInputs.some((episode) => q.includes(episode.title.toLowerCase()))
    );
}

export function isTwoHeAnimeEpisode(episodeId: string): boolean {
    return episodeId.startsWith("2he-");
}

export function getTwoHeAnimeStreamUrl(episodeId: string): string | null {
    const episode = TWO_HE_EPISODE_DETAILS.find((item) => item.id === episodeId);
    if (!episode) return null;
    return `${TWO_HE_ANIME_SERVER}/videos/${episode.file}`;
}

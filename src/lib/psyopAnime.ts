import type { AnimeResult, AnimeInfo } from "./anime";

export const PSYOP_ID = "psyopanime";

export const PSYOP_SERVER = "http://165.232.83.159/psyopanime";

function ep(number: number, ytId: string, title: string): { id: string; number: number; title: string; image: string } {
    return {
        id: `psyop-${ytId}`,
        number,
        title,
        image: `${PSYOP_SERVER}/thumbs/${ytId}.jpg`,
    };
}

export const PSYOP_EPISODES: AnimeInfo["episodes"] = [
    ep(1, "BnBj8sRUu6o", "Enemies of Disclosure Trailer #1"),
    ep(2, "O3OBtF67MY0", "INSERT 1 COIN(S) TO PLAY"),
    ep(3, "69oB50L7euw", "WW3 Anime - Maduro"),
    ep(4, "9hlx5Rslrzk", "Maximum Carnage technical demo"),
    ep(5, "iLNypgG-X8k", "Enemies of Disclosure: Narrative War"),
    ep(6, "5W6mxTrmYIs", "PsyopQueen Reveal"),
    ep(7, "FMJCfUhoV0c", "PsyopQueen Series Trailer"),
    ep(8, "EhkENVbG1_E", "Somali Scam King - FT PsyopAnime"),
    ep(9, "QtVXX2bpGjA", "WW3 // Venezuela"),
    ep(10, "yZEYXkrhtgg", "Green Ranger"),
    ep(11, "1gQJdIlaXuY", "CODE WHITE ft Aiden Guo"),
    ep(12, "XMOG-5TTiCg", "WW3 - Iran's Revolution"),
    ep(13, "s_sJPZwV1cI", "WW3 - World Leaders strike"),
    ep(14, "MciXXdZFJzM", "WW3 - Episode 3"),
    ep(15, "aiZdLiH-Lq4", "WW3 - Ep 4 Trailer"),
    ep(16, "qeANZIfik9A", "WW3 - Ep 4"),
    ep(17, "ei2ruRo41GA", "Grok Imagine Superbowl Contest Entry"),
    ep(18, "xg2Anzd4MyQ", "GROK CONTEST RESULTS"),
    ep(19, "ZuZWjjiG6lM", "Epstein Files preview - Pam Bondi"),
    ep(20, "NTpFZLDoxI0", "Recap of Feb 2026 BTC crash"),
    ep(21, "fpgZd4SiwkI", "Epstein Files preview"),
    ep(22, "sjUBdXL4siI", "Reptilian Ritual"),
    ep(23, "I0OX9ZuJOR0", "State of the Union"),
    ep(24, "aGewhQX8xmI", "Grok contest announcement - enter to win!"),
    ep(25, "JAuvfd_2IO0", "EP 5 preview - Burj Al Arab Jumeirah drone strike"),
    ep(26, "SeTpr9JsO94", "Death of the Ayatollah"),
    ep(27, "l1rhOaAj-_k", "Iran Escalation"),
    ep(28, "oNrNnhD5s6s", "Iran/USA Recap"),
    ep(29, "RRqg1PNuLvk", "Iran counter offensive"),
    ep(30, "I31HyZxegzY", "Don't say his name"),
    ep(31, "qFIuVw8whbs", "Trump Declares War"),
    ep(32, "c_QXgKvu3TM", "Epstein Files"),
    ep(33, "P5K_J7-b8uI", "NYC protest goes wrong"),
    ep(34, "pVLsEaLkOMo", "Iranian Football Team"),
    ep(35, "y8j5CqapxcU", "Top 10 Anime Betrayals"),
    ep(36, "OS19oNHNnJs", "2026 Trailer"),
    ep(37, "LedPhAOIUXI", "Bernie's AI Moratorium"),
    ep(38, "iz86M-cdd2k", "No Kings"),
    ep(39, "wur2EZ7csXU", "WW3 - Pilot Extraction trailer"),
    ep(40, "o1UuQJBPYSk", "WW3 - Ceasefire"),
    ep(41, "t4RcNosDlmo", "WW3 - IRGC"),
    ep(42, "dmPmpPu5I4E", "Canada\u2019s MMIWG2SLGBTQQIA+"),
    ep(43, "zXlBHNZx_RA", "Untitled 2026 Series - Transformation"),
];

export const PSYOP_SEARCH_RESULT: AnimeResult = {
    id: PSYOP_ID,
    title: "PsyopAnime: The Series",
    image: "/psyopanime.png",
    type: "PsyopAnime \u00d7 Sakura",
    score: 9.9,
};

export const PSYOP_INFO: AnimeInfo = {
    id: PSYOP_ID,
    title: "PsyopAnime: The Series",
    image: "/psyopanime.png",
    cover: "/psyopanime.png",
    description:
        "In a hyper-connected world where digital psyops blur the lines between reality and illusion, " +
        "enter the enigmatic hacker collective known as PsyopAnime. Led by the sharp-witted protagonist, " +
        "Neo-Meme Master Akira, this ragtag group of anime avatars wages a covert war against corrupt crypto barons, " +
        "political puppet-masters, and viral pop culture overlords. Armed with AI-generated visuals that twist minds " +
        "and shatter perceptions, they infiltrate social feeds, dropping satirical bombshells disguised as cute chibi " +
        "animations and epic mecha battles. But as their influence grows, so does the backlash \u2014 shadowy governments " +
        "deploy counter-psyop drones, forcing Akira and his crew into a high-stakes game of digital cat-and-mouse. " +
        "Will they expose the grand illusion, or become the very memes they wield? Packed with Easter eggs from " +
        "real-world trends, PsyopAnime delivers razor-sharp commentary wrapped in stunning visuals, proving that " +
        "in the age of information warfare, laughter is the ultimate weapon.",
    status: "Ongoing",
    genres: ["Sci-Fi Action", "Psychological Thriller", "Satire"],
    score: 9.9,
    episodes: PSYOP_EPISODES,
};

export const PSYOP_STUDIO = "xAI Visions (in collaboration with meme overlords)";

export const PSYOP_CHARACTERS = [
    {
        name: "Akira",
        role: "The Visionary",
        description:
            "A crypto-savvy otaku who codes psyops like fanfiction, always one step ahead with his SOL-fueled gadgets.",
    },
    {
        name: "Luna",
        role: "The Artist",
        description:
            "Master of AI art contests, she turns viral challenges into revolutionary tools, rewarding allies with digital treasures.",
    },
    {
        name: "Shadow Broker",
        role: "The Antagonist",
        description:
            "A mysterious figure pulling strings from the dark web, embodying the satire's real-life inspirations.",
    },
];

export function matchesPsyopQuery(query: string): boolean {
    const q = query.toLowerCase().trim();
    return (
        q.includes("psyop") ||
        q.includes("neo-meme") ||
        q.includes("psyopanime") ||
        q === "sakura original"
    );
}

export function isPsyopEpisode(episodeId: string): boolean {
    return episodeId.startsWith("psyop-");
}

export function getPsyopStreamUrl(episodeId: string): string | null {
    const ytId = episodeId.replace("psyop-", "");
    const episode = PSYOP_EPISODES.find((e) => e.id === episodeId);
    if (!episode) return null;
    return `${PSYOP_SERVER}/videos/${ytId}.mp4`;
}

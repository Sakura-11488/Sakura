import axios from 'axios';

const BASE = 'https://api.mangadex.org';

function getCover(mangaId: string, coverId: string, fileName: string) {
  return `https://uploads.mangadex.org/covers/${mangaId}/${fileName}.512.jpg`;
}

export interface MangaBasic {
  id: string;
  title: string;
  cover: string;
  genres: string[];
  synopsis: string;
  status: string;
}

export async function searchManga(query: string, limit = 20): Promise<MangaBasic[]> {
  const { data } = await axios.get(`${BASE}/manga`, {
    params: {
      title: query,
      limit,
      includes: ['cover_art'],
      contentRating: ['safe', 'suggestive'],
      'order[relevance]': 'desc',
    },
  });

  return data.data.map((m: any) => {
    const coverRel = m.relationships.find((r: any) => r.type === 'cover_art');
    const cover = coverRel ? getCover(m.id, coverRel.id, coverRel.attributes?.fileName ?? '') : '';
    const titleObj = m.attributes.title;
    const title = titleObj.en ?? Object.values(titleObj)[0] ?? 'Unknown';
    const genres = (m.attributes.tags ?? [])
      .filter((t: any) => t.attributes.group === 'genre')
      .map((t: any) => t.attributes.name.en ?? '')
      .filter(Boolean);
    return {
      id: m.id,
      title,
      cover,
      genres,
      synopsis: m.attributes.description?.en ?? '',
      status: m.attributes.status,
    };
  });
}

export async function getPopularManga(limit = 20): Promise<MangaBasic[]> {
  const { data } = await axios.get(`${BASE}/manga`, {
    params: {
      limit,
      includes: ['cover_art'],
      'order[followedCount]': 'desc',
      contentRating: ['safe', 'suggestive'],
      availableTranslatedLanguage: ['en'],
    },
  });

  return data.data.map((m: any) => {
    const coverRel = m.relationships.find((r: any) => r.type === 'cover_art');
    const cover = coverRel ? getCover(m.id, coverRel.id, coverRel.attributes?.fileName ?? '') : '';
    const titleObj = m.attributes.title;
    const title = titleObj.en ?? Object.values(titleObj)[0] ?? 'Unknown';
    return {
      id: m.id,
      title,
      cover,
      genres: [],
      synopsis: m.attributes.description?.en ?? '',
      status: m.attributes.status,
    };
  });
}

import axios from 'axios';

const BASE = 'https://api.jikan.moe/v4';

export interface AnimeBasic {
  mal_id: number;
  title: string;
  images: { jpg: { large_image_url: string } };
  genres: { name: string }[];
  synopsis: string;
  score: number;
  episodes: number | null;
  status: string;
}

export async function getTopAnime(page = 1): Promise<AnimeBasic[]> {
  const { data } = await axios.get(`${BASE}/top/anime`, { params: { page } });
  return data.data;
}

export async function searchAnime(query: string): Promise<AnimeBasic[]> {
  const { data } = await axios.get(`${BASE}/anime`, { params: { q: query, limit: 20 } });
  return data.data;
}

export async function getAnimeById(id: number): Promise<AnimeBasic> {
  const { data } = await axios.get(`${BASE}/anime/${id}`);
  return data.data;
}

export async function getSeasonalAnime(): Promise<AnimeBasic[]> {
  const { data } = await axios.get(`${BASE}/seasons/now`);
  return data.data;
}

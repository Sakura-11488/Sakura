"use client";

import { useState, useEffect } from "react";
import type { Manga } from "./content-source";

const STORAGE_KEY = "sakura_favorites";

export function useFavorites() {
    const [favorites, setFavorites] = useState<Manga[]>([]);

    // Load from local storage on mount
    useEffect(() => {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
            try {
                setFavorites(JSON.parse(stored));
            } catch (e) {
                console.error("Failed to parse favorites", e);
            }
        }
    }, []);

    const saveFavorites = (newFavorites: Manga[]) => {
        setFavorites(newFavorites);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(newFavorites));
    };

    const addFavorite = (manga: Manga) => {
        if (favorites.some((f) => f.id === manga.id)) return;
        const newFavs = [...favorites, manga];
        saveFavorites(newFavs);
    };

    const removeFavorite = (mangaId: string) => {
        const newFavs = favorites.filter((f) => f.id !== mangaId);
        saveFavorites(newFavs);
    };

    const isFavorite = (mangaId: string) => {
        return favorites.some((f) => f.id === mangaId);
    };

    return { favorites, addFavorite, removeFavorite, isFavorite };
}

import { Directory, Filesystem } from '@capacitor/filesystem';
import { getLocal, setLocal, STORAGE_KEYS } from './storage';
import { Capacitor } from '@capacitor/core';
import { useState, useEffect } from 'react';

export type DownloadState = 'queued' | 'downloading' | 'paused' | 'completed' | 'error';

export interface DownloadTask {
    mangaId: string;
    chapterId: string;
    title: string;
    cover: string;
    pages: string[];
    downloadedPages: number;
    state: DownloadState;
    error?: string;
}

class DownloadManager {
    private tasks: Record<string, DownloadTask> = {};
    private listeners: Set<() => void> = new Set();
    private activeRequests: Record<string, AbortController> = {};
    private queue: string[] = [];
    private isProcessing: boolean = false;

    constructor() {
        this.loadTasks();
    }

    private loadTasks() {
        if (typeof window === 'undefined') return;
        this.tasks = getLocal(STORAGE_KEYS.DOWNLOADS, {});
        // Reset any interrupted downloads to paused
        for (const id in this.tasks) {
            if (this.tasks[id].state === 'downloading' || this.tasks[id].state === 'queued') {
                this.tasks[id].state = 'paused';
            }
        }
        this.saveTasks();
    }

    private saveTasks() {
        if (typeof window !== 'undefined') {
            setLocal(STORAGE_KEYS.DOWNLOADS, this.tasks);
        }
        this.notify();
    }

    subscribe(listener: () => void) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private notify() {
        this.listeners.forEach(l => l());
    }

    getTasks() {
        return this.tasks;
    }

    getTask(chapterId: string) {
        return this.tasks[chapterId];
    }

    addDownload(mangaId: string, chapterId: string, title: string, cover: string, pages: string[]) {
        if (this.tasks[chapterId] && this.tasks[chapterId].state === 'completed') {
            return; // Already downloaded
        }

        this.tasks[chapterId] = {
            mangaId,
            chapterId,
            title,
            cover,
            pages,
            downloadedPages: this.tasks[chapterId]?.downloadedPages || 0,
            state: 'queued'
        };

        if (!this.queue.includes(chapterId)) {
            this.queue.push(chapterId);
        }
        this.saveTasks();
        this.processQueue();
    }

    downloadMultiple(mangaId: string, chapters: { id: string, title: string, pages: string[] }[], cover: string) {
        for (const chap of chapters) {
            this.addDownload(mangaId, chap.id, chap.title, cover, chap.pages);
        }
    }

    pause(chapterId: string) {
        const task = this.tasks[chapterId];
        if (!task) return;

        if (task.state === 'downloading') {
            const controller = this.activeRequests[chapterId];
            if (controller) {
                controller.abort();
                delete this.activeRequests[chapterId];
            }
        }

        task.state = 'paused';
        this.queue = this.queue.filter(id => id !== chapterId);
        this.saveTasks();
        this.processQueue();
    }

    resume(chapterId: string) {
        const task = this.tasks[chapterId];
        if (!task || task.state === 'completed' || task.state === 'downloading') return;

        task.state = 'queued';
        if (!this.queue.includes(chapterId)) {
            this.queue.push(chapterId);
        }
        this.saveTasks();
        this.processQueue();
    }

    pauseAll() {
        for (const id in this.tasks) {
            if (this.tasks[id].state === 'downloading' || this.tasks[id].state === 'queued') {
                this.pause(id);
            }
        }
    }

    async remove(chapterId: string) {
        this.pause(chapterId); // abort if running
        const task = this.tasks[chapterId];
        if (!task) return;

        delete this.tasks[chapterId];
        this.saveTasks();

        // Delete files
        try {
            await Filesystem.rmdir({
                path: `sakura/${task.mangaId}/${chapterId}`,
                directory: Directory.Data,
                recursive: true
            });
        } catch (e) {
            console.error("Failed to delete directory for chapter", chapterId, e);
        }
    }

    private async processQueue() {
        if (this.isProcessing) return;
        if (this.queue.length === 0) return;

        this.isProcessing = true;

        while (this.queue.length > 0) {
            const chapterId = this.queue.shift();
            if (!chapterId) continue;

            const task = this.tasks[chapterId];
            if (!task || task.state !== 'queued') continue;

            task.state = 'downloading';
            this.saveTasks();

            const abortController = new AbortController();
            this.activeRequests[chapterId] = abortController;

            try {
                // Ensure manga directory and chapter directory exist
                const chapterPath = `sakura/${task.mangaId}/${chapterId}`;
                await this.ensureDirectory(chapterPath);

                let failed = false;

                // Resume from where left off
                for (let i = task.downloadedPages; i < task.pages.length; i++) {
                    if (abortController.signal.aborted) {
                        failed = true;
                        break;
                    }

                    const pageUrl = task.pages[i];

                    try {
                        const response = await fetch(pageUrl, {
                            signal: abortController.signal,
                            referrerPolicy: 'no-referrer'
                        });

                        if (!response.ok) throw new Error("Failed to fetch image");
                        const blob = await response.blob();
                        const base64Data = await this.blobToBase64(blob);

                        // Save file
                        const fileName = `${i}.jpg`;
                        await Filesystem.writeFile({
                            path: `${chapterPath}/${fileName}`,
                            data: base64Data,
                            directory: Directory.Data
                        });

                        task.downloadedPages = i + 1;
                        this.saveTasks();
                    } catch (err: any) {
                        if (err.name === 'AbortError') {
                            failed = true;
                            break;
                        }
                        console.error("Error downloading page", i, err);
                        task.state = 'error';
                        task.error = err.message;
                        this.saveTasks();
                        failed = true;
                        break;
                    }
                }

                if (!failed) {
                    task.state = 'completed';
                    this.saveTasks();
                }

            } catch (err: any) {
                console.error("Download fatal error", err);
                if (task) {
                    task.state = 'error';
                    task.error = err?.message || 'Unknown error';
                    this.saveTasks();
                }
            } finally {
                delete this.activeRequests[chapterId];
            }
        }

        this.isProcessing = false;
    }

    private async blobToBase64(blob: Blob): Promise<string> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = reject;
            reader.onload = () => {
                const dataUrl = reader.result as string;
                const base64 = dataUrl.split(',')[1];
                resolve(base64 || dataUrl);
            };
            reader.readAsDataURL(blob);
        });
    }

    private async ensureDirectory(path: string) {
        try {
            await Filesystem.stat({
                path,
                directory: Directory.Data
            });
        } catch (e) {
            await Filesystem.mkdir({
                path,
                directory: Directory.Data,
                recursive: true
            });
        }
    }

    // Helper to get local page URL for the reader
    async getLocalPageUrl(mangaId: string, chapterId: string, pageIndex: number): Promise<string | null> {
        try {
            const task = this.tasks[chapterId];
            if (!task || task.downloadedPages <= pageIndex) return null;

            const path = `sakura/${mangaId}/${chapterId}/${pageIndex}.jpg`;
            const uri = await Filesystem.getUri({
                path,
                directory: Directory.Data
            });
            return Capacitor.convertFileSrc(uri.uri);
        } catch (e) {
            return null;
        }
    }
}

export const downloadManager = new DownloadManager();

// React hook for easy UI binding
export function useDownloads() {
    const [tasks, setTasks] = useState<Record<string, DownloadTask>>({});

    useEffect(() => {
        // Initial state
        setTasks({ ...downloadManager.getTasks() });
        // Subscribe to changes
        const unsubscribe = downloadManager.subscribe(() => {
            setTasks({ ...downloadManager.getTasks() });
        });
        return () => { unsubscribe(); };
    }, []);

    return tasks;
}

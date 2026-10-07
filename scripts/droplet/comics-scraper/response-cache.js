import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

// Public, successfully parsed endpoint responses only. Keeping these through a
// process restart lets previously read comics survive a temporary source outage.
// Bound retention and entry count; image bytes remain in the separate cache.
export function createResponseCache({ directory, maxEntries = 1000, maxAgeMs = 30 * 24 * 60 * 60 * 1000, now = Date.now }) {
    const filename = (key) => path.join(directory, `${createHash('sha256').update(key).digest('hex')}.json`);
    let nextPrune = 0;
    let pruneRunning = false;
    async function prune() {
        if (pruneRunning || now() < nextPrune) return;
        pruneRunning = true;
        nextPrune = now() + 60_000;
        try {
            const names = (await readdir(directory)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
            const files = await Promise.all(names.map(async (name) => {
                const file = path.join(directory, name);
                return { file, at: (await stat(file)).mtimeMs };
            }));
            files.sort((a, b) => b.at - a.at);
            await Promise.all(files.filter((file, index) => index >= maxEntries || now() - file.at > maxAgeMs).map((file) => unlink(file.file).catch(() => {})));
        } catch { /* Cache maintenance must not interrupt a reader. */ }
        finally { pruneRunning = false; }
    }
    return {
        async get(key) {
            try {
                const file = filename(key);
                if ((await stat(file)).size > 1024 * 1024) return undefined;
                const entry = JSON.parse(await readFile(file, 'utf8'));
                if (entry.key !== key || !Number.isFinite(entry.at) || now() - entry.at > maxAgeMs) return undefined;
                return entry.value;
            } catch { return undefined; }
        },
        async set(key, value) {
            let temporary;
            try {
                const body = JSON.stringify({ key, value, at: now() });
                if (Buffer.byteLength(body) > 1024 * 1024) return;
                await mkdir(directory, { recursive: true });
                const file = filename(key);
                temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
                await writeFile(temporary, body);
                await rename(temporary, file);
                await prune();
            } catch {
                if (temporary) await unlink(temporary).catch(() => {});
            }
        },
    };
}

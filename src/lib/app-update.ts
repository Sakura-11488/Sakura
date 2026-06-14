import { Capacitor } from "@capacitor/core";
import { APP_VERSION } from "@/lib/app-version";
import { getLocal, setLocal } from "@/lib/storage";
import { AppUpdateNative } from "@/plugins/app-update";

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STORAGE_LAST_CHECK = "sakura_update_last_check";
const STORAGE_DISMISSED_CODE = "sakura_update_dismissed_code";
const DEFAULT_GITHUB_REPO = "Sakura-11488/Sakura";

export interface AppUpdateManifest {
    version: string;
    versionCode: number;
    apkUrl: string;
    releaseNotes?: string;
    publishedAt?: string;
    forceUpdate?: boolean;
    minVersionCode?: number;
    source?: "github" | "manifest";
}

export interface AppUpdateInfo {
    manifest: AppUpdateManifest;
    currentVersion: string;
    currentVersionCode: number;
    isForced: boolean;
}

function getGitHubRepo(): string {
    return (process.env.NEXT_PUBLIC_GITHUB_REPO || DEFAULT_GITHUB_REPO).trim();
}

function getUpdateManifestUrl(): string {
    const configured = (process.env.NEXT_PUBLIC_APP_UPDATE_URL || "").trim();
    if (configured) return configured;
    const shareBase = (process.env.NEXT_PUBLIC_SAKURA_SHARE_BASE || "https://sakuraonseeker.com").replace(/\/+$/, "");
    return `${shareBase}/app-update.json`;
}

function shouldUseGitHubReleases(): boolean {
    const source = (process.env.NEXT_PUBLIC_APP_UPDATE_SOURCE || "github").trim().toLowerCase();
    if (source === "manifest" || source === "json") return false;
    return !!getGitHubRepo();
}

interface GitHubReleaseAsset {
    name?: string;
    browser_download_url?: string;
    content_type?: string;
}

interface GitHubRelease {
    tag_name?: string;
    name?: string;
    body?: string;
    published_at?: string;
    assets?: GitHubReleaseAsset[];
}

function parseReleaseMetadata(body: string): Partial<AppUpdateManifest> {
    const metadata: Partial<AppUpdateManifest> = {};
    const versionCodeMatch = body.match(/versionCode\s*[:=]\s*(\d+)/i);
    if (versionCodeMatch) metadata.versionCode = parseInt(versionCodeMatch[1], 10);

    const minVersionCodeMatch = body.match(/minVersionCode\s*[:=]\s*(\d+)/i);
    if (minVersionCodeMatch) metadata.minVersionCode = parseInt(minVersionCodeMatch[1], 10);

    if (/forceUpdate\s*[:=]\s*true/i.test(body)) metadata.forceUpdate = true;

    const jsonBlock = body.match(/```json\s*([\s\S]*?)```/i)?.[1];
    if (jsonBlock) {
        try {
            const parsed = JSON.parse(jsonBlock) as Partial<AppUpdateManifest>;
            if (typeof parsed.versionCode === "number") metadata.versionCode = parsed.versionCode;
            if (typeof parsed.minVersionCode === "number") metadata.minVersionCode = parsed.minVersionCode;
            if (typeof parsed.forceUpdate === "boolean") metadata.forceUpdate = parsed.forceUpdate;
        } catch {
            // Ignore malformed release JSON blocks.
        }
    }

    return metadata;
}

function normalizeReleaseVersion(tagName: string): string {
    return tagName.replace(/^v/i, "").trim();
}

function pickApkAsset(assets: GitHubReleaseAsset[] | undefined): GitHubReleaseAsset | null {
    if (!assets?.length) return null;

    const apkAssets = assets.filter(asset =>
        asset.name?.toLowerCase().endsWith(".apk") && asset.browser_download_url
    );
    if (!apkAssets.length) return null;

    const preferred = apkAssets.find(asset => /sakura/i.test(asset.name || ""));
    return preferred || apkAssets[0];
}

function stripReleaseMetadata(body: string): string {
    return body
        .replace(/```json[\s\S]*?```/gi, "")
        .replace(/^\s*versionCode\s*[:=]\s*\d+\s*$/gim, "")
        .replace(/^\s*minVersionCode\s*[:=]\s*\d+\s*$/gim, "")
        .replace(/^\s*forceUpdate\s*[:=]\s*(true|false)\s*$/gim, "")
        .trim();
}

export async function fetchFromGitHubRelease(): Promise<AppUpdateManifest> {
    const repo = getGitHubRepo();
    const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
        cache: "no-store",
        headers: {
            Accept: "application/vnd.github+json",
        },
    });

    if (response.status === 404) {
        throw new Error("No GitHub release found yet");
    }
    if (!response.ok) {
        throw new Error(`GitHub release check failed (${response.status})`);
    }

    const release = (await response.json()) as GitHubRelease;
    const tagName = release.tag_name?.trim();
    if (!tagName) {
        throw new Error("Latest GitHub release is missing a tag");
    }

    const apkAsset = pickApkAsset(release.assets);
    if (!apkAsset?.browser_download_url) {
        throw new Error("Latest GitHub release has no APK asset attached");
    }

    const body = release.body || "";
    const metadata = parseReleaseMetadata(body);
    const version = normalizeReleaseVersion(tagName);
    const versionCode = metadata.versionCode ?? 0;

    return {
        version,
        versionCode,
        apkUrl: apkAsset.browser_download_url,
        releaseNotes: stripReleaseMetadata(body) || release.name || `Sakura ${version}`,
        publishedAt: release.published_at,
        forceUpdate: metadata.forceUpdate,
        minVersionCode: metadata.minVersionCode,
        source: "github",
    };
}

export function parseVersionParts(version: string): number[] {
    return version
        .replace(/^v/i, "")
        .split(".")
        .map(part => parseInt(part, 10) || 0);
}

export function isVersionNewer(latest: string, current: string): boolean {
    const latestParts = parseVersionParts(latest);
    const currentParts = parseVersionParts(current);
    const length = Math.max(latestParts.length, currentParts.length);

    for (let i = 0; i < length; i += 1) {
        const diff = (latestParts[i] ?? 0) - (currentParts[i] ?? 0);
        if (diff !== 0) return diff > 0;
    }
    return false;
}

async function getCurrentVersionCode(): Promise<number> {
    if (!Capacitor.isNativePlatform()) return 0;
    try {
        const info = await AppUpdateNative.getBuildInfo();
        return info.versionCode ?? 0;
    } catch {
        return 0;
    }
}

function shouldUseCachedCheck(force: boolean): boolean {
    if (force) return false;
    const lastCheck = getLocal<number>(STORAGE_LAST_CHECK, 0);
    return Date.now() - lastCheck < UPDATE_CHECK_INTERVAL_MS;
}

export function dismissUpdate(versionCode: number): void {
    setLocal(STORAGE_DISMISSED_CODE, versionCode);
}

export function isUpdateDismissed(versionCode: number): boolean {
    return getLocal<number>(STORAGE_DISMISSED_CODE, 0) === versionCode;
}

export async function fetchAppUpdateManifest(): Promise<AppUpdateManifest | null> {
    if (shouldUseGitHubReleases()) {
        try {
            return await fetchFromGitHubRelease();
        } catch (githubError) {
            const manifestUrl = (process.env.NEXT_PUBLIC_APP_UPDATE_URL || "").trim();
            if (!manifestUrl) {
                throw githubError;
            }
        }
    }

    const url = getUpdateManifestUrl();
    const response = await fetch(url, {
        cache: "no-store",
        headers: { Accept: "application/json" },
    });
    if (!response.ok) {
        throw new Error(`Update check failed (${response.status})`);
    }

    const data = (await response.json()) as Partial<AppUpdateManifest>;
    if (!data.version || typeof data.versionCode !== "number" || !data.apkUrl) {
        throw new Error("Update manifest is missing required fields");
    }

    return {
        version: data.version,
        versionCode: data.versionCode,
        apkUrl: data.apkUrl,
        releaseNotes: data.releaseNotes,
        publishedAt: data.publishedAt,
        forceUpdate: !!data.forceUpdate,
        minVersionCode: data.minVersionCode,
        source: "manifest",
    };
}

export async function checkForAppUpdate(options?: { force?: boolean }): Promise<AppUpdateInfo | null> {
    if (shouldUseCachedCheck(!!options?.force)) {
        return null;
    }

    setLocal(STORAGE_LAST_CHECK, Date.now());

    const [manifest, currentVersionCode] = await Promise.all([
        fetchAppUpdateManifest(),
        getCurrentVersionCode(),
    ]);

    if (!manifest) return null;

    const currentVersion = APP_VERSION;
    const newerByCode = currentVersionCode > 0 && manifest.versionCode > currentVersionCode;
    const newerByName = isVersionNewer(manifest.version, currentVersion);
    const belowMinimum =
        typeof manifest.minVersionCode === "number" &&
        currentVersionCode > 0 &&
        currentVersionCode < manifest.minVersionCode;

    if (!newerByCode && !newerByName && !belowMinimum) {
        return null;
    }

    return {
        manifest,
        currentVersion,
        currentVersionCode,
        isForced: !!manifest.forceUpdate || belowMinimum,
    };
}

export function canInstallInApp(): boolean {
    return Capacitor.getPlatform() === "android";
}

export function getAppUpdateSourceLabel(): string {
    return shouldUseGitHubReleases()
        ? `GitHub Releases (${getGitHubRepo()})`
        : "Hosted update manifest";
}

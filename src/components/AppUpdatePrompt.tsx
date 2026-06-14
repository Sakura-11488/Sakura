"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
    canInstallInApp,
    checkForAppUpdate,
    dismissUpdate,
    getAppUpdateSourceLabel,
    isUpdateDismissed,
    type AppUpdateInfo,
} from "@/lib/app-update";
import { AppUpdateNative, type AppUpdateDownloadEvent } from "@/plugins/app-update";
import { useI18n, type TranslationKey } from "@/lib/i18n/I18nProvider";

function getDownloadStatusText(
    state: AppUpdateDownloadEvent["state"] | null,
    progress: number | null,
    t: (key: TranslationKey, values?: Record<string, string | number>) => string
): string | null {
    if (state === "downloading") {
        return progress != null ? t("update.downloading", { progress }) : t("update.downloadingPlain");
    }
    if (state === "installing") {
        return t("update.installing");
    }
    if (state === "completed") {
        return t("update.completed");
    }
    if (state === "needs_permission") {
        return t("update.needsPermission");
    }
    return null;
}

async function startInAppUpdate(apkUrl: string, onEvent: (event: AppUpdateDownloadEvent) => void) {
    const permission = await AppUpdateNative.canInstallPackages();
    if (!permission.allowed) {
        onEvent({
            progress: 0,
            state: "needs_permission",
            message: "Allow Sakura to install updates, then tap Download update again.",
        });
        await AppUpdateNative.openInstallPermissionSettings();
        return;
    }

    await AppUpdateNative.downloadAndInstall({ url: apkUrl });
}

function UpdateBannerShell({
    children,
    className = "",
    onDismiss,
    canDismiss,
}: {
    children: ReactNode;
    className?: string;
    onDismiss?: () => void;
    canDismiss?: boolean;
}) {
    return (
        <div className="app-update-shell">
            <div className={`app-update-banner ${className}`.trim()} role="status">
                <div className="app-update-top">
                    {children}
                    {canDismiss && onDismiss && (
                        <button
                            type="button"
                            className="app-update-dismiss"
                            aria-label="Dismiss update"
                            onClick={onDismiss}
                        >
                            ✕
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}

export default function AppUpdatePrompt() {
    const { t } = useI18n();
    const [update, setUpdate] = useState<AppUpdateInfo | null>(null);
    const [checking, setChecking] = useState(false);
    const [checkError, setCheckError] = useState<string | null>(null);
    const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
    const [downloadState, setDownloadState] = useState<AppUpdateDownloadEvent["state"] | null>(null);
    const [downloadError, setDownloadError] = useState<string | null>(null);
    const listenerRef = useRef<{ remove: () => void } | null>(null);

    const runCheck = useCallback(async (force = false) => {
        setChecking(true);
        setCheckError(null);
        try {
            const result = await checkForAppUpdate({ force });
            if (result && !result.isForced && isUpdateDismissed(result.manifest.versionCode)) {
                setUpdate(null);
                return;
            }
            setUpdate(result);
        } catch (error) {
            setCheckError(error instanceof Error ? error.message : t("update.checkFailed"));
            setUpdate(null);
        } finally {
            setChecking(false);
        }
    }, [t]);

    useEffect(() => {
        void runCheck(false);
    }, [runCheck]);

    useEffect(() => {
        return () => {
            listenerRef.current?.remove();
            listenerRef.current = null;
        };
    }, []);

    const handleDismiss = () => {
        if (!update || update.isForced) return;
        dismissUpdate(update.manifest.versionCode);
        setUpdate(null);
    };

    const handleDownload = async () => {
        if (!update || !canInstallInApp()) return;

        setDownloadError(null);
        setDownloadProgress(0);
        setDownloadState("downloading");

        try {
            listenerRef.current?.remove();
            const handle = await AppUpdateNative.addListener("downloadProgress", event => {
                setDownloadProgress(event.progress);
                setDownloadState(event.state);
                if (event.state === "error") {
                    setDownloadError(event.message || "Download failed");
                }
                if (event.state === "needs_permission") {
                    setDownloadError(event.message || "Install permission required");
                }
            });
            listenerRef.current = handle;

            await startInAppUpdate(update.manifest.apkUrl, event => {
                setDownloadProgress(event.progress);
                setDownloadState(event.state);
                if (event.message) setDownloadError(event.message);
            });
        } catch (error) {
            setDownloadState("error");
            setDownloadError(error instanceof Error ? error.message : "Download failed");
        }
    };

    if (checking && !update) {
        return null;
    }

    if (checkError) {
        return (
            <UpdateBannerShell className="is-error" onDismiss={() => setCheckError(null)} canDismiss>
                <div className="app-update-icon" aria-hidden>🌸</div>
                <div className="app-update-body">
                    <span className="app-update-kicker">更新チェック</span>
                    <p className="app-update-title">{t("update.checkFailed")}</p>
                    <p className="app-update-error">{checkError}</p>
                </div>
            </UpdateBannerShell>
        );
    }

    if (!update) {
        return null;
    }

    const { manifest, currentVersion, isForced } = update;
    const statusText = getDownloadStatusText(downloadState, downloadProgress, t);
    const isBusy = downloadState === "downloading" || downloadState === "installing";

    return (
        <UpdateBannerShell
            className={isForced ? "is-forced" : ""}
            onDismiss={handleDismiss}
            canDismiss={!isForced}
        >
            <div className="app-update-icon" aria-hidden>{isForced ? "✦" : "🌸"}</div>
            <div className="app-update-body">
                <span className="app-update-kicker">
                    {isForced ? t("update.requiredKicker") : t("update.newVersionKicker")}
                </span>
                <p className="app-update-title">
                    {isForced ? t("update.requiredTitle") : t("update.availableTitle")} —{" "}
                    <span className="app-update-version">v{manifest.version}</span>
                </p>
                <p className="app-update-notes">
                    {t("update.currentVersion", { version: currentVersion })}{" "}
                    {manifest.releaseNotes || t("update.defaultNotes")}
                </p>

                {statusText && <span className="app-update-status">{statusText}</span>}

                {downloadState === "downloading" && downloadProgress != null && (
                    <div className="app-update-progress" aria-hidden>
                        <span style={{ width: `${Math.max(downloadProgress, 4)}%` }} />
                    </div>
                )}

                {downloadError && downloadState !== "downloading" && (
                    <span className="app-update-error">{downloadError}</span>
                )}

                <div className="app-update-actions">
                    {canInstallInApp() && (
                        <button
                            type="button"
                            className="btn-primary"
                            disabled={isBusy}
                            onClick={() => void handleDownload()}
                        >
                            {isBusy ? t("update.working") : t("update.download")}
                        </button>
                    )}
                    {!isForced && (
                        <button
                            type="button"
                            className="btn-secondary"
                            onClick={handleDismiss}
                        >
                            {t("update.later")}
                        </button>
                    )}
                </div>
            </div>
        </UpdateBannerShell>
    );
}

export function SettingsUpdateActions() {
    const { t } = useI18n();
    const [status, setStatus] = useState<string>("");
    const [busy, setBusy] = useState(false);
    const [availableUpdate, setAvailableUpdate] = useState<AppUpdateInfo | null>(null);
    const [downloadState, setDownloadState] = useState<AppUpdateDownloadEvent["state"] | null>(null);
    const listenerRef = useRef<{ remove: () => void } | null>(null);

    useEffect(() => {
        return () => {
            listenerRef.current?.remove();
            listenerRef.current = null;
        };
    }, []);

    const handleCheck = async () => {
        setBusy(true);
        setStatus("");
        setAvailableUpdate(null);
        try {
            const result = await checkForAppUpdate({ force: true });
            if (!result) {
                setStatus(t("update.latest"));
                return;
            }
            setAvailableUpdate(result);
            setStatus(t("update.available", { version: result.manifest.version }));
        } catch (error) {
            setStatus(error instanceof Error ? error.message : "Update check failed");
        } finally {
            setBusy(false);
        }
    };

    const handleDownload = async () => {
        if (!availableUpdate || !canInstallInApp()) return;
        setDownloadState("downloading");
        setStatus("Downloading update in the app…");

        try {
            listenerRef.current?.remove();
            const handle = await AppUpdateNative.addListener("downloadProgress", event => {
                setDownloadState(event.state);
                if (event.state === "downloading") {
                    setStatus(`Downloading update… ${event.progress}%`);
                }
                if (event.state === "installing") {
                    setStatus("Opening installer…");
                }
                if (event.state === "completed") {
                    setStatus("Tap Install on the system prompt to finish updating.");
                }
                if (event.state === "error") {
                    setStatus(event.message || "Download failed");
                }
                if (event.state === "needs_permission") {
                    setStatus(event.message || "Allow installs from Sakura, then try again.");
                }
                if (event.state === "completed" || event.state === "error" || event.state === "needs_permission") {
                    listenerRef.current?.remove();
                    listenerRef.current = null;
                }
            });
            listenerRef.current = handle;

            await startInAppUpdate(availableUpdate.manifest.apkUrl, event => {
                setDownloadState(event.state);
                if (event.message) setStatus(event.message);
                if (event.state === "completed" || event.state === "error" || event.state === "needs_permission") {
                    listenerRef.current?.remove();
                    listenerRef.current = null;
                }
            });
        } catch (error) {
            setDownloadState("error");
            setStatus(error instanceof Error ? error.message : "Download failed");
            listenerRef.current?.remove();
            listenerRef.current = null;
        }
    };

    return (
        <div className="setting-item">
            <div className="setting-info">
                <span className="setting-name">App updates</span>
                <span className="setting-desc">
                    {status || `Download updates inside Sakura via ${getAppUpdateSourceLabel()}.`}
                </span>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {availableUpdate && canInstallInApp() && (
                    <button
                        type="button"
                        className="btn-primary"
                        disabled={downloadState === "downloading" || downloadState === "installing"}
                        onClick={() => void handleDownload()}
                        style={{ fontSize: 13, padding: "8px 16px" }}
                    >
                        Download update
                    </button>
                )}
                <button
                    type="button"
                    className="btn-secondary"
                    disabled={busy}
                    onClick={() => void handleCheck()}
                    style={{ fontSize: 13, padding: "8px 16px" }}
                >
                    {busy ? "Checking…" : "Check now"}
                </button>
            </div>
        </div>
    );
}

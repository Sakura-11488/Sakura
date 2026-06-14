import { registerPlugin, PluginListenerHandle } from "@capacitor/core";

export interface AppUpdateDownloadEvent {
    progress: number;
    state: "downloading" | "installing" | "completed" | "needs_permission" | "error";
    message?: string;
}

export interface AppUpdateBuildInfo {
    versionCode: number;
    versionName: string;
}

interface AppUpdatePlugin {
    getBuildInfo(): Promise<AppUpdateBuildInfo>;
    canInstallPackages(): Promise<{ allowed: boolean }>;
    openInstallPermissionSettings(): Promise<void>;
    downloadAndInstall(options: { url: string }): Promise<{ started: boolean }>;
    addListener(
        eventName: "downloadProgress",
        handler: (event: AppUpdateDownloadEvent) => void
    ): Promise<PluginListenerHandle>;
}

export const AppUpdateNative = registerPlugin<AppUpdatePlugin>("AppUpdate");

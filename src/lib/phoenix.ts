import { isElectron } from "./platform";

const PHOENIX_URL = "https://www.phoenix.trade/";

interface ElectronPhoenixApi {
    openPhoenix?: (options?: { publicKey?: string; autoConnect?: boolean }) => Promise<{ ok: boolean; error?: string }>;
    closePhoenix?: () => Promise<{ ok: boolean }>;
    isPhoenixOpen?: () => Promise<boolean>;
}

function getPhoenixApi(): ElectronPhoenixApi | null {
    if (typeof window === "undefined") return null;
    const api = (window as unknown as { electronAPI?: ElectronPhoenixApi }).electronAPI;
    return api?.openPhoenix ? api : null;
}

export async function openPhoenixTrade(publicKey?: string | null): Promise<{ ok: boolean; error?: string }> {
    const api = getPhoenixApi();
    if (!api?.openPhoenix) {
        return {
            ok: false,
            error: "Phoenix trading is available in the Sakura desktop app.",
        };
    }
    return api.openPhoenix({
        publicKey: publicKey || undefined,
        autoConnect: Boolean(publicKey),
    });
}

export async function closePhoenixTrade(): Promise<void> {
    const api = getPhoenixApi();
    if (api?.closePhoenix) await api.closePhoenix();
}

export function canOpenPhoenixTrade(): boolean {
    return isElectron() && Boolean(getPhoenixApi()?.openPhoenix);
}

export { PHOENIX_URL };

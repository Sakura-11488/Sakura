import { Capacitor } from '@capacitor/core';

export function isElectron(): boolean {
    if (typeof window === 'undefined') return false;
    if ((window as any).electronAPI?.isElectron) return true;
    if (typeof navigator !== 'undefined' && /electron/i.test(navigator.userAgent)) return true;
    return false;
}

export function isNativeMobile(): boolean {
    try {
        return Capacitor.isNativePlatform();
    } catch {
        return false;
    }
}

export function isDesktop(): boolean {
    return isElectron() || (typeof window !== 'undefined' && !isNativeMobile());
}

export async function safeClipboardWrite(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        try {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
            return true;
        } catch {
            return false;
        }
    }
}

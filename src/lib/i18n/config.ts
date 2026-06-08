export const DEFAULT_LOCALE = "en";

export const SUPPORTED_LOCALES = [
    { code: "en", name: "English", nativeName: "English", dir: "ltr" },
    { code: "ja", name: "Japanese", nativeName: "日本語", dir: "ltr" },
    { code: "es", name: "Spanish", nativeName: "Español", dir: "ltr" },
    { code: "fr", name: "French", nativeName: "Français", dir: "ltr" },
    { code: "pt", name: "Portuguese", nativeName: "Português", dir: "ltr" },
    { code: "ko", name: "Korean", nativeName: "한국어", dir: "ltr" },
    { code: "zh-CN", name: "Chinese Simplified", nativeName: "简体中文", dir: "ltr" },
    { code: "de", name: "German", nativeName: "Deutsch", dir: "ltr" },
    { code: "hi", name: "Hindi", nativeName: "हिन्दी", dir: "ltr" },
    { code: "ar", name: "Arabic", nativeName: "العربية", dir: "rtl" },
    { code: "id", name: "Indonesian", nativeName: "Bahasa Indonesia", dir: "ltr" },
    { code: "vi", name: "Vietnamese", nativeName: "Tiếng Việt", dir: "ltr" },
    { code: "ru", name: "Russian", nativeName: "Русский", dir: "ltr" },
    { code: "uk", name: "Ukrainian", nativeName: "Українська", dir: "ltr" },
    { code: "comrade", name: "Comrade Mode", nativeName: "BURNIE COMRADE MODE", dir: "ltr" },
] as const;

export type Locale = typeof SUPPORTED_LOCALES[number]["code"];
export type LocaleDirection = typeof SUPPORTED_LOCALES[number]["dir"];

export function isSupportedLocale(locale: string | null | undefined): locale is Locale {
    return SUPPORTED_LOCALES.some(item => item.code === locale);
}

export function getLocaleDirection(locale: Locale): LocaleDirection {
    return SUPPORTED_LOCALES.find(item => item.code === locale)?.dir || "ltr";
}

export function detectDeviceLocale(): Locale {
    if (typeof navigator === "undefined") return DEFAULT_LOCALE;
    const candidates = navigator.languages?.length ? navigator.languages : [navigator.language];
    for (const candidate of candidates) {
        const normalized = candidate.toLowerCase();
        const exact = SUPPORTED_LOCALES.find(item => item.code.toLowerCase() === normalized);
        if (exact) return exact.code;
        const base = SUPPORTED_LOCALES.find(item => item.code.toLowerCase().split("-")[0] === normalized.split("-")[0]);
        if (base) return base.code;
    }
    return DEFAULT_LOCALE;
}

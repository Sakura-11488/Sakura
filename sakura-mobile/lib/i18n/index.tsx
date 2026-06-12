import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { AppSettings } from '@/lib/settings';
import {
  DEFAULT_LOCALE,
  Locale,
  SUPPORTED_LOCALES,
  detectDeviceLocale,
  getLocaleDirection,
  isSupportedLocale,
} from './config';
import { defaultMessages, messages, TranslationKey } from './messages';

type TranslateValues = Record<string, string | number>;

interface I18nContextValue {
  locale: Locale;
  ready: boolean;
  setLocale: (locale: Locale) => void;
  t: (key: TranslationKey, values?: TranslateValues) => string;
  dir: 'ltr' | 'rtl';
  locales: typeof SUPPORTED_LOCALES;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function format(template: string, values?: TranslateValues): string {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
  );
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const stored = await AppSettings.getLocaleRaw();
        if (!active) return;
        if (isSupportedLocale(stored)) {
          setLocaleState(stored);
        } else {
          setLocaleState(detectDeviceLocale());
        }
      } catch {
        if (active) setLocaleState(DEFAULT_LOCALE);
      } finally {
        if (active) setReady(true);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    AppSettings.setLocale(next).catch(() => {});
  }, []);

  const t = useCallback(
    (key: TranslationKey, values?: TranslateValues) => {
      const dict = messages[locale] || defaultMessages;
      const template = dict[key] ?? defaultMessages[key] ?? key;
      return format(template, values);
    },
    [locale],
  );

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      ready,
      setLocale,
      t,
      dir: getLocaleDirection(locale),
      locales: SUPPORTED_LOCALES,
    }),
    [locale, ready, setLocale, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    // Graceful fallback so screens render before the provider mounts.
    return {
      locale: DEFAULT_LOCALE,
      ready: false,
      setLocale: () => {},
      t: (key, values) => format(defaultMessages[key] ?? String(key), values),
      dir: 'ltr',
      locales: SUPPORTED_LOCALES,
    };
  }
  return ctx;
}

export { SUPPORTED_LOCALES } from './config';
export type { Locale } from './config';

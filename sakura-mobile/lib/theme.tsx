import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { Appearance } from 'react-native';
import { AppSettings } from './settings';

export const LightColors = {
  primary:          '#E84545',
  primaryLight:     '#FF6B6B',
  primaryDark:      '#C0392B',
  background:       '#F2F2F7',
  surface:          '#FFFFFF',
  surfaceSecondary: '#F8F8FB',
  surfaceTertiary:  '#EFEFEF',
  text:             '#1A1A1A',
  textSecondary:    '#8E8E93',
  textTertiary:     '#AEAEB2',
  border:           '#E5E5EA',
  borderLight:      '#F0F0F5',
  overlay:          'rgba(0,0,0,0.4)',
  overlayDark:      'rgba(0,0,0,0.65)',
  white:            '#FFFFFF',
  black:            '#000000',
  success:          '#34C759',
  warning:          '#FF9500',
  red:              '#E84545',
  gold:             '#F5A623',
  tabBarBg:         'rgba(255,255,255,0.75)',
  tabBarBorder:     'rgba(255,255,255,0.6)',
  blurTint:         'systemMaterialLight' as const,
};

export const DarkColors = {
  primary:          '#E84545',
  primaryLight:     '#FF6B6B',
  primaryDark:      '#C0392B',
  background:       '#0F0F13',
  surface:          '#1C1C21',
  surfaceSecondary: '#252529',
  surfaceTertiary:  '#2C2C30',
  text:             '#F2F2F7',
  textSecondary:    '#98989F',
  textTertiary:     '#636366',
  border:           '#3A3A3E',
  borderLight:      '#2C2C30',
  overlay:          'rgba(0,0,0,0.6)',
  overlayDark:      'rgba(0,0,0,0.82)',
  white:            '#1C1C21',
  black:            '#F2F2F7',
  success:          '#30D158',
  warning:          '#FF9F0A',
  red:              '#FF453A',
  gold:             '#FFD60A',
  tabBarBg:         'rgba(28,28,33,0.88)',
  tabBarBorder:     'rgba(255,255,255,0.07)',
  blurTint:         'systemMaterialDark' as const,
};

export type AppColors = Omit<typeof LightColors, 'blurTint'> & {
  blurTint: 'systemMaterialLight' | 'systemMaterialDark';
};

interface ThemeCtx {
  isDark: boolean;
  toggleTheme: () => void;
  colors: AppColors;
}

const ThemeContext = createContext<ThemeCtx>({
  isDark: true,
  toggleTheme: () => {},
  colors: DarkColors,
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [isDark, setIsDark] = useState(true);

  // Appearance.setColorScheme only exists on native. On web it is undefined, so
  // calling it threw an uncaught TypeError from inside the theme init promise
  // and took the render tree down with it — which is why navigating back
  // sometimes landed on a blank white page that only a refresh recovered.
  const applyColorScheme = useCallback((dark: boolean) => {
    Appearance.setColorScheme?.(dark ? 'dark' : 'light');
  }, []);

  useEffect(() => {
    (async () => {
      const raw = await AppSettings.getDarkModeRaw();
      const saved = raw === null ? true : raw === 'true';
      if (raw === null) await AppSettings.setDarkMode(true);
      setIsDark(saved);
      applyColorScheme(saved);
    })();
  }, []);

  const toggleTheme = useCallback(async () => {
    const next = !isDark;
    setIsDark(next);
    await AppSettings.setDarkMode(next);
    applyColorScheme(next);
  }, [isDark]);

  const colors = useMemo(() => (isDark ? DarkColors : LightColors), [isDark]);

  return (
    <ThemeContext.Provider value={{ isDark, toggleTheme, colors }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}

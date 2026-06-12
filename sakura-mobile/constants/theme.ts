export const Colors = {
  primary: '#E84545',
  primaryLight: '#FF6B6B',
  primaryDark: '#C0392B',
  background: '#F2F2F7',
  surface: '#FFFFFF',
  surfaceSecondary: '#F8F8FB',
  text: '#1A1A1A',
  textSecondary: '#8E8E93',
  textTertiary: '#AEAEB2',
  border: '#E5E5EA',
  borderLight: '#F0F0F5',
  overlay: 'rgba(0,0,0,0.4)',
  overlayDark: 'rgba(0,0,0,0.65)',
  white: '#FFFFFF',
  black: '#000000',
  success: '#34C759',
  warning: '#FF9500',
  red: '#E84545',
  gold: '#F5A623',
};

// ─── Fonts ────────────────────────────────────────────────────────────────────
// display = system SF Pro (iOS) / Roboto (Android) — bold weight applied separately
// body    = Nunito (clean, readable)
export const Fonts = {
  display: undefined as string | undefined,
  displayWeight: '800' as const,
  body: 'Nunito_400Regular',
  bodyMedium: 'Nunito_600SemiBold',
  bodyBold: 'Nunito_700Bold',
  bodyHeavy: 'Nunito_800ExtraBold',
  mono: undefined as string | undefined,
};

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
};

export const Radius = {
  xs: 2,
  sm: 4,
  md: 6,
  lg: 12,
  xl: 18,
  full: 999,
};

export const FontSize = {
  xs: 11,
  sm: 12,
  md: 14,
  lg: 16,
  xl: 18,
  xxl: 20,
  xxxl: 22,
  display: 24,
};

export const FontWeight = {
  regular: '400' as const,
  medium: '500' as const,
  semibold: '600' as const,
  bold: '700' as const,
  heavy: '800' as const,
};

export const Shadow = {
  sm: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 6,
    elevation: 2,
  },
  md: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 5,
  },
  lg: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.15,
    shadowRadius: 20,
    elevation: 10,
  },
  card: {
    shadowColor: '#E84545',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.2,
    shadowRadius: 24,
    elevation: 12,
  },
};

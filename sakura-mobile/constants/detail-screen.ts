import { Dimensions, StyleSheet } from 'react-native';
import { Fonts, FontSize, Radius, Spacing } from './theme';

const { width: DETAIL_SCREEN_WIDTH } = Dimensions.get('window');

export const DETAIL_HERO_H = DETAIL_SCREEN_WIDTH * 0.88;
export const DETAIL_CONTENT_OVERLAP = -50;
export const DETAIL_CONTENT_PADDING_TOP = 18;
export const DETAIL_HEADER_TRIGGER = Math.round(DETAIL_HERO_H * 0.35);
export const DETAIL_HEADER_FADE = 48;
export const DETAIL_HERO_IMAGE_PROPS = {
  contentFit: 'cover' as const,
  contentPosition: 'top' as const,
};

type DetailThemeColors = {
  background: string;
  surface: string;
  border: string;
  text: string;
  textSecondary: string;
  textTertiary: string;
  primary: string;
  gold: string;
};

/** Shared layout + typography for anime / novel / manga detail screens. */
export function createDetailScreenStyles(colors: DetailThemeColors) {
  return StyleSheet.create({
    content: {
      marginTop: DETAIL_CONTENT_OVERLAP,
      paddingTop: DETAIL_CONTENT_PADDING_TOP,
      paddingHorizontal: Spacing.md,
      backgroundColor: colors.background,
    },
    badgeRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      flexWrap: 'wrap',
      marginBottom: 10,
    },
    metaPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      borderRadius: Radius.full,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 10,
      paddingVertical: 6,
      backgroundColor: colors.surface,
    },
    metaPillAccent: {
      borderColor: `${colors.primary}35`,
      backgroundColor: `${colors.primary}10`,
    },
    metaPillText: {
      fontSize: FontSize.xs,
      fontFamily: Fonts.bodyMedium,
      color: colors.textSecondary,
    },
    metaPillTextAccent: {
      fontSize: FontSize.xs,
      fontFamily: Fonts.bodyBold,
      color: colors.primary,
    },
    metaRating: {
      fontSize: FontSize.xs,
      fontFamily: Fonts.bodyBold,
      color: colors.gold,
    },
    metaRatingSub: {
      fontSize: 10,
      fontFamily: Fonts.body,
      color: colors.textTertiary,
    },
    statusDot: { width: 6, height: 6, borderRadius: 3 },
    title: {
      color: colors.text,
      fontSize: 24,
      fontWeight: '800',
      lineHeight: 30,
      letterSpacing: 0.2,
      marginBottom: 8,
    },
    ratingRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      marginBottom: 10,
    },
    rating: { color: colors.gold, fontSize: FontSize.sm, fontFamily: Fonts.bodyBold },
    ratingMax: { color: colors.textSecondary, fontSize: FontSize.xs },
    ratingDivider: { width: 1, height: 10, backgroundColor: colors.border, marginHorizontal: 3 },
    countText: { color: colors.textSecondary, fontSize: FontSize.xs, fontFamily: Fonts.bodyMedium },
    genreRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginBottom: 12 },
    genreChip: {
      borderRadius: Radius.full,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 10,
      paddingVertical: 6,
      backgroundColor: colors.surface,
    },
    genreChipText: { color: colors.textSecondary, fontSize: FontSize.xs, fontFamily: Fonts.bodyMedium },
    synopsis: {
      color: colors.textSecondary,
      fontSize: 13.5,
      lineHeight: 20,
      marginBottom: 4,
      fontFamily: Fonts.body,
    },
    seeMore: {
      color: colors.primary,
      fontSize: FontSize.xs,
      fontFamily: Fonts.bodyMedium,
      marginTop: 4,
      marginBottom: 16,
    },
    tabs: {
      flexDirection: 'row',
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      marginBottom: 14,
      marginTop: 4,
    },
    tab: { flex: 1, paddingVertical: 9, alignItems: 'center' },
    tabActive: { borderBottomWidth: 2, borderBottomColor: colors.primary, marginBottom: -1 },
    tabText: { color: colors.textSecondary, fontSize: FontSize.xs, fontFamily: Fonts.bodyMedium },
    tabTextActive: { color: colors.text, fontFamily: Fonts.bodyBold, fontSize: FontSize.sm },
  });
}

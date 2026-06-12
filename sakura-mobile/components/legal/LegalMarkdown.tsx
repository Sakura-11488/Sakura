import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { FontSize, FontWeight, Spacing } from '@/constants/theme';
import type { AppColors } from '@/lib/theme';

function parseInline(text: string, colors: AppColors): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <Text key={i} style={{ fontWeight: FontWeight.bold, color: colors.text }}>
          {part.slice(2, -2)}
        </Text>
      );
    }
    return part;
  });
}

export default function LegalMarkdown({ content, colors }: { content: string; colors: AppColors }) {
  const blocks = useMemo(() => {
    const lines = content.split('\n');
    const nodes: React.ReactNode[] = [];
    let bullets: string[] = [];

    const flushBullets = (key: string) => {
      if (bullets.length === 0) return;
      nodes.push(
        <View key={key} style={styles.bulletBlock}>
          {bullets.map((b, i) => (
            <View key={i} style={styles.bulletRow}>
              <Text style={[styles.bulletDot, { color: colors.textSecondary }]}>•</Text>
              <Text style={[styles.body, { color: colors.textSecondary, flex: 1 }]}>
                {parseInline(b, colors)}
              </Text>
            </View>
          ))}
        </View>,
      );
      bullets = [];
    };

    lines.forEach((line, idx) => {
      const trimmed = line.trim();

      if (trimmed.startsWith('- ')) {
        bullets.push(trimmed.slice(2));
        return;
      }
      flushBullets(`bullets-${idx}`);

      if (!trimmed) {
        nodes.push(<View key={`sp-${idx}`} style={{ height: Spacing.sm }} />);
        return;
      }
      if (trimmed.startsWith('# ')) return;
      if (trimmed.startsWith('### ')) {
        nodes.push(
          <Text key={idx} style={[styles.h3, { color: colors.text }]}>
            {trimmed.slice(4)}
          </Text>,
        );
        return;
      }
      if (trimmed.startsWith('## ')) {
        nodes.push(
          <Text key={idx} style={[styles.h2, { color: colors.text }]}>
            {trimmed.slice(3)}
          </Text>,
        );
        return;
      }
      nodes.push(
        <Text key={idx} style={[styles.body, { color: colors.textSecondary }]}>
          {parseInline(trimmed, colors)}
        </Text>,
      );
    });
    flushBullets('bullets-end');
    return nodes;
  }, [content, colors]);

  return <View style={styles.wrap}>{blocks}</View>;
}

const styles = StyleSheet.create({
  wrap: { paddingBottom: Spacing.sm },
  h2: { fontSize: FontSize.md, fontWeight: FontWeight.bold, marginTop: Spacing.md, marginBottom: 6 },
  h3: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, marginTop: Spacing.sm, marginBottom: 4 },
  body: { fontSize: FontSize.sm, lineHeight: 21, marginBottom: 4 },
  bulletBlock: { marginTop: 4, marginBottom: 4, gap: 6 },
  bulletRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  bulletDot: { fontSize: FontSize.sm, lineHeight: 21, width: 12 },
});

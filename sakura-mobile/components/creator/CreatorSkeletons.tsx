import React from 'react';
import { View, StyleSheet, Dimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ShimmerBox } from '@/components/ui/ShimmerLoader';
import { Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/lib/theme';

const { width: W } = Dimensions.get('window');
const PAD = Spacing.md;
const INNER = W - PAD * 2;
const WORK_W = (INNER - Spacing.sm) / 2;

function Shell({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  return (
    <SafeAreaView style={[sk.safe, { backgroundColor: colors.background }]} edges={['top']}>
      {children}
    </SafeAreaView>
  );
}

export function CreatorDashboardSkeleton() {
  return (
    <Shell>
      <View style={sk.pad}>
        <ShimmerBox width={INNER} height={200} borderRadius={Radius.xl} />
        <View style={sk.statsRow}>
          {[0, 1, 2, 3].map((i) => (
            <ShimmerBox key={i} width={(INNER - Spacing.sm * 3) / 4} height={72} borderRadius={Radius.lg} />
          ))}
        </View>
        <ShimmerBox width={INNER} height={88} borderRadius={Radius.xl} style={{ marginBottom: Spacing.sm }} />
        <ShimmerBox width={INNER} height={112} borderRadius={Radius.lg} style={{ marginBottom: Spacing.lg }} />
        <View style={sk.sectionHead}>
          <ShimmerBox width={100} height={12} borderRadius={4} />
          <ShimmerBox width={72} height={12} borderRadius={4} />
        </View>
        <View style={sk.grid}>
          {[0, 1, 2, 3].map((i) => (
            <ShimmerBox key={i} width={WORK_W} height={WORK_W * 1.55} borderRadius={Radius.lg} />
          ))}
        </View>
      </View>
    </Shell>
  );
}

export function CreatorUploadSkeleton() {
  return (
    <Shell>
      <View style={sk.header}>
        <ShimmerBox width={40} height={40} borderRadius={20} />
        <ShimmerBox width={140} height={24} borderRadius={6} />
        <View style={{ width: 40 }} />
      </View>
      <View style={sk.steps}>
        {[0, 1, 2].map((i) => (
          <ShimmerBox key={i} width={(INNER - 16) / 3} height={4} borderRadius={2} />
        ))}
      </View>
      <View style={sk.pad}>
        <ShimmerBox width={INNER} height={120} borderRadius={Radius.xl} style={{ marginBottom: Spacing.md }} />
        <ShimmerBox width={INNER} height={220} borderRadius={Radius.lg} style={{ marginBottom: Spacing.md }} />
        <ShimmerBox width={120} height={14} borderRadius={4} style={{ marginBottom: 8 }} />
        <ShimmerBox width={INNER} height={48} borderRadius={Radius.md} style={{ marginBottom: Spacing.sm }} />
        <ShimmerBox width={120} height={14} borderRadius={4} style={{ marginBottom: 8 }} />
        <ShimmerBox width={INNER} height={100} borderRadius={Radius.md} style={{ marginBottom: Spacing.sm }} />
        <ShimmerBox width={INNER} height={52} borderRadius={Radius.full} style={{ marginTop: Spacing.md }} />
      </View>
    </Shell>
  );
}

export function CreatorProfileSkeleton() {
  return (
    <Shell>
      <View style={sk.header}>
        <ShimmerBox width={40} height={40} borderRadius={20} />
        <ShimmerBox width={120} height={24} borderRadius={6} />
        <View style={{ width: 40 }} />
      </View>
      <View style={sk.pad}>
        <View style={sk.profileHead}>
          <ShimmerBox width={52} height={52} borderRadius={26} />
          <View style={{ flex: 1, gap: 8 }}>
            <ShimmerBox width="60%" height={18} borderRadius={4} />
            <ShimmerBox width="80%" height={14} borderRadius={4} />
          </View>
        </View>
        <ShimmerBox width={120} height={32} borderRadius={Radius.full} style={{ marginBottom: Spacing.lg }} />
        <ShimmerBox width={100} height={14} borderRadius={4} style={{ marginBottom: 8 }} />
        <ShimmerBox width={INNER} height={48} borderRadius={Radius.md} style={{ marginBottom: Spacing.md }} />
        <ShimmerBox width={60} height={14} borderRadius={4} style={{ marginBottom: 8 }} />
        <ShimmerBox width={INNER} height={120} borderRadius={Radius.md} style={{ marginBottom: Spacing.lg }} />
        <ShimmerBox width={INNER} height={52} borderRadius={Radius.full} />
      </View>
    </Shell>
  );
}

export function BecomeCreatorSkeleton() {
  return (
    <Shell>
      <View style={sk.pad}>
        <ShimmerBox width={INNER} height={210} borderRadius={Radius.xl} style={{ marginBottom: Spacing.lg }} />
        <View style={sk.profileHead}>
          <ShimmerBox width={52} height={52} borderRadius={26} />
          <View style={{ flex: 1, gap: 8 }}>
            <ShimmerBox width="70%" height={18} borderRadius={4} />
            <ShimmerBox width="90%" height={14} borderRadius={4} />
          </View>
        </View>
        <ShimmerBox width={100} height={14} borderRadius={4} style={{ marginTop: Spacing.lg, marginBottom: 8 }} />
        <ShimmerBox width={INNER} height={48} borderRadius={Radius.md} style={{ marginBottom: Spacing.sm }} />
        <ShimmerBox width={110} height={14} borderRadius={4} style={{ marginBottom: 8 }} />
        <ShimmerBox width={INNER} height={48} borderRadius={Radius.md} style={{ marginBottom: Spacing.sm }} />
        <ShimmerBox width={60} height={14} borderRadius={4} style={{ marginBottom: 8 }} />
        <ShimmerBox width={INNER} height={100} borderRadius={Radius.md} style={{ marginBottom: Spacing.lg }} />
        <ShimmerBox width={INNER} height={52} borderRadius={Radius.full} />
      </View>
    </Shell>
  );
}

const sk = StyleSheet.create({
  safe: { flex: 1 },
  pad: { paddingHorizontal: PAD, paddingTop: Spacing.sm },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: PAD,
    paddingVertical: Spacing.sm,
  },
  statsRow: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.md, marginBottom: Spacing.md },
  sectionHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: Spacing.sm,
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  steps: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: PAD,
    marginBottom: Spacing.md,
  },
  profileHead: { flexDirection: 'row', alignItems: 'center', gap: 14 },
});

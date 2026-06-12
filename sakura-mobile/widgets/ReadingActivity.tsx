import { Image, Text, VStack } from '@expo/ui/swift-ui';
import { font, foregroundStyle, padding } from '@expo/ui/swift-ui/modifiers';
import { createLiveActivity, type LiveActivityEnvironment } from 'expo-widgets';
import type { ReadingActivityProps } from '@/lib/reading-activity-types';

export type { ReadingActivityProps };

const ReadingActivityLayout = (props: ReadingActivityProps, environment: LiveActivityEnvironment) => {
  'widget';

  const accent = props.kind === 'manga' ? '#E84545' : '#8B5CF6';
  const fg = environment.colorScheme === 'dark' ? '#FFFFFF' : '#111111';
  const icon = props.kind === 'manga' ? 'book.pages.fill' : 'book.closed.fill';

  return {
    banner: (
      <VStack modifiers={[padding({ all: 12 })]}>
        <Text modifiers={[font({ weight: 'bold', size: 14 }), foregroundStyle(accent)]}>
          Reading in Sakura
        </Text>
        <Text modifiers={[font({ weight: 'semibold', size: 13 }), foregroundStyle(fg)]}>
          {props.title}
        </Text>
        <Text modifiers={[font({ size: 12 }), foregroundStyle(fg)]}>
          {props.subtitle} - {props.progressText}
        </Text>
      </VStack>
    ),
    compactLeading: <Image systemName={icon} color={accent} />,
    compactTrailing: (
      <Text modifiers={[font({ weight: 'bold', size: 12 }), foregroundStyle(fg)]}>
        {props.progressText}
      </Text>
    ),
    minimal: <Image systemName={icon} color={accent} />,
    expandedLeading: (
      <VStack modifiers={[padding({ all: 10 })]}>
        <Image systemName={icon} color={accent} />
        <Text modifiers={[font({ size: 12 }), foregroundStyle(fg)]}>{props.kind.toUpperCase()}</Text>
      </VStack>
    ),
    expandedTrailing: (
      <VStack modifiers={[padding({ all: 10 })]}>
        <Text modifiers={[font({ weight: 'bold', size: 20 }), foregroundStyle(fg)]}>
          {Math.round(props.progressPercent * 100)}%
        </Text>
        <Text modifiers={[font({ size: 12 }), foregroundStyle(fg)]}>Progress</Text>
      </VStack>
    ),
    expandedBottom: (
      <VStack modifiers={[padding({ all: 10 })]}>
        <Text modifiers={[font({ weight: 'semibold', size: 12 }), foregroundStyle(fg)]}>
          {props.title}
        </Text>
        <Text modifiers={[font({ size: 12 }), foregroundStyle(fg)]}>
          {props.subtitle}
        </Text>
      </VStack>
    ),
  };
};

export const ReadingActivity = createLiveActivity<ReadingActivityProps>('ReadingActivity', ReadingActivityLayout);

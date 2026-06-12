import type { ConfigContext, ExpoConfig } from 'expo/config';

export default ({ config }: ConfigContext): ExpoConfig => {
  const projectId =
    process.env.EXPO_PUBLIC_EAS_PROJECT_ID?.trim() ||
    (config.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;

  return {
    ...config,
    extra: {
      ...config.extra,
      eas: {
        ...(typeof config.extra === 'object' && config.extra && 'eas' in config.extra
          ? (config.extra as { eas?: Record<string, unknown> }).eas
          : {}),
        ...(projectId ? { projectId } : {}),
      },
    },
  } as ExpoConfig;
};

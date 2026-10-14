import type { ConfigContext, ExpoConfig } from 'expo/config';

const mobile = require('../sakura-mobile/app.json').expo as ExpoConfig;

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...mobile,
  ...config,
  name: 'Sakura',
  slug: 'sakura-web',
  scheme: 'sakura',
  web: {
    bundler: 'metro',
    output: 'single',
    favicon: './assets/images/icon.png',
  },
  updates: undefined,
  ios: undefined,
  android: undefined,
  experiments: {
    typedRoutes: true,
    baseUrl: '/app',
  },
  extra: {
    ...mobile.extra,
    router: {
      ...(mobile.extra?.router ?? {}),
      origin: false,
      // Load screens on demand on web; router-context.js says which stay in
      // the main bundle. Native keeps one bundle (default: false), and its
      // builds read sakura-mobile/app.json, not this file, in any case.
      asyncRoutes: { web: true, default: false },
    },
  },
});

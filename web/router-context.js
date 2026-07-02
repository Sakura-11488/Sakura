// Metro resolves junctioned ./app files to canonical sakura-mobile paths in
// require.context keys (e.g. "../../sakura-mobile/app/index.tsx"). Expo Router
// expects keys like "./index.tsx" — normalize them here.
const rawCtx = require.context(
  './app',
  true,
  /^(?:\.\/)(?!(?:(?:(?:.*\+api)|(?:\+middleware)|(?:\+(html|native-intent))))\.[tj]sx?$).*(?:\.android|\.ios|\.native)?\.[tj]sx?$/,
);

function toRouterKey(rawKey) {
  const normalized = rawKey.replace(/\\/g, '/');
  const appSuffix = normalized.match(/\/app\/(.+)$/);
  if (appSuffix) return './' + appSuffix[1];
  if (normalized.startsWith('./')) return normalized;
  return './' + normalized.replace(/^(\.\.\/)+/, '');
}

const routerToRaw = new Map();
for (const rawKey of rawCtx.keys()) {
  const routerKey = toRouterKey(rawKey);
  if (!routerToRaw.has(routerKey)) {
    routerToRaw.set(routerKey, rawKey);
  }
}

function contextRequire(routerKey) {
  const rawKey = routerToRaw.get(routerKey);
  if (!rawKey) return rawCtx(routerKey);
  return rawCtx(rawKey);
}

contextRequire.keys = () => [...routerToRaw.keys()];
contextRequire.resolve = (routerKey) => {
  const rawKey = routerToRaw.get(routerKey) ?? routerKey;
  return rawCtx.resolve ? rawCtx.resolve(rawKey) : rawKey;
};
contextRequire.id = rawCtx.id;

export const ctx = contextRequire;

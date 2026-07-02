function resolveAssetSource(source) {
  if (source == null) {
    return { uri: undefined, width: undefined, height: undefined, scale: 1 };
  }

  if (typeof source === 'object') {
    if (typeof source.uri === 'string') {
      return {
        uri: source.uri,
        width: source.width,
        height: source.height,
        scale: source.scale ?? 1,
      };
    }
    if (typeof source.default === 'string') {
      return { uri: source.default, width: undefined, height: undefined, scale: 1 };
    }
    if (source.__packager_asset && typeof source.uri === 'string') {
      return {
        uri: source.uri,
        width: source.width,
        height: source.height,
        scale: source.scale ?? 1,
      };
    }
  }

  if (typeof source === 'string') {
    return { uri: source, width: undefined, height: undefined, scale: 1 };
  }

  if (typeof source === 'number') {
    try {
      const AssetRegistry = require('react-native/Libraries/Image/AssetRegistry');
      if (typeof AssetRegistry?.getAssetByID === 'function') {
        const asset = AssetRegistry.getAssetByID(source);
        if (asset) {
          const uri =
            typeof AssetRegistry.getAssetPath === 'function'
              ? AssetRegistry.getAssetPath(asset)
              : asset.httpServerLocation
                ? `${asset.httpServerLocation}/${asset.name}.${asset.type}`
                : undefined;
          if (uri) {
            return { uri, width: asset.width, height: asset.height, scale: asset.scale ?? 1 };
          }
        }
      }
    } catch {
      // Metro web may not expose the native asset registry.
    }
  }

  return { uri: String(source), width: undefined, height: undefined, scale: 1 };
}

function patchResolveAssetSource(ImageLike) {
  if (!ImageLike) return;
  if (typeof ImageLike.resolveAssetSource !== 'function') {
    ImageLike.resolveAssetSource = resolveAssetSource;
  }
  if (ImageLike.default && typeof ImageLike.default.resolveAssetSource !== 'function') {
    ImageLike.default.resolveAssetSource = resolveAssetSource;
  }
}

module.exports = { resolveAssetSource, patchResolveAssetSource };

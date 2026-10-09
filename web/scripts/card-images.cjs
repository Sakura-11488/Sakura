const fs = require('node:fs');
const path = require('node:path');

// Only bundled series artwork, never icons, logos or reader page images.
const CARD_IMAGE_NAMES = Object.freeze([
  'burnie-senders-poster.png',
  '2he.jpg',
  'psyopanime.png',
  'degenfiles.jpeg',
  'degenfiles-ep1.jpeg',
]);

function generatedCardImagePath(webRoot, sourceName) {
  // Expo retains this directory in exported URLs. Avoid hidden directories,
  // which static hosting uploaders may omit from a deployment.
  return path.join(webRoot, 'generated/card-images', `${path.parse(sourceName).name}.webp`);
}

function resolveWebCardImages(resolution, platform, { mobileRoot, webRoot }) {
  if (platform !== 'web' || resolution.type !== 'assetFiles') return resolution;
  const allowedDirectories = [mobileRoot, webRoot].map((root) => path.join(root, 'assets/images'));
  return {
    ...resolution,
    filePaths: resolution.filePaths.map((sourcePath) => {
      const sourceName = path.basename(sourcePath);
      if (!allowedDirectories.includes(path.dirname(sourcePath)) || !CARD_IMAGE_NAMES.includes(sourceName)) {
        return sourcePath;
      }
      const generated = generatedCardImagePath(webRoot, sourceName);
      // Standard build/start commands prepare these first. A direct Metro
      // invocation remains usable before the first generation.
      return fs.existsSync(generated) ? generated : sourcePath;
    }),
  };
}

module.exports = { CARD_IMAGE_NAMES, generatedCardImagePath, resolveWebCardImages };

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import cardImages from './card-images.cjs';

const { CARD_IMAGE_NAMES, generatedCardImagePath } = cardImages;
const defaultWebRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function prepareCardImages({
  webRoot = defaultWebRoot,
  mobileRoot = path.resolve(webRoot, '../sakura-mobile'),
} = {}) {
  const results = [];
  for (const name of CARD_IMAGE_NAMES) {
    const source = path.join(mobileRoot, 'assets/images', name);
    const destination = generatedCardImagePath(webRoot, name);
    const original = await fs.readFile(source);
    const { data, info } = await sharp(original)
      .rotate()
      .resize({ width: 960, height: 960, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82, effort: 5 })
      .toBuffer({ resolveWithObject: true });
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const existing = await fs.readFile(destination).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    // Keep Metro's cached asset transform valid when the input is unchanged.
    if (!existing?.equals(data)) await fs.writeFile(destination, data);
    results.push({ name, originalBytes: original.length, bytes: data.length, width: info.width, height: info.height });
  }
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const results = await prepareCardImages();
  for (const image of results) {
    console.log(`[prepare-card-images] ${image.name}: ${image.originalBytes} → ${image.bytes} bytes (${image.width}×${image.height})`);
  }
}

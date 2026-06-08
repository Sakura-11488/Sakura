const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const INPUT = path.join(__dirname, '..', 'public', 'app-icon.png');
// electron-builder.yml points at public/app-icon.ico — keep both targets in sync
// so the installer, exe resource, and tray pickup all use the same bytes.
const OUTPUTS = [
  path.join(__dirname, '..', 'public', 'app-icon.ico'),
  path.join(__dirname, '..', 'build', 'icon.ico'),
];

const SIZES = [16, 24, 32, 48, 64, 128, 256];

async function pngToIco() {
  const buffers = await Promise.all(
    SIZES.map(size =>
      sharp(INPUT)
        .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer()
    )
  );

  const imageCount = buffers.length;
  const headerSize = 6;
  const dirEntrySize = 16;
  const dirSize = dirEntrySize * imageCount;
  let dataOffset = headerSize + dirSize;

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);       // reserved
  header.writeUInt16LE(1, 2);       // ICO type
  header.writeUInt16LE(imageCount, 4);

  const dirEntries = [];
  const offsets = [];
  for (let i = 0; i < imageCount; i++) {
    const size = SIZES[i];
    const entry = Buffer.alloc(dirEntrySize);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);   // width (0 = 256)
    entry.writeUInt8(size >= 256 ? 0 : size, 1);   // height
    entry.writeUInt8(0, 2);                          // color palette
    entry.writeUInt8(0, 3);                          // reserved
    entry.writeUInt16LE(1, 4);                       // color planes
    entry.writeUInt16LE(32, 6);                      // bits per pixel
    entry.writeUInt32LE(buffers[i].length, 8);       // image size
    entry.writeUInt32LE(dataOffset, 12);             // data offset
    dirEntries.push(entry);
    offsets.push(dataOffset);
    dataOffset += buffers[i].length;
  }

  const ico = Buffer.concat([header, ...dirEntries, ...buffers]);
  for (const out of OUTPUTS) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, ico);
    console.log('Created ' + out + ' (' + ico.length + ' bytes, ' + imageCount + ' sizes)');
  }
}

pngToIco().catch(err => { console.error(err); process.exit(1); });

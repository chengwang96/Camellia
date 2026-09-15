'use strict';
// Regenerate platform icons from the master PNG without extra image libraries.
// Usage: npx electron scripts/build-icons.cjs [source.png]
const fs = require('node:fs');
const path = require('node:path');
const { app, nativeImage } = require('electron');

try {
  const assets = path.resolve(__dirname, '../assets');
  const source = nativeImage.createFromPath(path.resolve(process.argv[2] || path.join(assets, 'icon-1024.png')));
  if (source.isEmpty()) throw new Error('Cannot read the source icon');
  const png = size => source.resize({ width: size, height: size, quality: 'best' }).toPNG();
  fs.writeFileSync(path.join(assets, 'icon-1024.png'), png(1024));
  fs.writeFileSync(path.join(assets, 'icon-256.png'), png(256));

  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const frames = sizes.map(png);
  const header = Buffer.alloc(6 + 16 * frames.length);
  header.writeUInt16LE(1, 2); // ICO
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  for (let i = 0; i < frames.length; i++) {
    const entry = 6 + 16 * i;
    header[entry] = header[entry + 1] = sizes[i] % 256;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(frames[i].length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += frames[i].length;
  }
  fs.writeFileSync(path.join(assets, 'icon.ico'), Buffer.concat([header, ...frames]));
  console.log('Generated 1024px and 256px PNGs, plus a 7-size Windows ICO.');
  app.exit(0);
} catch (error) {
  console.error(error.message);
  app.exit(1);
}

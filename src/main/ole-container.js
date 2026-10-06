'use strict';

// OLE2 / CFBF compound-file reader shared by the legacy Office previewers.
// `.doc`, `.xls` and `.ppt` all store their real payload inside one of these
// containers, so the FAT/DIFAT/mini-FAT walk lives here once instead of being
// re-implemented per format. It only ever returns named streams, never the
// whole file, and every walk is bounded.

const fs = require('node:fs');

const OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const FREESECT = 0xffffffff, ENDOFCHAIN = 0xfffffffe, FATSECT = 0xfffffffd, DIFSECT = 0xfffffffc;

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_SECTORS = 1 << 22;
const MAX_DIRECTORY_ENTRIES = 4096;

function isCompoundFile(filePath) {
  let handle;
  try {
    handle = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(8);
    return fs.readSync(handle, header, 0, 8, 0) === 8 && header.equals(OLE_SIGNATURE);
  } catch { return false; }
  finally { if (handle !== undefined) try { fs.closeSync(handle); } catch {} }
}

// Returns `{ data, entries }` for a compound file. `data` is the whole container
// buffer, which the format-specific readers slice with `readStream`.
function readCompoundFile(filePath) {
  if (fs.statSync(filePath).size > MAX_FILE_BYTES) throw new Error('This document is too large to preview.');
  const data = fs.readFileSync(filePath);
  if (data.length < 512 || !data.subarray(0, 8).equals(OLE_SIGNATURE)) throw new Error('This file is not an OLE2 compound document.');
  const sectorShift = data.readUInt16LE(30);
  const miniSectorShift = data.readUInt16LE(32);
  if (sectorShift < 7 || sectorShift > 14 || miniSectorShift !== 6) throw new Error('Unsupported compound-file layout.');
  const sectorSize = 1 << sectorShift, miniSectorSize = 1 << miniSectorShift;
  const offset = index => (index + 1) * sectorSize;
  const miniCutoff = data.readUInt32LE(56);

  const fatSectors = [];
  for (let index = 0; index < 109; index++) {
    const sector = data.readUInt32LE(76 + index * 4);
    if (sector !== FREESECT) fatSectors.push(sector);
  }
  let difat = data.readUInt32LE(68), guard = 0;
  const perSector = sectorSize >> 2;
  while (difat !== ENDOFCHAIN && difat !== FREESECT && guard++ < MAX_SECTORS) {
    const base = offset(difat);
    if (base + sectorSize > data.length) break;
    for (let index = 0; index < perSector - 1; index++) {
      const sector = data.readUInt32LE(base + index * 4);
      if (sector !== FREESECT) fatSectors.push(sector);
    }
    difat = data.readUInt32LE(base + (perSector - 1) * 4);
  }
  const fat = [];
  for (const sector of fatSectors) {
    const base = offset(sector);
    if (base + sectorSize > data.length) continue;
    for (let index = 0; index < perSector; index++) fat.push(data.readUInt32LE(base + index * 4));
  }
  const chain = (start, table) => {
    const sectors = [];
    let current = start;
    while (current !== ENDOFCHAIN && current !== FREESECT && current !== FATSECT && current !== DIFSECT && current < table.length && sectors.length < MAX_SECTORS) {
      sectors.push(current); current = table[current];
    }
    return sectors;
  };
  // `baseOf` maps a sector number to its byte offset: regular file sectors are
  // shifted by the 512-byte header, mini-stream sectors start at zero.
  const readChain = (start, size, table, unit, source, baseOf) => {
    const sectors = chain(start, table);
    const buffer = Buffer.alloc(Math.min(size, sectors.length * unit));
    let written = 0;
    for (const sector of sectors) {
      const length = Math.min(unit, size - written);
      if (length <= 0) break;
      const base = baseOf(sector);
      if (base + length > source.length) break;
      source.copy(buffer, written, base, base + length);
      written += length;
    }
    return buffer.subarray(0, written);
  };
  const fileBase = sector => offset(sector);

  const directorySectors = chain(data.readUInt32LE(48), fat);
  const directory = Buffer.concat(directorySectors.map(sector => {
    const base = offset(sector);
    return base + sectorSize <= data.length ? data.subarray(base, base + sectorSize) : Buffer.alloc(0);
  }));
  const entries = [];
  for (let position = 0; position + 128 <= directory.length && entries.length < MAX_DIRECTORY_ENTRIES; position += 128) {
    const nameLength = directory.readUInt16LE(position + 64);
    entries.push({
      name: nameLength > 2 ? directory.toString('utf16le', position, position + nameLength - 2) : '',
      type: directory.readUInt8(position + 66),
      start: directory.readUInt32LE(position + 116),
      size: Number(directory.readBigUInt64LE(position + 120)),
    });
  }
  const root = entries[0];
  if (!root || root.type !== 5) throw new Error('This compound file has no root entry.');

  const miniFat = [];
  let miniSector = data.readUInt32LE(60), miniGuard = 0;
  while (miniSector !== ENDOFCHAIN && miniSector !== FREESECT && miniGuard++ < MAX_SECTORS) {
    const base = offset(miniSector);
    if (base + sectorSize > data.length) break;
    for (let index = 0; index < perSector; index++) miniFat.push(data.readUInt32LE(base + index * 4));
    miniSector = fat[miniSector];
  }
  const miniStream = readChain(root.start, root.size, fat, sectorSize, data, fileBase);
  const context = {
    data, entries, sectorSize, miniSectorSize, miniCutoff, fat, miniFat, miniStream, fileBase,
    readStream(entry) {
      const name = typeof entry === 'string' ? entry : entry?.name;
      const found = typeof entry === 'string' ? entries.find(item => item.type === 2 && item.name === name) : entry;
      if (!found) throw new Error('This document is missing its ' + (name || 'required') + ' stream.');
      if (found.size < miniCutoff) return readChain(found.start, found.size, miniFat, miniSectorSize, miniStream, sector => sector * miniSectorSize);
      return readChain(found.start, found.size, fat, sectorSize, data, fileBase);
    },
    findStream(name) {
      const wanted = /^(?:workbook|book)$/i.test(name) ? /^(?:workbook|book)$/i : new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
      return entries.find(item => item.type === 2 && wanted.test(item.name));
    },
  };
  return context;
}

module.exports = { OLE_SIGNATURE, isCompoundFile, readCompoundFile };

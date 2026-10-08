'use strict';

const fs = require('node:fs');
const { Readable, Transform } = require('node:stream');
const { pipeline, finished } = require('node:stream/promises');
const { createInflateRaw, crc32 } = require('node:zlib');
const unzipper = require('unzipper');

// Bound directory allocations before unzipper builds its array of entries.
// The classic ZIP count includes automatically added directory entries, unlike
// the exporter's 30,000 data-file limit. ZIP64 headers are accepted only within
// the same allocation budget.
const MAX_DIRECTORY_ENTRIES = 65534;
const MAX_DIRECTORY_BYTES = 64 * 1024 * 1024;
const STREAM_BYTES = 64 * 1024;
const invalid = () => new Error('This file is not a Camellia data package (invalid ZIP directory)');

async function readAt(handle, size, position) {
  const buffer = Buffer.alloc(size);
  let read = 0;
  while (read < size) {
    const { bytesRead } = await handle.read(buffer, read, size - read, position + read);
    if (!bytesRead) throw invalid();
    read += bytesRead;
  }
  return buffer;
}

function safe64(buffer, offset) {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid();
  return Number(value);
}

async function directoryBounds(file) {
  const handle = await fs.promises.open(file, 'r');
  try {
    const { size } = await handle.stat();
    if (size < 22) throw invalid();
    // EOCD plus the longest possible ZIP comment, never the archive payload.
    const tailSize = Math.min(size, 22 + 65535);
    const tail = await readAt(handle, tailSize, size - tailSize);
    let at = tail.length - 22;
    for (; at >= 0; at--) if (tail.readUInt32LE(at) === 0x06054b50
      && at + 22 + tail.readUInt16LE(at + 20) === tail.length) break;
    if (at < 0) throw invalid();
    const endOffset = size - tailSize + at;
    let disk = tail.readUInt16LE(at + 4), startDisk = tail.readUInt16LE(at + 6);
    let onDisk = tail.readUInt16LE(at + 8), count = tail.readUInt16LE(at + 10);
    let bytes = tail.readUInt32LE(at + 12), offset = tail.readUInt32LE(at + 16);
    let directoryEnd = endOffset;
    const ranges = new Map([[endOffset, size - endOffset]]);
    if (disk === 0xffff || startDisk === 0xffff || count === 0xffff || onDisk === 0xffff
      || bytes === 0xffffffff || offset === 0xffffffff) {
      if (endOffset < 20) throw invalid();
      const locator = await readAt(handle, 20, endOffset - 20);
      if (locator.readUInt32LE(0) !== 0x07064b50 || locator.readUInt32LE(4) !== 0
        || locator.readUInt32LE(16) !== 1) throw invalid();
      const zip64Offset = safe64(locator, 8);
      if (zip64Offset + 56 > endOffset - 20) throw invalid();
      const record = await readAt(handle, 56, zip64Offset);
      if (record.readUInt32LE(0) !== 0x06064b50 || safe64(record, 4) < 44) throw invalid();
      disk = record.readUInt32LE(16); startDisk = record.readUInt32LE(20);
      onDisk = safe64(record, 24); count = safe64(record, 32);
      bytes = safe64(record, 40); offset = safe64(record, 48);
      directoryEnd = zip64Offset;
      ranges.set(endOffset - 20, 20); ranges.set(zip64Offset, 56);
    }
    if (disk || startDisk || onDisk !== count || !Number.isSafeInteger(offset + bytes)
      || offset + bytes > directoryEnd || bytes < count * 46) throw invalid();
    if (count > MAX_DIRECTORY_ENTRIES || bytes > MAX_DIRECTORY_BYTES)
      throw new Error('The package ZIP directory exceeds the import memory limit');
    ranges.set(offset, bytes);
    return { size, offset, bytes, count, ranges, tailSize: size - endOffset };
  } finally { await handle.close(); }
}

async function openArchive(file) {
  const bounds = await directoryBounds(file), inputs = new Set();
  let failRead;
  const readFailure = new Promise((_resolve, reject) => { failRead = reject; });
  // unzipper normally reads from a directory offset to EOF. Restrict those
  // reads to the validated record ranges, and own their cleanup on every exit.
  const source = {
    size: async () => bounds.size,
    stream(start, length) {
      const size = bounds.ranges.get(start) ?? length;
      if (!Number.isSafeInteger(size) || size < 1 || start + size > bounds.size) throw invalid();
      const input = fs.createReadStream(file, { start, end: start + size - 1, highWaterMark: STREAM_BYTES });
      inputs.add(input); input.on('close', () => inputs.delete(input)); input.on('error', failRead);
      return input;
    },
  };
  try {
    const directory = await Promise.race([unzipper.Open.custom(source, { tailSize: bounds.tailSize }), readFailure]);
    let bytes = 0;
    for (const entry of directory.files) {
      if (entry.signature !== 0x02014b50 || entry.diskNumber || !Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 0
        || !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0
        || !Number.isSafeInteger(entry.offsetToLocalFileHeader) || entry.offsetToLocalFileHeader < 0
        || entry.offsetToLocalFileHeader + 30 + entry.compressedSize > bounds.offset) throw invalid();
      bytes += 46 + entry.fileNameLength + entry.extraFieldLength + entry.fileCommentLength;
    }
    if (bytes !== bounds.bytes || directory.files.length !== bounds.count) throw invalid();
    return { files: directory.files, dataEnd: bounds.offset };
  } finally {
    await Promise.all([...inputs].map(input => {
      const closed = finished(input, { cleanup: true }).catch(() => {});
      input.destroy(); return closed;
    }));
  }
}

// Keep only fields used by the import, rather than directory buffers, dates and
// unzipper's stream closures for every selected file across all parts.
function entryMetadata(entry, dataEnd) {
  const { path, flags, compressionMethod, compressedSize, uncompressedSize, crc32, offsetToLocalFileHeader } = entry;
  return { path, flags, compressionMethod, compressedSize, uncompressedSize, crc32, offsetToLocalFileHeader, dataEnd };
}

async function dataRange(file, entry) {
  if (entry.flags & 0x41 || ![0, 8].includes(entry.compressionMethod))
    throw new Error('The package contains an encrypted or unsupported file: ' + entry.path);
  const handle = await fs.promises.open(file, 'r');
  try {
    const header = await readAt(handle, 30, entry.offsetToLocalFileHeader);
    if (header.readUInt32LE(0) !== 0x04034b50 || header.readUInt16LE(6) & 0x41
      || header.readUInt16LE(8) !== entry.compressionMethod) throw invalid();
    const nameBytes = header.readUInt16LE(26), extraBytes = header.readUInt16LE(28);
    const start = entry.offsetToLocalFileHeader + 30 + nameBytes + extraBytes;
    if (start + entry.compressedSize > entry.dataEnd) throw invalid();
    const name = await readAt(handle, nameBytes, entry.offsetToLocalFileHeader + 30);
    if (name.toString('utf8') !== entry.path) throw invalid();
    return start;
  } finally { await handle.close(); }
}

// pipeline owns the compressed source AND inflater, so a byte-limit error or
// disk failure closes both instead of leaving an abandoned decompression alive.
async function readEntry({ file, entry, output, maxBytes, manifest = false, onChunk }) {
  const start = await dataRange(file, entry);
  let bytes = 0, checksum = 0;
  const guard = new Transform({
    highWaterMark: STREAM_BYTES,
    transform(chunk, _encoding, done) {
      const next = bytes + chunk.length;
      if (next > maxBytes || next > entry.uncompressedSize) return done(new Error(manifest
        ? 'The package manifest is damaged or unexpectedly large'
        : 'The package contains a file larger than declared or allowed: ' + entry.path));
      try {
        onChunk?.(chunk.length);
        bytes = next; checksum = crc32(chunk, checksum);
        done(null, chunk);
      } catch (error) { done(error); }
    },
    flush(done) {
      if (bytes !== entry.uncompressedSize) return done(new Error(manifest
        ? 'The package manifest is damaged' : 'The package contains an incomplete file: ' + entry.path));
      if (checksum !== entry.crc32) return done(new Error(manifest
        ? 'The package manifest is damaged' : 'The package contains a damaged file (checksum mismatch): ' + entry.path));
      done();
    },
  });
  const destination = output();
  const input = entry.compressedSize ? fs.createReadStream(file,
    { start, end: start + entry.compressedSize - 1, highWaterMark: STREAM_BYTES }) : Readable.from([]);
  if (entry.compressionMethod === 8) await pipeline(input, createInflateRaw({ chunkSize: STREAM_BYTES }), guard, destination);
  else await pipeline(input, guard, destination);
  return bytes;
}

module.exports = { openArchive, entryMetadata, readEntry };

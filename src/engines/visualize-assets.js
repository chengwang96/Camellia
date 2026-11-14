'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Papa = require('papaparse');

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const MAX_IMAGES = 16;
const MAX_DATA_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_DATA_BYTES = 8 * 1024 * 1024;
const MAX_DATA_SOURCES = 8;
const MAX_VIDEO_BYTES = 6 * 1024 * 1024;
const MAX_TOTAL_VIDEO_BYTES = 12 * 1024 * 1024;
const MAX_VIDEOS = 3;
const DATA_EXTENSIONS = new Set(['.json', '.csv', '.tsv']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.ogv', '.ogg']);
const VIDEO_MIME_BY_EXTENSION = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.ogg': 'video/ogg',
};
const MIME_BY_EXTENSION = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
};

function attributeText(value) {
  return String(value || '')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}

function escapeAttribute(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function scriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function sniffMime(buffer, extension) {
  const expected = MIME_BY_EXTENSION[extension];
  if (!expected) throw new Error('Unsupported workspace image type: ' + extension);
  if (extension === '.png' && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return expected;
  if (extension === '.jpg' || extension === '.jpeg') {
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return expected;
  }
  if (extension === '.gif' && buffer.subarray(0, 6).toString('ascii').match(/^GIF8[79]a$/)) return expected;
  if (extension === '.webp' && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
      && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return expected;
  if (extension === '.bmp' && buffer.subarray(0, 2).toString('ascii') === 'BM') return expected;
  if (extension === '.avif' && buffer.subarray(4, 12).toString('ascii').includes('ftyp')) return expected;
  if (extension === '.svg') {
    const text = buffer.subarray(0, 4096).toString('utf8').trimStart();
    if (/^<svg\b/i.test(text) && !/<script\b|<foreignObject\b|\bonload\s*=/i.test(text)) return expected;
    throw new Error('Invalid or unsafe SVG image');
  }
  throw new Error('Image contents do not match its extension: ' + extension);
}

function workspacePath(cwd, value, { kind, maxBytes }) {
  const plural = kind === 'data' ? 'data' : kind === 'video' ? 'videos' : 'images';
  if (!cwd || !fs.existsSync(cwd))
    throw new Error('Visualization ' + plural + ' require an existing workspace folder');
  const raw = attributeText(value).trim();
  if (!raw || raw.length > 4096) throw new Error('Invalid workspace ' + kind + ' path');
  if (/^(?:[a-z]+:)?\/\//i.test(raw) || /^[a-z]+:/i.test(raw))
    throw new Error('Visualization ' + plural + ' must use a workspace path, not a URL');
  const root = fs.realpathSync(cwd);
  const candidate = path.resolve(root, raw);
  let real;
  try { real = fs.realpathSync(candidate); }
  catch { throw new Error('Workspace ' + kind + ' not found: ' + raw); }
  const relative = path.relative(root, real);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('Workspace ' + kind + ' must stay inside the conversation workspace: ' + raw);
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw new Error('Workspace ' + kind + ' is not a file: ' + raw);
  if (stat.size > maxBytes)
    throw new Error('Workspace ' + kind + ' exceeds ' + maxBytes + ' bytes: ' + raw);
  return { path: real, relative: relative.replace(/\\/g, '/'), size: stat.size };
}

function workspaceFile(cwd, value) {
  return workspacePath(cwd, value, { kind: 'image', maxBytes: MAX_IMAGE_BYTES });
}

function workspaceVideoFile(cwd, value) {
  return workspacePath(cwd, value, { kind: 'video', maxBytes: MAX_VIDEO_BYTES });
}

function embedWorkspaceImages(fragment, cwd) {
  if (!/<img\b[^>]*\bdata-viz-src\s*=/i.test(fragment)) return { fragment, assets: [] };
  let count = 0, totalBytes = 0;
  const assets = [];
  const output = String(fragment).replace(/<img\b[^>]*\bdata-viz-src\s*=\s*(["'])(.*?)\1[^>]*>/gi, (tag, _quote, source) => {
    if (++count > MAX_IMAGES) throw new Error('Visualization uses more than ' + MAX_IMAGES + ' workspace images');
    const file = workspaceFile(cwd, source);
    if (totalBytes + file.size > MAX_TOTAL_BYTES)
      throw new Error('Visualization workspace images exceed ' + MAX_TOTAL_BYTES + ' bytes');
    const extension = path.extname(file.path).toLowerCase();
    const bytes = fs.readFileSync(file.path);
    if (bytes.length !== file.size) throw new Error('Workspace image changed while it was read: ' + file.relative);
    const mime = sniffMime(bytes, extension);
    const dataUrl = 'data:' + mime + ';base64,' + bytes.toString('base64');
    const cleaned = tag
      .replace(/\s+data-viz-src\s*=\s*(["']).*?\1/i, '')
      .replace(/\s+srcset\s*=\s*(["']).*?\1/i, '')
      .replace(/\s+src\s*=\s*(["']).*?\1/i, '');
    totalBytes += bytes.length;
    assets.push({ path: file.relative, bytes: bytes.length, mime });
    return cleaned.replace(/^<img\b/i, '<img src="' + dataUrl + '" data-viz-embedded="1"');
  });
  return { fragment: output, assets };
}

function sniffVideoMime(buffer, extension) {
  const expected = VIDEO_MIME_BY_EXTENSION[extension];
  if (!expected) throw new Error('Unsupported workspace video type: ' + extension);
  if ((extension === '.mp4' || extension === '.m4v' || extension === '.mov')
      && buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') return expected;
  if (extension === '.webm' && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return expected;
  if ((extension === '.ogv' || extension === '.ogg') && buffer.subarray(0, 4).toString('ascii') === 'OggS') return expected;
  throw new Error('Video contents do not match its extension: ' + extension);
}

function embedWorkspaceVideos(fragment, cwd) {
  if (!/<video\b[^>]*\bdata-viz-src\s*=/i.test(fragment)) return { fragment, assets: [] };
  let count = 0, totalBytes = 0;
  const assets = [];
  const output = String(fragment).replace(
    /<video\b[^>]*\bdata-viz-src\s*=\s*(["'])(.*?)\1[^>]*>[\s\S]*?<\/video>/gi,
    (tag, _quote, source) => {
      if (++count > MAX_VIDEOS) throw new Error('Visualization uses more than ' + MAX_VIDEOS + ' workspace videos');
      const file = workspaceVideoFile(cwd, source);
      if (totalBytes + file.size > MAX_TOTAL_VIDEO_BYTES)
        throw new Error('Visualization workspace videos exceed ' + MAX_TOTAL_VIDEO_BYTES + ' bytes');
      const extension = path.extname(file.path).toLowerCase();
      if (!VIDEO_EXTENSIONS.has(extension))
        throw new Error('Unsupported workspace video type: ' + extension);
      const bytes = fs.readFileSync(file.path);
      if (bytes.length !== file.size)
        throw new Error('Workspace video changed while it was read: ' + file.relative);
      const mime = sniffVideoMime(bytes, extension);
      const dataUrl = 'data:' + mime + ';base64,' + bytes.toString('base64');
      const opening = /^<video\b[^>]*>/i.exec(tag)?.[0] || '<video>';
      const cleaned = opening
        .replace(/\s+data-viz-src\s*=\s*(["']).*?\1/i, '')
        .replace(/\s+srcset\s*=\s*(["']).*?\1/i, '')
        .replace(/\s+src\s*=\s*(["']).*?\1/i, '');
      totalBytes += bytes.length;
      assets.push({ path: file.relative, bytes: bytes.length, mime });
      return cleaned.replace(/^<video\b/i, '<video src="' + dataUrl + '" data-viz-embedded="video"')
        + '</video>';
    });
  return { fragment: output, assets };
}

function parseWorkspaceData(buffer, extension, relative) {
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  if (extension === '.json') {
    try { return JSON.parse(text); }
    catch { throw new Error('Workspace data is not valid JSON: ' + relative); }
  }
  const parsed = Papa.parse(text, {
    header: true,
    skipEmptyLines: 'greedy',
    delimiter: extension === '.tsv' ? '\t' : ',',
  });
  if (parsed.errors?.length)
    throw new Error('Workspace data is not valid ' + (extension === '.tsv' ? 'TSV' : 'CSV')
      + ': ' + relative + ' (' + parsed.errors[0].message + ')');
  return parsed.data;
}

function dataName(tag, file) {
  const match = /\bdata-viz-name\s*=\s*(["'])(.*?)\1/i.exec(tag);
  const name = String(match ? attributeText(match[2]) : path.basename(file.relative, path.extname(file.relative))).trim();
  if (!name || [...name].length > 120 || /[\u0000-\u001f\u007f]/.test(name))
    throw new Error('Invalid visualization data name');
  return name;
}

function embedWorkspaceData(fragment, cwd) {
  if (!/<script\b[^>]*\bdata-viz-data\s*=/i.test(fragment)) return { fragment, assets: [] };
  let count = 0, totalBytes = 0;
  const assets = [];
  const names = new Set();
  const output = String(fragment).replace(
    /<script\b[^>]*\bdata-viz-data\s*=\s*(["'])(.*?)\1[^>]*>\s*<\/script>/gi,
    (tag, _quote, source) => {
      if (++count > MAX_DATA_SOURCES)
        throw new Error('Visualization uses more than ' + MAX_DATA_SOURCES + ' workspace data sources');
      const file = workspacePath(cwd, source, { kind: 'data', maxBytes: MAX_DATA_BYTES });
      if (totalBytes + file.size > MAX_TOTAL_DATA_BYTES)
        throw new Error('Visualization workspace data exceeds ' + MAX_TOTAL_DATA_BYTES + ' bytes');
      const extension = path.extname(file.path).toLowerCase();
      if (!DATA_EXTENSIONS.has(extension))
        throw new Error('Unsupported workspace data type: ' + extension);
      const bytes = fs.readFileSync(file.path);
      if (bytes.length !== file.size)
        throw new Error('Workspace data changed while it was read: ' + file.relative);
      const name = dataName(tag, file);
      if (names.has(name)) throw new Error('Duplicate visualization data name: ' + name);
      names.add(name);
      const value = parseWorkspaceData(bytes, extension, file.relative);
      totalBytes += bytes.length;
      assets.push({ path: file.relative, bytes: bytes.length, format: extension.slice(1), name });
      return '<script type="application/json" data-viz-name="' + escapeAttribute(name) + '">'
        + scriptJson(value) + '</script>';
    });
  return { fragment: output, assets };
}

module.exports = {
  embedWorkspaceImages,
  embedWorkspaceVideos,
  embedWorkspaceData,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_BYTES,
  MAX_IMAGES,
  MAX_VIDEO_BYTES,
  MAX_TOTAL_VIDEO_BYTES,
  MAX_VIDEOS,
  MAX_DATA_BYTES,
  MAX_TOTAL_DATA_BYTES,
  MAX_DATA_SOURCES,
};

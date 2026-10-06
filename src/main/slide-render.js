'use strict';

// Renders DrawingML slides without scripts or network access. PowerPoint decks
// in the wild lean on group shapes, layout/master decoration, theme colours and
// text autofit, so those are resolved locally instead of dropping the content.

const path = require('node:path');

const MAX_SLIDES = 100;
const MAX_SHAPES_PER_SLIDE = 900;
const MAX_PARAGRAPHS_PER_SHAPE = 200;
const MAX_TABLE_ROWS = 200;
const MAX_TABLE_COLUMNS = 40;
const MAX_GROUP_DEPTH = 8;

const children = (node, name) => Array.from(node?.childNodes || []).filter(item => item.nodeType === 1 && (!name || item.localName === name));
const descendants = (node, name) => Array.from(node?.getElementsByTagName('*') || []).filter(item => item.localName === name);
const first = (node, name) => descendants(node, name)[0];
const child = (node, name) => children(node, name)[0];
// reader.xml() hands back the Document, so direct-child lookups need its root.
const rootOf = node => (node && node.nodeType === 9 ? node.documentElement : node);
const attr = (node, name) => node?.getAttribute(name) ?? '';
const has = (node, name) => node?.getAttribute(name) !== null && node?.getAttribute(name) !== undefined;
const number = (value, fallback = 0) => Number.isFinite(Number(value)) && value !== '' && value !== null && value !== undefined ? Number(value) : fallback;
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const flag = (node, fallback = false) => node ? !['0', 'false', 'off'].includes(String(attr(node, 'val') || '1').toLowerCase()) : fallback;
const round = value => Math.round(value * 10000) / 10000;

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

const PRESET_COLORS = {
  aliceblue: 'f0f8ff', aqua: '00ffff', black: '000000', blue: '0000ff', brown: 'a52a2a', coral: 'ff7f50',
  cyan: '00ffff', darkblue: '00008b', darkcyan: '008b8b', darkgray: 'a9a9a9', darkgrey: 'a9a9a9',
  darkgreen: '006400', darkorange: 'ff8c00', darkred: '8b0000', dimgray: '696969', dimgrey: '696969',
  fuchsia: 'ff00ff', gold: 'ffd700', gray: '808080', grey: '808080', green: '008000', indigo: '4b0082',
  ivory: 'fffff0', khaki: 'f0e68c', lavender: 'e6e6fa', lightblue: 'add8e6', lightgray: 'd3d3d3',
  lightgrey: 'd3d3d3', lightgreen: '90ee90', lightyellow: 'ffffe0', lime: '00ff00', magenta: 'ff00ff',
  maroon: '800000', navy: '000080', olive: '808000', orange: 'ffa500', orchid: 'da70d6', pink: 'ffc0cb',
  plum: 'dda0dd', purple: '800080', red: 'ff0000', salmon: 'fa8072', silver: 'c0c0c0', skyblue: '87ceeb',
  tan: 'd2b48c', teal: '008080', tomato: 'ff6347', turquoise: '40e0d0', violet: 'ee82ee', wheat: 'f5deb3',
  white: 'ffffff', yellow: 'ffff00', yellowgreen: '9acd32',
};

function rgbFromHex(value) {
  const hex = String(value || '').replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(hex)) return null;
  return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a: 1 };
}

function hexFromRgb(rgb) {
  const part = value => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
  return '#' + part(rgb.r) + part(rgb.g) + part(rgb.b);
}

function cssColor(rgb) {
  if (!rgb) return '';
  if (rgb.a >= 1) return hexFromRgb(rgb);
  return `rgba(${Math.round(rgb.r)},${Math.round(rgb.g)},${Math.round(rgb.b)},${round(rgb.a)})`;
}

function rgbToHsl({ r, g, b }) {
  const red = r / 255, green = g / 255, blue = b / 255;
  const max = Math.max(red, green, blue), min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: lightness };
  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  const hue = max === red ? ((green - blue) / delta + (green < blue ? 6 : 0)) : max === green ? (blue - red) / delta + 2 : (red - green) / delta + 4;
  return { h: hue / 6, s: saturation, l: lightness };
}

function hslToRgb({ h, s, l }) {
  const hue = (h % 1 + 1) % 1;
  if (s === 0) return { r: l * 255, g: l * 255, b: l * 255, a: 1 };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = offset => {
    let value = hue + offset;
    if (value < 0) value += 1;
    if (value > 1) value -= 1;
    if (value < 1 / 6) return p + (q - p) * 6 * value;
    if (value < 1 / 2) return q;
    if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
    return p;
  };
  return { r: channel(1 / 3) * 255, g: channel(0) * 255, b: channel(-1 / 3) * 255, a: 1 };
}

function applyTransforms(rgb, node) {
  if (!rgb || !node) return rgb;
  let result = { ...rgb };
  let lumMod = 1, lumOff = 0, shade = 1, tint = 0;
  for (const transform of children(node)) {
    const value = number(attr(transform, 'val'), null);
    if (value === null) continue;
    if (transform.localName === 'lumMod') lumMod *= value / 100000;
    else if (transform.localName === 'lumOff') lumOff += value / 100000;
    else if (transform.localName === 'shade') shade *= value / 100000;
    else if (transform.localName === 'tint') tint = Math.max(tint, value / 100000);
    else if (transform.localName === 'alpha') result.a = value / 100000;
  }
  if (lumMod !== 1 || lumOff !== 0) {
    const hsl = rgbToHsl(result);
    result = hslToRgb({ ...hsl, l: Math.max(0, Math.min(1, hsl.l * lumMod + lumOff)) });
  }
  if (shade !== 1) result = { ...result, r: result.r * shade, g: result.g * shade, b: result.b * shade };
  if (tint) result = { ...result, r: result.r + (255 - result.r) * tint, g: result.g + (255 - result.g) * tint, b: result.b + (255 - result.b) * tint };
  return result;
}

function basicColor(node) {
  if (!node) return null;
  if (node.localName === 'srgbClr') return rgbFromHex(attr(node, 'val'));
  if (node.localName === 'sysClr') return rgbFromHex(attr(node, 'lastClr') || (attr(node, 'val') === 'window' ? 'ffffff' : '000000'));
  if (node.localName === 'prstClr') return rgbFromHex(PRESET_COLORS[String(attr(node, 'val')).toLowerCase()]);
  return null;
}

function colorElement(node, ctx) {
  if (!node) return null;
  if (node.localName === 'schemeClr') {
    let role = attr(node, 'val') || 'tx1';
    if (role === 'phClr') role = ctx.phColor || 'tx1';
    const slot = ctx.theme.clrMap[role] || role;
    const rgb = rgbFromHex(ctx.theme.scheme[slot] || ctx.theme.scheme[role] || '');
    return applyTransforms(rgb || rgbFromHex('000000'), node);
  }
  const rgb = basicColor(node);
  return rgb ? applyTransforms(rgb, node) : null;
}

const colorOf = (fillNode, ctx) => fillNode ? colorElement(children(fillNode)[0], ctx) : null;

// A style reference (fillRef/lnRef/bgRef) carries the placeholder colour that
// its referenced theme entry resolves as phClr.
function withPhColor(ctx, reference, render) {
  const element = children(reference)[0];
  const previous = ctx.phColor;
  if (element && element.localName === 'schemeClr') ctx.phColor = attr(element, 'val') || previous;
  try { return render(); } finally { ctx.phColor = previous; }
}

function gradientValue(node, ctx) {
  if (!node) return '';
  const stops = [];
  for (const stop of descendants(node, 'gs').slice(0, 12)) {
    const color = colorElement(children(stop)[0], ctx);
    if (!color) continue;
    const position = Math.max(0, Math.min(100, number(attr(stop, 'pos'), 0) / 1000));
    stops.push(`${cssColor(color)} ${round(position)}%`);
  }
  if (stops.length < 2) return '';
  const angle = number(attr(first(node, 'lin'), 'ang'), 0) / 60000 + 90;
  return `linear-gradient(${round(angle)}deg,${stops.join(',')})`;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

function rectOf(transform) {
  if (!transform) return null;
  const offset = child(transform, 'off'), extent = child(transform, 'ext');
  if (!offset || !extent) return null;
  return {
    x: number(attr(offset, 'x')), y: number(attr(offset, 'y')),
    w: number(attr(extent, 'cx')), h: number(attr(extent, 'cy')),
    rot: number(attr(transform, 'rot')) / 60000,
    flipH: attr(transform, 'flipH') === '1', flipV: attr(transform, 'flipV') === '1',
  };
}

function groupRect(transform) {
  const rect = rectOf(transform);
  if (!rect) return null;
  const inner = child(transform, 'chOff'), extent = child(transform, 'chExt');
  return {
    ...rect,
    childX: number(attr(inner, 'x')), childY: number(attr(inner, 'y')),
    childW: Math.max(1, number(attr(extent, 'cx'), rect.w)), childH: Math.max(1, number(attr(extent, 'cy'), rect.h)),
  };
}

const percent = (value, origin, span) => round((value - origin) / span * 100) + '%';

function positionStyle(rect, frame) {
  if (!rect) return '';
  const styles = ['position:absolute',
    `left:${percent(rect.x, frame.x, frame.w)}`,
    `top:${percent(rect.y, frame.y, frame.h)}`,
    `width:${round(rect.w / frame.w * 100)}%`,
    `height:${round(rect.h / frame.h * 100)}%`];
  const transform = [];
  if (rect.rot) transform.push(`rotate(${round(rect.rot)}deg)`);
  if (rect.flipH) transform.push('scaleX(-1)');
  if (rect.flipV) transform.push('scaleY(-1)');
  if (transform.length) styles.push(`transform:${transform.join(' ')}`);
  return styles.join(';');
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

const CLR_MAP_KEYS = ['bg1', 'tx1', 'bg2', 'tx2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];

async function loadTheme(reader) {
  const theme = { clrMap: {}, scheme: {}, majorFont: '', minorFont: '', fonts: { major: {}, minor: {} }, fills: [], backgroundFills: [], lines: [] };
  const presentationRelations = await reader.relationships('ppt/presentation.xml', true);
  const masterTarget = [...presentationRelations.values()].find(value => /slideMasters\/[^/]+\.xml$/.test(value));
  if (!masterTarget) return theme;
  const master = rootOf(await reader.xml(masterTarget, true));
  const clrMap = child(master, 'clrMap');
  for (const key of CLR_MAP_KEYS) if (clrMap && has(clrMap, key)) theme.clrMap[key] = attr(clrMap, key);
  const masterRelations = await reader.relationships(masterTarget, true);
  const themeTarget = [...masterRelations.values()].find(value => /theme\/[^/]+\.xml$/.test(value));
  if (!themeTarget) return theme;
  const document = rootOf(await reader.xml(themeTarget, true));
  const scheme = first(document, 'clrScheme');
  for (const entry of children(scheme)) {
    const rgb = basicColor(children(entry)[0]);
    if (rgb) theme.scheme[entry.localName] = hexFromRgb(rgb);
  }
  const fonts = first(document, 'fontScheme');
  for (const bucket of ['major', 'minor']) {
    const node = first(fonts, bucket + 'Font');
    if (!node) continue;
    for (const script of ['latin', 'ea', 'cs']) theme.fonts[bucket][script] = attr(first(node, script), 'typeface');
  }
  const format = first(document, 'fmtScheme');
  theme.fills = children(first(format, 'fillStyleLst'));
  theme.backgroundFills = children(first(format, 'bgFillStyleLst'));
  theme.lines = children(first(format, 'lnStyleLst'));
  return theme;
}

function fontFamily(typeface, ctx) {
  if (!typeface) return '';
  if (typeface === '+mj-lt') return ctx.theme.fonts.major.latin || '';
  if (typeface === '+mn-lt') return ctx.theme.fonts.minor.latin || '';
  return typeface;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

function mergeRunProperties(target, source, ctx) {
  if (!source) return target;
  if (has(source, 'sz')) target.size = number(attr(source, 'sz')) / 100;
  if (has(source, 'b')) target.bold = flag(source);
  if (has(source, 'i')) target.italic = flag(source);
  if (has(source, 'u')) target.underline = !['none', '0', 'false'].includes(String(attr(source, 'u')).toLowerCase());
  if (has(source, 'strike')) target.strike = !['noStrike', 'none', '0'].includes(attr(source, 'strike'));
  if (has(source, 'spc')) target.spacing = number(attr(source, 'spc')) / 100;
  const color = colorOf(first(source, 'solidFill'), ctx);
  if (color) target.color = cssColor(color);
  const font = fontFamily(attr(first(source, 'latin'), 'typeface'), ctx);
  if (font) target.font = font;
  return target;
}

function mergeParagraphProperties(target, source, ctx) {
  if (!source) return target;
  if (has(source, 'algn')) target.align = attr(source, 'algn');
  if (has(source, 'marL')) target.margin = number(attr(source, 'marL'));
  if (has(source, 'indent')) target.indent = number(attr(source, 'indent'));
  if (first(source, 'buNone')) target.bullet = null;
  else if (first(source, 'buChar')) target.bullet = attr(first(source, 'buChar'), 'char') || '•';
  else if (first(source, 'buAutoNum')) target.bullet = 'auto';
  const lineSpacing = first(source, 'lnSpc');
  const percent = number(attr(child(lineSpacing, 'spcPct'), 'val'), null);
  if (percent !== null) target.lineHeight = percent / 100000;
  const points = number(attr(child(lineSpacing, 'spcPts'), 'val'), null);
  if (points !== null) target.lineHeightPoints = points / 100;
  const before = first(source, 'spcBef'), after = first(source, 'spcAft');
  const beforePercent = number(attr(child(before, 'spcPct'), 'val'), null);
  if (beforePercent !== null) target.spaceBeforePercent = beforePercent;
  const beforePoints = number(attr(child(before, 'spcPts'), 'val'), null);
  if (beforePoints !== null) target.spaceBeforePoints = beforePoints / 100;
  const afterPercent = number(attr(child(after, 'spcPct'), 'val'), null);
  if (afterPercent !== null) target.spaceAfterPercent = afterPercent;
  const afterPoints = number(attr(child(after, 'spcPts'), 'val'), null);
  if (afterPoints !== null) target.spaceAfterPoints = afterPoints / 100;
  if (has(source, 'lvl')) target.level = number(attr(source, 'lvl'), 0);
  return mergeRunProperties(target, child(source, 'defRPr'), ctx);
}

// Placeholder text styles cascade master -> layout -> shape -> paragraph -> run.
function textDefaults(ctx, shape, level) {
  const levelName = 'lvl' + (level + 1) + 'pPr';
  const defaults = { size: null, bold: false, italic: false, underline: false, color: '', font: '', align: '', bullet: undefined, margin: null, indent: null, level };
  const placeholder = first(shape, 'ph');
  const bucket = /^(title|ctrTitle)$/.test(attr(placeholder, 'type') || '') ? 'titleStyle' : /^(body|subTitle|obj)$/.test(attr(placeholder, 'type') || '') ? 'bodyStyle' : 'otherStyle';
  const masterStyles = first(ctx.masterSheet, bucket);
  mergeParagraphProperties(defaults, child(masterStyles, levelName), ctx);
  const layoutShape = ctx.placeholder(ctx.layout, placeholder);
  if (layoutShape) mergeParagraphProperties(defaults, child(first(first(layoutShape, 'txBody'), 'lstStyle'), levelName), ctx);
  mergeParagraphProperties(defaults, child(first(first(shape, 'txBody'), 'lstStyle'), levelName), ctx);
  return defaults;
}

function bulletText(bullet, index) {
  if (!bullet) return '';
  return bullet === 'auto' ? (index + 1) + '. ' : bullet + ' ';
}

function alignment(value, fallback) {
  return { l: 'left', ctr: 'center', r: 'right', just: 'justify', dist: 'justify', thaiDist: 'justify' }[value || fallback] || 'left';
}

function paragraphHtml(node, ctx, defaults, index, widthEmu) {
  const properties = child(node, 'pPr');
  const merged = mergeParagraphProperties({ ...defaults }, properties, ctx);
  const level = has(properties, 'lvl') ? number(attr(properties, 'lvl'), 0) : (defaults.level || 0);
  const levelDefaults = level === defaults.level ? merged : mergeParagraphProperties(textDefaults(ctx, ctx.shape, level), properties, ctx);
  const styles = [`text-align:${alignment(levelDefaults.align)}`];
  if (levelDefaults.margin !== null && levelDefaults.margin !== undefined) styles.push(`margin-left:${round(levelDefaults.margin / widthEmu * 100)}cqw`);
  if (levelDefaults.indent) styles.push(`text-indent:${round(levelDefaults.indent / widthEmu * 100)}cqw`);
  if (levelDefaults.lineHeight) styles.push(`line-height:${round(levelDefaults.lineHeight * 100) / 100}`);
  else if (levelDefaults.lineHeightPoints) styles.push(`line-height:${round(levelDefaults.lineHeightPoints)}pt`);
  // Percent spacing is relative to the font size, so it must stay em-based.
  if (levelDefaults.spaceBeforePercent) styles.push(`margin-top:${round(levelDefaults.spaceBeforePercent / 100000 * 100) / 100}em`);
  else if (levelDefaults.spaceBeforePoints) styles.push(`margin-top:${round(levelDefaults.spaceBeforePoints)}pt`);
  if (levelDefaults.spaceAfterPercent) styles.push(`margin-bottom:${round(levelDefaults.spaceAfterPercent / 100000 * 100) / 100}em`);
  else if (levelDefaults.spaceAfterPoints) styles.push(`margin-bottom:${round(levelDefaults.spaceAfterPoints)}pt`);

  const parts = [];
  for (const item of children(node)) {
    if (item.localName === 'br') { parts.push('<br>'); continue; }
    if (item.localName === 'tab') { parts.push('&#8195;'); continue; }
    if (item.localName === 'r' || item.localName === 'fld') {
      const run = mergeRunProperties({ ...levelDefaults }, child(item, 'rPr'), ctx);
      const runStyles = [];
      if (run.bold) runStyles.push('font-weight:700');
      if (run.italic) runStyles.push('font-style:italic');
      if (run.underline) runStyles.push('text-decoration:underline');
      if (run.strike) runStyles.push('text-decoration:line-through');
      if (run.size > 0) runStyles.push(`font-size:${round(Math.min(run.size, 400) * ctx.autofit * 100 / ctx.widthPoints)}cqw`);
      if (run.color) runStyles.push(`color:${run.color}`);
      if (run.font) runStyles.push(`font-family:${String(run.font).replace(/"/g, '')},Arial,sans-serif`);
      if (run.spacing) runStyles.push(`letter-spacing:${round(run.spacing * 100 / ctx.widthPoints)}cqw`);
      let content = '';
      for (const text of children(item)) {
        if (text.localName === 't') content += escape(text.textContent);
        else if (text.localName === 'tab') content += '&#8195;';
        else if (text.localName === 'br') content += '<br>';
      }
      if (item.localName === 'fld') {
        const type = attr(item, 'type');
        if (type === 'slidenum') content = String(ctx.slideNumber);
        else content = content.replace(/[‹«]?#[›»]?/g, '');
      }
      parts.push(`<span style="${runStyles.join(';')}">${content}</span>`);
      continue;
    }
    if (item.localName === 'endParaRPr') continue;
  }
  const bullet = levelDefaults.bullet === undefined ? null : levelDefaults.bullet;
  const prefix = parts.length ? bulletText(bullet, index) : '';
  return `<p style="${styles.join(';')}">${prefix ? escape(prefix) : ''}${parts.join('') || '<br>'}</p>`;
}

function shapeText(shape, ctx, inherited) {
  // Text belongs to the shape itself; layout/master placeholders only supply
  // geometry and defaults. Their prompt strings ("Click to edit…") never show.
  const body = first(shape, 'txBody');
  if (!body) return '';
  const paragraphs = children(body, 'p').slice(0, MAX_PARAGRAPHS_PER_SHAPE);
  if (!paragraphs.some(paragraph => descendants(paragraph, 't').some(text => text.textContent.trim()) || first(paragraph, 'fld'))) return '';
  const bodyProperties = first(body, 'bodyPr');
  ctx.autofit = 1;
  const autofit = first(bodyProperties, 'normAutofit');
  if (autofit) ctx.autofit = Math.max(0.1, Math.min(1, number(attr(autofit, 'fontScale'), 100000) / 100000));
  const previous = ctx.shape;
  ctx.shape = shape;
  const html = paragraphs.map((paragraph, index) => paragraphHtml(paragraph, ctx, textDefaults(ctx, shape, number(attr(child(paragraph, 'pPr'), 'lvl'), 0)), index, ctx.widthEmu)).join('');
  ctx.shape = previous;
  const anchor = { t: 'flex-start', ctr: 'center', b: 'flex-end' }[attr(bodyProperties, 'anchor')] || 'flex-start';
  const vertical = { t: 'flex-start', ctr: 'center', b: 'flex-end' }[attr(bodyProperties, 'anchorCtr') === '1' ? 'ctr' : ''] || anchor;
  const padding = ['lIns', 'tIns', 'rIns', 'bIns'].map(key => number(attr(bodyProperties, key), 91440));
  return {
    html,
    css: `display:flex;flex-direction:column;justify-content:${vertical};padding:${round(padding[1] / ctx.widthEmu * 100)}cqw ${round(padding[2] / ctx.widthEmu * 100)}cqw ${round(padding[3] / ctx.widthEmu * 100)}cqw ${round(padding[0] / ctx.widthEmu * 100)}cqw;`,
  };
}

// ---------------------------------------------------------------------------
// Fills, lines and pictures
// ---------------------------------------------------------------------------

function fillValue(properties, owner, ctx) {
  if (properties) {
    // Only a direct spPr child counts; a noFill inside <a:ln> describes the
    // outline, not the shape fill.
    if (child(properties, 'noFill')) return { background: 'transparent' };
    const solid = colorOf(child(properties, 'solidFill'), ctx);
    if (solid) return { background: cssColor(solid) };
    const gradient = gradientValue(child(properties, 'gradFill'), ctx);
    if (gradient) return { background: gradient };
  }
  const reference = child(first(owner, 'style'), 'fillRef');
  if (!reference) return null;
  const index = number(attr(reference, 'idx'), 0);
  if (index === 0) return { background: 'transparent' };
  return withPhColor(ctx, reference, () => {
    const entry = index >= 1001 ? ctx.theme.backgroundFills[index - 1001] : ctx.theme.fills[index - 1];
    if (entry) {
      if (first(entry, 'noFill')) return { background: 'transparent' };
      const solid = colorOf(first(entry, 'solidFill'), ctx);
      if (solid) return { background: cssColor(solid) };
      const gradient = gradientValue(first(entry, 'gradFill'), ctx);
      if (gradient) return { background: gradient };
    }
    const fallback = colorElement(children(reference)[0], ctx);
    return fallback ? { background: cssColor(fallback) } : null;
  });
}

function lineValue(properties, owner, ctx) {
  const line = child(properties, 'ln');
  if (line && child(line, 'noFill')) return null;
  const color = colorOf(child(line, 'solidFill'), ctx);
  let width = number(attr(line, 'w'), 0);
  if (!color) {
    const reference = child(first(owner, 'style'), 'lnRef');
    const index = number(attr(reference, 'idx'), 0);
    return withPhColor(ctx, reference, () => {
      const entry = index ? ctx.theme.lines[index - 1] : null;
      if (entry && first(entry, 'noFill')) return null;
      const styleColor = colorOf(first(entry, 'solidFill'), ctx) || colorElement(children(reference)[0], ctx);
      if (!styleColor) return null;
      return { color: cssColor(styleColor), emu: number(attr(first(entry, 'ln'), 'w'), 12700) };
    });
  }
  return { color: cssColor(color), emu: width || 12700 };
}

async function pictureSource(blipFill, ctx) {
  if (!blipFill) return { source: '', target: '' };
  const candidates = [];
  const svg = first(blipFill, 'svgBlip');
  if (svg) candidates.push(attr(svg, 'r:embed') || attr(svg, 'embed'));
  const blip = first(blipFill, 'blip');
  if (blip) candidates.push(attr(blip, 'r:embed') || attr(blip, 'embed'));
  for (const id of candidates.filter(Boolean)) {
    const target = ctx.relations.get(id);
    if (!target) continue;
    const source = await ctx.image(target);
    if (source) return { source, target };
  }
  const target = candidates.filter(Boolean).map(id => ctx.relations.get(id)).find(Boolean);
  return target ? { source: '', target } : { source: '', target: '' };
}

function cropStyles(srcRect) {
  if (!srcRect) return '';
  const left = number(attr(srcRect, 'l')) / 100000, top = number(attr(srcRect, 't')) / 100000;
  const right = number(attr(srcRect, 'r')) / 100000, bottom = number(attr(srcRect, 'b')) / 100000;
  if (!left && !top && !right && !bottom) return '';
  const scaleX = 1 / Math.max(0.01, 1 - left - right), scaleY = 1 / Math.max(0.01, 1 - top - bottom);
  return `width:${round(scaleX * 100)}%;height:${round(scaleY * 100)}%;left:${round(-left * scaleX * 100)}%;top:${round(-top * scaleY * 100)}%;position:absolute;`;
}

async function pictureHtml(node, ctx, frame) {
  const properties = first(node, 'spPr');
  const rect = rectOf(first(properties, 'xfrm'));
  const geometry = attr(first(properties, 'prstGeom'), 'prst');
  const blipFill = first(node, 'blipFill');
  const { source, target } = await pictureSource(blipFill, ctx);
  const shape = geometry === 'ellipse' ? 'border-radius:50%;' : '';
  const box = `${positionStyle(rect, frame)};overflow:hidden;${shape}`;
  if (!source) {
    const label = target ? path.posix.basename(target) : 'image';
    return `<div class="picture missing" style="${box}"><span>${escape(label)}</span></div>`;
  }
  const crop = cropStyles(first(blipFill, 'srcRect'));
  const image = crop
    ? `<img src="${source}" alt="" style="${crop}">`
    : '<img src="' + source + '" alt="" style="width:100%;height:100%;object-fit:contain">';
  return `<div class="picture" style="${box}">${image}</div>`;
}

// ---------------------------------------------------------------------------
// Tables, charts and connectors
// ---------------------------------------------------------------------------

function slideTableHtml(table, ctx, frame, rect) {
  const grid = children(first(table, 'tblGrid'), 'gridCol').slice(0, MAX_TABLE_COLUMNS);
  const total = grid.reduce((sum, column) => sum + number(attr(column, 'w')), 0) || 1;
  const columns = grid.map(column => `<col style="width:${round(number(attr(column, 'w')) / total * 100)}%">`).join('');
  const rows = [];
  for (const row of children(table, 'tr').slice(0, MAX_TABLE_ROWS)) {
    const cells = [];
    for (const cell of children(row, 'tc').slice(0, MAX_TABLE_COLUMNS)) {
      if (attr(cell, 'hMerge') === '1' || attr(cell, 'vMerge') === '1') continue;
      const properties = first(cell, 'tcPr');
      const styles = [];
      const fill = colorOf(child(properties, 'solidFill'), ctx);
      if (fill) styles.push(`background:${cssColor(fill)}`);
      const borders = [['lnL', 'left'], ['lnR', 'right'], ['lnT', 'top'], ['lnB', 'bottom']];
      for (const [name, side] of borders) {
        const line = first(properties, name);
        if (!line) continue;
        const color = colorOf(child(line, 'solidFill'), ctx);
        if (!color) continue;
        styles.push(`border-${side}:1px solid ${cssColor(color)}`);
      }
      const span = number(attr(cell, 'gridSpan'), 1), rowSpan = number(attr(cell, 'rowSpan'), 1);
      const anchor = { t: 'top', ctr: 'middle', b: 'bottom' }[attr(properties, 'anchor')] || 'top';
      styles.push(`vertical-align:${anchor}`);
      const padding = ['marL', 'marT', 'marR', 'marB'].map(key => number(attr(properties, key), 45720));
      styles.push(`padding:${round(padding[1] / ctx.widthEmu * 100)}cqw ${round(padding[2] / ctx.widthEmu * 100)}cqw ${round(padding[3] / ctx.widthEmu * 100)}cqw ${round(padding[0] / ctx.widthEmu * 100)}cqw`);
      const previous = ctx.shape;
      ctx.shape = cell;
      const textHtml = children(first(cell, 'txBody'), 'p').slice(0, MAX_PARAGRAPHS_PER_SHAPE)
        .map((paragraph, index) => paragraphHtml(paragraph, ctx, textDefaults(ctx, cell, number(attr(child(paragraph, 'pPr'), 'lvl'), 0)), index, ctx.widthEmu)).join('');
      ctx.shape = previous;
      const spanAttribute = span > 1 ? ` colspan="${Math.min(span, MAX_TABLE_COLUMNS)}"` : '';
      const rowAttribute = rowSpan > 1 ? ` rowspan="${Math.min(rowSpan, MAX_TABLE_ROWS)}"` : '';
      cells.push(`<td${spanAttribute}${rowAttribute} style="${styles.join(';')}">${textHtml}</td>`);
    }
    rows.push(`<tr style="height:${round(number(attr(row, 'h'), 0) / Math.max(1, rect ? rect.h : 1) * 100)}%">${cells.join('')}</tr>`);
  }
  return `<table style="${positionStyle(rect, frame)};table-layout:fixed;border-collapse:collapse;background:transparent"><colgroup>${columns}</colgroup>${rows.join('')}</table>`;
}

async function chartHtml(node, ctx, frame, rect) {
  const chartId = attr(first(node, 'chart'), 'r:id');
  const target = chartId ? ctx.relations.get(chartId) : '';
  const document = target ? rootOf(await ctx.xml(target, true)) : null;
  if (!document) return '';
  const titleNode = first(document, 'title');
  const title = descendants(titleNode, 't').map(item => item.textContent).join('').trim()
    || descendants(first(titleNode, 'strCache'), 'v').map(item => item.textContent).join('').trim();
  const categories = descendants(first(document, 'cat'), 'pt').map(point => descendants(point, 'v').map(item => item.textContent).join(''));
  const series = [];
  for (const entry of descendants(document, 'ser').slice(0, 8)) {
    const name = descendants(first(first(entry, 'tx'), 'strCache'), 'v').map(item => item.textContent).join('')
      || descendants(first(first(entry, 'tx'), 'v'), 'v').map(item => item.textContent).join('');
    const values = descendants(first(entry, 'val'), 'pt').map(point => descendants(point, 'v').map(item => item.textContent).join(''));
    series.push({ name: name || 'Series', values });
  }
  if (!series.length) return '';
  const header = categories.length ? '<tr><th></th>' + categories.map(category => `<th>${escape(category)}</th>`).join('') + '</tr>' : '';
  const body = series.map(entry => `<tr><th>${escape(entry.name)}</th>${entry.values.map(value => `<td>${escape(value)}</td>`).join('')}</tr>`).join('');
  return `<div class="chart" style="${positionStyle(rect, frame)}"><strong>${escape(title || 'Chart')}</strong><table>${header}${body}</table></div>`;
}

function connectorHtml(node, ctx, frame) {
  const properties = first(node, 'spPr');
  const rect = rectOf(first(properties, 'xfrm'));
  if (!rect) return '';
  const line = lineValue(properties, node, ctx);
  if (!line) return '';
  const x1 = rect.flipH ? 0 : 100, x2 = rect.flipH ? 100 : 0;
  const y1 = rect.flipV ? 0 : 100, y2 = rect.flipV ? 100 : 0;
  const svg = `<svg viewBox="0 0 100 100" preserveAspectRatio="none" style="width:100%;height:100%;overflow:visible"><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${line.color}" stroke-width="${Math.max(1, round(line.emu / 12700))}" vector-effect="non-scaling-stroke"/></svg>`;
  return `<div class="connector" style="${positionStyle(rect, frame)}">${svg}</div>`;
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

async function shapeHtml(node, ctx, frame, depth = 0) {
  if (!node || depth > MAX_GROUP_DEPTH) return '';
  if (ctx.count > MAX_SHAPES_PER_SLIDE) { ctx.truncated = true; return ''; }
  if (node.localName === 'AlternateContent') {
    const choices = [...children(node, 'Choice'), ...children(node, 'Fallback')];
    for (const choice of choices) {
      const inner = children(choice)[0];
      if (!inner) continue;
      const html = await shapeHtml(inner, ctx, frame, depth + 1);
      if (html) return html;
    }
    return '';
  }
  ctx.count++;
  if (node.localName === 'grpSp') {
    const rect = groupRect(first(first(node, 'grpSpPr'), 'xfrm'));
    if (!rect) return '';
    const nested = { x: rect.childX, y: rect.childY, w: rect.childW, h: rect.childH };
    const inner = [];
    for (const item of children(node)) {
      if (item.localName === 'nvGrpSpPr' || item.localName === 'grpSpPr') continue;
      inner.push(await shapeHtml(item, ctx, nested, depth + 1));
    }
    return `<div class="group" style="${positionStyle(rect, frame)}">${inner.join('')}</div>`;
  }
  if (node.localName === 'pic') { ctx.images++; return pictureHtml(node, ctx, frame); }
  if (node.localName === 'cxnSp') return connectorHtml(node, ctx, frame);
  if (node.localName === 'graphicFrame') {
    const rect = rectOf(child(node, 'xfrm'));
    const table = first(node, 'tbl');
    if (table) return slideTableHtml(table, ctx, frame, rect);
    return chartHtml(node, ctx, frame, rect);
  }
  if (node.localName !== 'sp') return '';

  const properties = first(node, 'spPr');
  const placeholder = first(node, 'ph');
  // A placeholder inherits geometry/defaults from the next layer up, never from
  // itself: layout slots fall back to the master, slide slots to layout/master.
  let inherited = null;
  for (const sheet of [ctx.layout, ctx.master]) {
    const candidate = ctx.placeholder(sheet, placeholder);
    if (candidate && candidate !== node) { inherited = candidate; break; }
  }
  const rect = rectOf(first(properties, 'xfrm')) || rectOf(first(first(inherited, 'spPr'), 'xfrm'));
  const geometry = attr(first(properties, 'prstGeom'), 'prst') || attr(first(first(inherited, 'spPr'), 'prstGeom'), 'prst');
  const fill = fillValue(properties, node, ctx) || fillValue(first(inherited, 'spPr'), inherited, ctx);
  const stroke = lineValue(properties, node, ctx) || lineValue(first(inherited, 'spPr'), inherited, ctx);
  const text = shapeText(node, ctx, inherited);
  const styles = [positionStyle(rect, frame).replace(/;$/, ''), 'overflow:visible'];
  if (fill?.background) styles.push(`background:${fill.background}`);
  if (stroke) styles.push(`border:${Math.max(0.4, round(stroke.emu / ctx.widthEmu * 100))}cqw solid ${stroke.color}`);
  if (geometry === 'ellipse') styles.push('border-radius:50%');
  else if (geometry === 'roundRect') styles.push('border-radius:8px');
  if (text?.css) styles.push(text.css.replace(/;$/, ''));
  return `<div class="shape" style="${styles.join(';')}">${text?.html || ''}</div>`;
}

// ---------------------------------------------------------------------------
// Slide assembly
// ---------------------------------------------------------------------------

// PowerPoint treats a slide's ctrTitle as filling the layout's title slot.
const PLACEHOLDER_ALIASES = { ctrTitle: 'title' };
const placeholderType = element => attr(element, 'type') || 'body';
const placeholderKey = node => {
  const element = first(node, 'ph');
  if (!element) return '';
  return (PLACEHOLDER_ALIASES[placeholderType(element)] || placeholderType(element)) + ':' + attr(element, 'idx');
};

// Layout and master placeholders carry prompt strings as editing affordances;
// they define geometry and defaults, not visible slide content.
const PROMPT_PATTERN = /click to (?:edit|add)|单击此处|点击此处|在此输入|在此添加/i;
function isPromptPlaceholder(shape) {
  const element = first(shape, 'ph');
  if (!element) return false;
  const body = first(shape, 'txBody');
  const text = descendants(body, 't').map(item => item.textContent).join('').trim();
  return !text || PROMPT_PATTERN.test(text);
}

function placeholderLookup(sheet) {
  const tree = first(sheet, 'spTree');
  const exact = new Map(), byType = new Map();
  for (const shape of children(tree, 'sp')) {
    const element = first(shape, 'ph');
    if (!element) continue;
    const type = PLACEHOLDER_ALIASES[placeholderType(element)] || placeholderType(element);
    if (!byType.has(type)) byType.set(type, shape);
    exact.set(type + ':' + attr(element, 'idx'), shape);
  }
  return { exact, byType };
}

function findPlaceholder(sheet, element) {
  if (!sheet || !element) return null;
  const type = PLACEHOLDER_ALIASES[placeholderType(element)] || placeholderType(element);
  return sheet.exact.get(type + ':' + attr(element, 'idx')) || sheet.byType.get(type) || null;
}

async function slideBackground(ctx, content, layout, master) {
  for (const sheet of [content, layout, master]) {
    const background = first(sheet, 'bg');
    if (!background) continue;
    const properties = first(background, 'bgPr');
    if (properties) {
      const solid = colorOf(first(properties, 'solidFill'), ctx);
      if (solid) return `background:${cssColor(solid)};`;
      const gradient = gradientValue(first(properties, 'gradFill'), ctx);
      if (gradient) return `background:${gradient};`;
      const blipFill = first(properties, 'blipFill');
      if (blipFill) {
        const { source } = await pictureSource(blipFill, ctx);
        if (source) return `background:#ffffff url("${source}") center/cover no-repeat;`;
      }
    }
    const reference = first(background, 'bgRef');
    if (reference) {
      const index = number(attr(reference, 'idx'), 1001);
      const entry = index >= 1001 ? ctx.theme.backgroundFills[index - 1001] : ctx.theme.fills[index - 1];
      const gradient = gradientValue(first(entry, 'gradFill'), ctx);
      if (gradient) return `background:${gradient};`;
      const solid = colorOf(first(entry, 'solidFill'), ctx) || colorElement(children(reference)[0], ctx);
      if (solid) return `background:${cssColor(solid)};`;
    }
  }
  return 'background:#ffffff;';
}

async function renderSlides(reader, sections) {
  const theme = await loadTheme(reader);
  const presentation = await reader.xml('ppt/presentation.xml');
  const relations = await reader.relationships('ppt/presentation.xml');
  const size = first(presentation, 'sldSz');
  const widthEmu = Math.max(1, number(attr(size, 'cx'), 9144000));
  const heightEmu = Math.max(1, number(attr(size, 'cy'), 5143500));
  const slideIds = descendants(presentation, 'sldId');

  const layoutCache = new Map(), masterCache = new Map();
  async function loadMaster(target) {
    if (!target) return { sheet: null, placeholders: null, target: '' };
    if (!masterCache.has(target)) {
      const sheet = rootOf(await reader.xml(target, true));
      masterCache.set(target, { sheet, placeholders: placeholderLookup(sheet), target });
    }
    return masterCache.get(target);
  }
  async function loadLayout(target) {
    if (!target) return { sheet: null, placeholders: null, relations: new Map(), master: { sheet: null, placeholders: null } };
    if (!layoutCache.has(target)) {
      const sheet = rootOf(await reader.xml(target, true));
      const sheetRelations = await reader.relationships(target, true);
      const masterTarget = [...sheetRelations.values()].find(value => /slideMasters\/[^/]+\.xml$/.test(value));
      layoutCache.set(target, { sheet, placeholders: placeholderLookup(sheet), relations: sheetRelations, master: await loadMaster(masterTarget) });
    }
    return layoutCache.get(target);
  }

  const body = [];
  let truncated = false;
  for (const [index, slide] of slideIds.slice(0, MAX_SLIDES).entries()) {
    const target = relations.get(attr(slide, 'r:id'));
    if (!target) continue;
    const content = rootOf(await reader.xml(target, true));
    if (!content) continue;
    const slideRelations = await reader.relationships(target, true);
    const layoutTarget = [...slideRelations.values()].find(value => /slideLayouts\/[^/]+\.xml$/.test(value));
    const layout = await loadLayout(layoutTarget);
    const master = layout.master || await loadMaster(null);

    const state = { count: 0, images: 0, truncated: false };
    const ctx = {
      theme, widthEmu, heightEmu, widthPoints: widthEmu / 12700, slideNumber: index + 1,
      relations: new Map(), image: reader.image, xml: reader.xml,
      layout: layout.placeholders, master: master.placeholders, masterSheet: master.sheet,
      placeholder: findPlaceholder, autofit: 1, shape: null, phColor: '', ...state,
    };
    // Each layer resolves only its own relationships; a layout or master shape
    // must never borrow the slide's picture targets or counters.
    const layer = relations => Object.assign(ctx, { relations, count: state.count, images: state.images, truncated: state.truncated });
    const slideKeys = new Set(children(first(content, 'spTree'), 'sp').map(placeholderKey).filter(Boolean));
    const layoutKeys = new Set(children(first(layout.sheet, 'spTree'), 'sp').map(placeholderKey).filter(Boolean));
    // Inheritance is by placeholder type: a slide's ctrTitle fills the layout's
    // title slot, and a layout's date slot replaces the master's even when the
    // two use different indices.
    const layoutTypes = new Set([...layoutKeys].map(key => key.split(':')[0]));
    const pieces = [];
    const showMasterShapes = flag(first(content, 'showMasterSp'), true) && flag(first(layout.sheet, 'showMasterSp'), true);
    const frame = { x: 0, y: 0, w: widthEmu, h: heightEmu };
    if (showMasterShapes && master.sheet) {
      const masterRelations = await reader.relationships(master.target, true);
      layer(masterRelations);
      for (const shape of children(first(master.sheet, 'spTree'))) {
        if (shape.localName === 'nvGrpSpPr' || shape.localName === 'grpSpPr') continue;
        const key = placeholderKey(shape);
        // A master placeholder is only a prompt slot; visible content comes from
        // the layout or the slide. PowerPoint hides it when the layout does not
        // declare that slot, so it is never drawn directly on the slide.
        if (key || isPromptPlaceholder(shape)) continue;
        pieces.push(await shapeHtml(shape, ctx, frame));
        state.count = ctx.count; state.images = ctx.images; state.truncated ||= ctx.truncated;
      }
    }
    if (layout.sheet) {
      layer(layout.relations);
      for (const shape of children(first(layout.sheet, 'spTree'))) {
        if (shape.localName === 'nvGrpSpPr' || shape.localName === 'grpSpPr') continue;
        const key = placeholderKey(shape);
        if (key && (slideKeys.has(key) || isPromptPlaceholder(shape))) continue;
        pieces.push(await shapeHtml(shape, ctx, frame));
        state.count = ctx.count; state.images = ctx.images; state.truncated ||= ctx.truncated;
      }
    }
    layer(slideRelations);
    for (const shape of children(first(content, 'spTree'))) {
      if (shape.localName === 'nvGrpSpPr' || shape.localName === 'grpSpPr') continue;
      pieces.push(await shapeHtml(shape, ctx, frame));
      state.count = ctx.count; state.images = ctx.images; state.truncated ||= ctx.truncated;
    }
    truncated ||= state.truncated || ctx.count > MAX_SHAPES_PER_SLIDE || ctx.images > 80;
    const background = await slideBackground(ctx, content, layout.sheet, master.sheet);
    body.push(`<section class="slide-page"><h2>${index + 1}</h2><div class="slide" style="aspect-ratio:${widthEmu}/${heightEmu};${background}">${pieces.join('')}</div></section>`);
  }
  truncated ||= slideIds.length > MAX_SLIDES;
  return { html: body.join(''), truncated };
}

module.exports = { renderSlides };

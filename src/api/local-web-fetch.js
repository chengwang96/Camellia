'use strict';

const { promises: dns } = require('node:dns');
const net = require('node:net');
const cheerio = require('cheerio');

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const BLOCKED_IPV4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

function localError(message, { code = 'web_page_unavailable', status, retryable = false, downloadUrl } = {}) {
  return Object.assign(new Error(message), { provider: 'local', operation: 'fetch', code, retryable,
    ...(status ? { status } : {}), ...(downloadUrl ? { download_url: downloadUrl } : {}) });
}

function pageUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw localError('Enter a complete HTTP or HTTPS page URL'); }
  if (typeof value !== 'string' || value.length > 8192 || url.href.length > 8192 || !['http:', 'https:'].includes(url.protocol)
    || !url.hostname || url.username || url.password) throw localError('Enter a complete HTTP or HTTPS page URL without credentials');
  return url;
}

function ipv4Value(address) {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((value, part) => value * 256 + Number(part), 0);
}

function inIpv4Range(value, base, bits) {
  const start = ipv4Value(base);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((value & mask) >>> 0) === ((start & mask) >>> 0);
}

function publicIpv4(address) {
  const value = ipv4Value(address);
  return value !== null && !BLOCKED_IPV4.some(([base, bits]) => inIpv4Range(value, base, bits));
}

function ipv6Groups(address) {
  let value = address.toLowerCase();
  if (value.includes('.')) {
    const index = value.lastIndexOf(':');
    const ipv4 = ipv4Value(value.slice(index + 1));
    if (ipv4 === null) return null;
    value = value.slice(0, index + 1) + Math.floor(ipv4 / 65536).toString(16) + ':' + (ipv4 % 65536).toString(16);
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8 || left.length + right.length > 8) return null;
  const groups = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return groups.length === 8 && groups.every(group => /^[0-9a-f]{1,4}$/.test(group))
    ? groups.map(group => parseInt(group, 16)) : null;
}

function inIpv6Range(groups, base, bits) {
  const start = ipv6Groups(base);
  for (let index = 0; index < 8; index++) {
    const remaining = bits - index * 16;
    if (remaining <= 0) return true;
    const mask = remaining >= 16 ? 0xffff : (0xffff << (16 - remaining)) & 0xffff;
    if ((groups[index] & mask) !== (start[index] & mask)) return false;
  }
  return true;
}

function publicIpv6(address) {
  const groups = ipv6Groups(address);
  if (!groups) return false;
  if (inIpv6Range(groups, '::', 96) || inIpv6Range(groups, '::1', 128)
    || inIpv6Range(groups, 'fc00::', 7) || inIpv6Range(groups, 'fe80::', 10)
    || inIpv6Range(groups, 'ff00::', 8) || inIpv6Range(groups, '2001:db8::', 32)) return false;
  if (inIpv6Range(groups, '::ffff:0:0', 96)) {
    const value = groups[6] * 65536 + groups[7];
    return publicIpv4([24, 16, 8, 0].map(bits => Math.floor(value / 2 ** bits) % 256).join('.'));
  }
  return true;
}

function publicAddress(address) {
  const host = String(address || '').replace(/^\[|\]$/g, '').split('%')[0];
  const version = net.isIP(host);
  return version === 4 ? publicIpv4(host) : version === 6 ? publicIpv6(host) : false;
}

async function assertPublicUrl(url, lookup, allowProxyDns) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname || !net.isIP(hostname) && !hostname.includes('.') || hostname === 'localhost' || hostname.endsWith('.localhost')
    || ['.local', '.internal', '.lan', '.home', '.corp'].some(suffix => hostname.endsWith(suffix))) {
    throw localError('Local page fetching is limited to public internet addresses.', { code: 'web_fetch_blocked' });
  }
  if (net.isIP(hostname)) {
    if (!publicAddress(hostname)) throw localError('Local page fetching is limited to public internet addresses.', { code: 'web_fetch_blocked' });
    return;
  }
  let records;
  try { records = await lookup(hostname, { all: true, verbatim: true }); }
  catch {
    if (allowProxyDns) return;
    throw localError('Could not resolve the page host through this computer.', { code: 'web_fetch_network', retryable: true });
  }
  if (!Array.isArray(records) || records.length === 0) {
    if (allowProxyDns) return;
    throw localError('Could not resolve the page host through this computer.', { code: 'web_fetch_network', retryable: true });
  }
  if (records.some(record => !publicAddress(record.address))) {
    throw localError('Local page fetching is limited to public internet addresses.', { code: 'web_fetch_blocked' });
  }
}

function attachmentError(url) {
  return localError('This URL points to a Word (DOCX) attachment. Download the attachment from its original URL and read it as a local DOCX file.', {
    code: 'web_attachment_requires_download', downloadUrl: url,
  });
}

async function readBody(response) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    await response.body?.cancel?.().catch(() => {});
    throw localError('The page is too large for local fetching. Try a narrower page URL.', { code: 'web_page_too_large' });
  }
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > MAX_BODY_BYTES) throw localError('The page is too large for local fetching. Try a narrower page URL.', { code: 'web_page_too_large' });
    return bytes;
  }
  const reader = response.body.getReader(), chunks = [];
  let bytes = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw localError('The page is too large for local fetching. Try a narrower page URL.', { code: 'web_page_too_large' });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function decodeBody(bytes, contentType) {
  const match = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType);
  try { return new TextDecoder(match?.[1] || 'utf-8').decode(bytes); }
  catch { return new TextDecoder('utf-8').decode(bytes); }
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function markdownLink(value) {
  return value.replace(/\(/g, '%28').replace(/\)/g, '%29');
}

function extractPage(source, url) {
  try {
    const $ = cheerio.load(source);
    const title = cleanText($('meta[property="og:title"]').attr('content')
      || $('meta[name="twitter:title"]').attr('content') || $('title').first().text()
      || $('h1').first().text() || url.hostname);
    let baseUrl = url;
    const base = $('base[href]').first().attr('href');
    if (base) {
      try {
        const candidate = new URL(base, url);
        if (['http:', 'https:'].includes(candidate.protocol)) baseUrl = candidate;
      } catch { }
    }
    $('script, style, noscript, template, svg, canvas, iframe, object, embed, form, nav, footer, aside').remove();
    $('[hidden], [aria-hidden="true"]').remove();
    const candidates = $('article, main, [role="main"]').toArray();
    const root = candidates.sort((a, b) => cleanText($(b).text()).length - cleanText($(a).text()).length)[0]
      || $('body').get(0) || $.root().get(0);
    const block = value => value ? `\n\n${value.trim()}\n\n` : '';
    function renderChildren(node, context) {
      return Array.from(node.children || []).map(child => render(child, context)).join('');
    }
    function render(node, context = {}) {
      if (node.type === 'text') return context.pre ? node.data || '' : String(node.data || '').replace(/\s+/g, ' ');
      if (node.type !== 'tag' && node.type !== 'root') return '';
      const name = String(node.name || node.tagName || '').toLowerCase();
      if (name === 'br') return '\n';
      if (name === 'hr') return block('---');
      if (name === 'pre') {
        const value = $(node).text().replace(/^\n|\n$/g, '');
        const longest = Math.max(0, ...Array.from(value.matchAll(/`+/g), match => match[0].length));
        const fence = '`'.repeat(Math.max(3, longest + 1));
        return block(`${fence}\n${value}\n${fence}`);
      }
      if (/^h[1-6]$/.test(name)) return block(`${'#'.repeat(Number(name[1]))} ${renderChildren(node, context).trim()}`);
      if (name === 'blockquote') return block(renderChildren(node, context).trim().split('\n').map(line => '> ' + line).join('\n'));
      if (name === 'ul' || name === 'ol') {
        return block(renderChildren(node, { ...context, list: name, depth: (context.depth || 0) + 1 }).trim());
      }
      if (name === 'li') {
        const siblings = Array.from(node.parent?.children || []).filter(child => child.name === 'li');
        const marker = context.list === 'ol' ? `${siblings.indexOf(node) + 1}.` : '-';
        const indent = '  '.repeat(Math.max(0, (context.depth || 1) - 1));
        return `\n${indent}${marker} ${renderChildren(node, context).trim()}`;
      }
      if (name === 'table') {
        const rows = $(node).find('tr').toArray().map(row => $(row).find('th, td').toArray()
          .map(cell => cleanText(renderChildren(cell, context)).replace(/\|/g, '\\|'))).filter(cells => cells.length);
        if (!rows.length) return '';
        const width = Math.max(...rows.map(row => row.length));
        const lines = rows.map(row => `| ${Array.from({ length: width }, (_, index) => row[index] || '').join(' | ')} |`);
        lines.splice(1, 0, `| ${Array(width).fill('---').join(' | ')} |`);
        return block(lines.join('\n'));
      }
      if (name === 'a') {
        const text = renderChildren(node, context).trim();
        if (!text) return '';
        try {
          const href = new URL($(node).attr('href') || '', baseUrl);
          if (!['http:', 'https:'].includes(href.protocol)) return text;
          return `[${text}](${markdownLink(href.href)})`;
        } catch { return text; }
      }
      if (name === 'img') return cleanText($(node).attr('alt'));
      if (name === 'code') {
        const value = $(node).text();
        const longest = Math.max(0, ...Array.from(value.matchAll(/`+/g), match => match[0].length));
        const fence = '`'.repeat(Math.max(1, longest + 1));
        return value ? `${fence}${value}${fence}` : '';
      }
      if (name === 'strong' || name === 'b') {
        const value = renderChildren(node, context).trim();
        return value ? `**${value}**` : '';
      }
      if (name === 'em' || name === 'i') {
        const value = renderChildren(node, context).trim();
        return value ? `*${value}*` : '';
      }
      if (name === 'del' || name === 's') {
        const value = renderChildren(node, context).trim();
        return value ? `~~${value}~~` : '';
      }
      const content = renderChildren(node, { ...context, pre: context.pre || name === 'code' });
      return ['p', 'div', 'section', 'article', 'main', 'header', 'figure', 'figcaption', 'details', 'summary', 'center'].includes(name)
        ? block(content) : content;
    }
    const content = render(root).replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!content) throw localError('This computer could not extract readable content from the page.');
    return { title: title || url.hostname, content };
  } catch (error) {
    if (error.provider === 'local') throw error;
    throw localError('This computer could not extract readable content from the page.');
  }
}

function createLocalWebFetch({ fetchImpl = fetch, lookup = dns.lookup, timeoutMs = 20000, maxRedirects = MAX_REDIRECTS, allowProxyDns = false } = {}) {
  return {
    async fetchPage(value, { signal, allowProxyDns: routeProxyDns } = {}) {
      const timeout = AbortSignal.timeout(timeoutMs);
      const operationSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let current = pageUrl(value);
      try {
        for (let redirects = 0; redirects <= maxRedirects; redirects++) {
          if (operationSignal.aborted) throw operationSignal.reason;
          current = pageUrl(current.href);
          await assertPublicUrl(current, lookup, routeProxyDns ?? allowProxyDns);
          const response = await fetchImpl(current.href, {
            headers: { Accept: 'text/html, application/xhtml+xml, text/plain;q=0.9, text/markdown;q=0.9', 'User-Agent': 'Camellia/1.0' },
            redirect: 'manual', signal: operationSignal,
          });
          if (REDIRECTS.has(response.status)) {
            const location = response.headers.get('location');
            await response.body?.cancel?.().catch(() => {});
            if (!location) throw localError('The page returned an invalid redirect.');
            if (redirects >= maxRedirects) throw localError('The page redirected too many times.');
            current = pageUrl(new URL(location, current).href);
            continue;
          }
          if (!response.ok) throw localError(`HTTP ${response.status} · The page could not be fetched through this computer.`, { status: response.status });
          const contentType = String(response.headers.get('content-type') || '').toLowerCase();
          if (/\.docx$/i.test(current.pathname.replace(/%2e/ig, '.'))
            || contentType.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document')) throw attachmentError(current.href);
          const supported = !contentType || /^(?:text\/html|application\/xhtml\+xml|text\/plain|text\/markdown)(?:\s*;|$)/.test(contentType);
          if (!supported) throw localError(`Local page fetching does not support this content type${contentType ? ': ' + contentType.split(';')[0] : ''}.`);
          const source = decodeBody(await readBody(response), contentType);
          const page = /^(?:text\/plain|text\/markdown)(?:\s*;|$)/.test(contentType)
            ? { title: current.hostname, content: source.trim() } : extractPage(source, current);
          if (!page.content) throw localError('This computer could not extract readable content from the page.');
          return { ...page, final_url: current.href };
        }
        throw localError('The page redirected too many times.');
      } catch (error) {
        if (error.provider === 'local') throw Object.assign(error, { url: value });
        if (signal?.aborted) throw localError('Web tool call cancelled', { code: 'web_fetch_cancelled' });
        if (error.name === 'TimeoutError' || error.name === 'AbortError') {
          throw Object.assign(localError('Local page fetch timed out. Try again later.', { code: 'web_fetch_network', retryable: true }), { url: value });
        }
        throw Object.assign(localError('Could not fetch the page through this computer. Check the connection mode and proxy.', {
          code: 'web_fetch_network', retryable: true,
        }), { url: value });
      }
    },
  };
}

module.exports = { createLocalWebFetch, extractPage, publicAddress };

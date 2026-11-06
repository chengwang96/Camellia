'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLocalWebFetch, extractPage, publicAddress } = require('../src/api/local-web-fetch');

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const html = body => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });

test('HTML extraction recovers common malformed markup and produces clean Markdown', () => {
  const page = extractPage(`<!doctype html><html><head><title>Example article</title></head><body>
    <nav>Navigation</nav><article><h1>Heading</h1><p>Hello <strong>world</strong>.<p>Next <a href="/more">More</a>
    <ul><li>One<li>Two</ul><table><tr><th>Name</th><th>Value</th></tr><tr><td>A</td><td>1</td></tr></table>
    <pre><code>const x = 1;</code></pre></article><script>secret()</script></body></html>`, new URL('https://example.com/root/page'));
  assert.equal(page.title, 'Example article');
  assert.match(page.content, /# Heading/);
  assert.match(page.content, /Hello \*\*world\*\*\./);
  assert.match(page.content, /\[More\]\(https:\/\/example\.com\/more\)/);
  assert.match(page.content, /- One\n- Two/);
  assert.match(page.content, /\| Name \| Value \|\n\| --- \| --- \|/);
  assert.match(page.content, /```\nconst x = 1;\n```/);
  assert.doesNotMatch(page.content, /Navigation|secret\(\)/);
});

test('public address checks reject local, special-use and mapped addresses', () => {
  for (const address of ['0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.1.1', '172.16.0.1',
    '192.168.1.1', '192.0.2.1', '198.18.0.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '::ffff:127.0.0.1', '::ffff:a00:1']) {
    assert.equal(publicAddress(address), false, address);
  }
  for (const address of ['8.8.8.8', '93.184.216.34', '1.1.1.1', '2606:4700::6810:84e5', '2001:4860:4860::8888']) {
    assert.equal(publicAddress(address), true, address);
  }
});

test('local fetch checks DNS, uses a bounded GET and returns extracted content', async () => {
  const calls = [], lookups = [];
  const service = createLocalWebFetch({ lookup: async (host, options) => { lookups.push({ host, options }); return publicLookup(); },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return html('<html><head><title>Local</title></head><body><main><p>Readable content</p></main></body></html>');
    } });
  const page = await service.fetchPage('https://example.com/article');
  assert.equal(page.title, 'Local'); assert.equal(page.content, 'Readable content');
  assert.equal(page.final_url, 'https://example.com/article');
  assert.equal(calls.length, 1); assert.equal(calls[0].options.method, undefined);
  assert.equal(calls[0].options.redirect, 'manual'); assert.match(calls[0].options.headers.Accept, /text\/html/);
  assert.equal(lookups[0].host, 'example.com'); assert.equal(lookups[0].options.all, true);
});

test('redirects are rechecked and report the final public URL', async () => {
  const calls = [];
  const service = createLocalWebFetch({ lookup: publicLookup, fetchImpl: async url => {
    calls.push(url);
    return calls.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://example.org/final' } })
      : html('<main><p>Final page</p></main>');
  } });
  const page = await service.fetchPage('https://example.com/start');
  assert.equal(page.content, 'Final page'); assert.equal(page.final_url, 'https://example.org/final');
  assert.deepEqual(calls, ['https://example.com/start', 'https://example.org/final']);
});

test('a redirect to an internal address is blocked before the second request', async () => {
  let calls = 0;
  const service = createLocalWebFetch({ lookup: publicLookup, fetchImpl: async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } });
  } });
  await assert.rejects(service.fetchPage('https://example.com/start'), error => {
    assert.equal(error.code, 'web_fetch_blocked'); assert.equal(error.provider, 'local');
    assert.equal(error.url, 'https://example.com/start'); return true;
  });
  assert.equal(calls, 1);
});

test('mixed public and private DNS answers are rejected before any request', async () => {
  let calls = 0;
  const service = createLocalWebFetch({ lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '192.168.1.2', family: 4 }],
    fetchImpl: async () => { calls++; return html('<p>Should not load</p>'); } });
  await assert.rejects(service.fetchPage('https://example.com/'), { code: 'web_fetch_blocked' });
  assert.equal(calls, 0);
});

test('redirect limits, HTTP failures and unsupported content report safe errors', async () => {
  let calls = 0;
  const redirects = createLocalWebFetch({ lookup: publicLookup, maxRedirects: 1, fetchImpl: async () => {
    calls++; return new Response(null, { status: 302, headers: { location: '/next' } });
  } });
  await assert.rejects(redirects.fetchPage('https://example.com/start'), /redirected too many/);
  assert.equal(calls, 2);
  const missing = createLocalWebFetch({ lookup: publicLookup, fetchImpl: async () => new Response('private details', { status: 404 }) });
  await assert.rejects(missing.fetchPage('https://example.com/missing'), error => {
    assert.equal(error.status, 404); assert.doesNotMatch(error.message, /private details/); return true;
  });
  const pdf = createLocalWebFetch({ lookup: publicLookup, fetchImpl: async () => new Response('binary', { headers: { 'content-type': 'application/pdf' } }) });
  await assert.rejects(pdf.fetchPage('https://example.com/file'), /application\/pdf/);
});

test('DOCX responses preserve the download workflow instead of being parsed as pages', async () => {
  const service = createLocalWebFetch({ lookup: publicLookup, fetchImpl: async () => new Response('docx', {
    headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  }) });
  await assert.rejects(service.fetchPage('https://example.com/attachment.docx'), error => {
    assert.equal(error.code, 'web_attachment_requires_download');
    assert.equal(error.download_url, 'https://example.com/attachment.docx'); return true;
  });
});

test('plain text and oversized responses are bounded before extraction', async () => {
  const text = createLocalWebFetch({ lookup: publicLookup, fetchImpl: async () => new Response('First line\nSecond line', {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  }) });
  assert.equal((await text.fetchPage('https://example.com/text')).content, 'First line\nSecond line');
  const declared = createLocalWebFetch({ lookup: publicLookup, fetchImpl: async () => new Response('x', {
    headers: { 'content-type': 'text/plain', 'content-length': String(2 * 1024 * 1024 + 1) },
  }) });
  await assert.rejects(declared.fetchPage('https://example.com/large'), { code: 'web_page_too_large' });
  const streamed = createLocalWebFetch({ lookup: publicLookup, fetchImpl: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1), {
    headers: { 'content-type': 'text/plain', 'content-length': '' },
  }) });
  await assert.rejects(streamed.fetchPage('https://example.com/large'), { code: 'web_page_too_large' });
});

test('timeouts and cancellation do not expose network internals', async () => {
  const timeout = createLocalWebFetch({ lookup: publicLookup, timeoutMs: 10, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  await assert.rejects(timeout.fetchPage('https://example.com/slow'), /timed out/);
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  const cancelled = createLocalWebFetch({ lookup: publicLookup, fetchImpl: async () => { calls++; return html('<p>Unused</p>'); } });
  await assert.rejects(cancelled.fetchPage('https://example.com/', { signal: controller.signal }), /cancelled/);
  assert.equal(calls, 0);
});


test('proxy remote DNS is allowed only for a proxy route and never relaxes host blocking', async () => {
  const unresolved = async () => { throw Object.assign(new Error('private resolver detail'), { code: 'ENOTFOUND' }); };
  let calls = 0;
  const fetchPage = async () => { calls++; return html('<main><p>Resolved by proxy</p></main>'); };
  const direct = createLocalWebFetch({ lookup: unresolved, fetchImpl: fetchPage });
  await assert.rejects(direct.fetchPage('https://example.com/'), { code: 'web_fetch_network' });
  assert.equal(calls, 0);
  const proxy = createLocalWebFetch({ lookup: unresolved, fetchImpl: fetchPage, allowProxyDns: true });
  assert.equal((await proxy.fetchPage('https://example.com/')).content, 'Resolved by proxy');
  assert.equal(calls, 1);
  await assert.rejects(proxy.fetchPage('http://router/'), { code: 'web_fetch_blocked' });
  await assert.rejects(proxy.fetchPage('http://gateway.lan/'), { code: 'web_fetch_blocked' });
  await assert.rejects(proxy.fetchPage('http://127.0.0.1/'), { code: 'web_fetch_blocked' });
  assert.equal(calls, 1);
});

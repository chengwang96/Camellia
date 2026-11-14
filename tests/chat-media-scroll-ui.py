"""Delayed image decoding and video metadata keep idle history at the bottom."""
import ast
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

repo = Path(__file__).resolve().parents[1]
tree = ast.parse((repo / 'tests/shared-chat-ui.py').read_text(encoding='utf-8'))
fixture = next(ast.literal_eval(node.value) for node in tree.body
               if isinstance(node, ast.Assign)
               and any(isinstance(target, ast.Name) and target.id == 'fixture' for target in node.targets))
node = next(node for node in tree.body if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == 'bridge' for target in node.targets))
fixture['messages'] = [dict(role='assistant' if index % 2 else 'user', seq=index + 1,
                            text=f'History {index}\n\n' + 'A saved paragraph.\n\n' * 5)
                       for index in range(30)]
fixture['messages'][-1]['text'] += '\n\n'.join([
    '![First](https://media.test/first.png)',
    '![Video](https://media.test/late.webm)',
    '![Reading](https://media.test/reading.png)',
    '![Return](https://media.test/return.png)',
    '![Missing](https://media.test/missing.png)',
    'The latest message ends here.',
])
bridge = ast.literal_eval(node.value.func.value).replace('FIXTURE', json.dumps(fixture))


def settled(page):
    page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')


def gap(page):
    return page.evaluate('chatScroll.scrollHeight-chatScroll.clientHeight-chatScroll.scrollTop')


def image(page, pending, name):
    route = pending.pop(name)
    route.fulfill(content_type='image/svg+xml', body=(
        '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="420">'
        '<rect width="320" height="420" fill="#789"/></svg>'))
    page.wait_for_function('(name) => document.querySelector(`img[src$="/${name}"]`)?.naturalHeight > 0', arg=name)
    settled(page)


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    # A real portrait WebM makes metadata loading change the default 300x150 box.
    recorder = browser.new_page()
    video = recorder.evaluate('''async () => {
      const canvas = document.createElement('canvas'); canvas.width=192; canvas.height=512;
      const context = canvas.getContext('2d'); context.fillStyle='#789'; context.fillRect(0,0,192,512);
      const stream = canvas.captureStream(10), chunks=[];
      const recorder = new MediaRecorder(stream, {mimeType:'video/webm;codecs=vp8'});
      const stopped = new Promise(resolve => { recorder.onstop=resolve; });
      recorder.ondataavailable = event => chunks.push(event.data);
      recorder.start(); await new Promise(resolve => setTimeout(resolve,200)); recorder.stop();
      await stopped; stream.getTracks().forEach(track => track.stop());
      return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
    }''')
    recorder.close()
    errors = []
    for width, theme in [(1200, 'light'), (480, 'dark')]:
        page = browser.new_page(viewport={'width':width, 'height':820}, color_scheme=theme)
        page.on('pageerror', lambda error: errors.append(str(error)))
        pending = {}
        page.route('https://media.test/**', lambda route: pending.__setitem__(route.request.url.rsplit('/', 1)[-1], route))
        page.add_init_script(bridge)
        page.goto((repo / 'src/renderer/chat/workbench.html').as_uri()
                  + '?harness=codex&conversation=shared-fixture', wait_until='domcontentloaded')
        page.wait_for_function('uiReady && !loadingSession')
        settled(page)
        assert not page.evaluate('running')
        assert abs(gap(page)) <= 1
        assert len(pending) == 5, pending.keys()

        image(page, pending, 'first.png')
        assert abs(gap(page)) <= 1, ('Delayed image lost bottom', width, gap(page))

        pending.pop('late.webm').fulfill(content_type='video/webm', body=bytes(video))
        page.wait_for_function('document.querySelector("video.chat-inline-video")?.videoHeight === 512')
        settled(page)
        assert abs(gap(page)) <= 1, ('Video metadata lost bottom', width, gap(page))

        # A small real upward gesture still counts as reading history.
        page.locator('#chatScroll').hover()
        page.mouse.wheel(0, -24)
        page.wait_for_function('!followRunOutput && chatScroll.scrollHeight-chatScroll.clientHeight-chatScroll.scrollTop > 10')
        settled(page)
        before = page.evaluate('chatScroll.scrollTop')
        image(page, pending, 'reading.png')
        assert abs(page.evaluate('chatScroll.scrollTop') - before) <= 1
        assert not page.evaluate('followRunOutput')

        page.mouse.wheel(0, 100000)
        page.wait_for_function('followRunOutput && chatScroll.scrollHeight-chatScroll.clientHeight-chatScroll.scrollTop <= 1')
        image(page, pending, 'return.png')
        assert abs(gap(page)) <= 1

        # Replacing a failed resource can shrink the history as well as grow it.
        pending.pop('missing.png').fulfill(status=404, body='missing')
        page.wait_for_selector('#chat .chat-image-fallback')
        settled(page)
        assert abs(gap(page)) <= 1
        page.close()
    browser.close()
    assert not errors, errors
print('PASS: idle delayed images/video stay at bottom on desktop and narrow layouts; reading and bottom return are respected')

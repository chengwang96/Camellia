import ast
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[1]
module = ast.parse((root / 'tests/shared-chat-ui.py').read_text(encoding='utf-8'))
fixture = next(ast.literal_eval(node.value) for node in module.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'fixture' for target in node.targets))
bridge_node = next(node for node in module.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'bridge' for target in node.targets))
file = dict(name='interactive.html', path='C:/outputs/interactive.html', extension='HTML', kind='text', size=1024)
fixture['messages'][-1]['artifacts'] = [file]
source = '''<!doctype html><h1>Interactive report</h1>
<button id="increment" onclick="document.getElementById('count').textContent=++window.count">Increment</button><output id="count">0</output>
<input id="entry"><button id="echo" onclick="document.getElementById('result').textContent=document.getElementById('entry').value">Apply</button><output id="result"></output>
<canvas width="10" height="10"></canvas><p id="isolation"></p><p id="network"></p>
<button id="popup" onclick="window.open('https://example.com/popup')">Popup</button>
<a id="escape" href="https://example.com/escape" target="_top">Escape</a>
<form action="https://example.com/submit"><button id="submit">Submit</button></form>
<script src="https://example.com/external.js"></script>
<script>
window.count=0;
document.querySelector('canvas').getContext('2d').fillRect(0,0,10,10);
try{parent.document.body.dataset.compromised='true'}catch{document.getElementById('isolation').textContent='isolated'}
fetch('https://example.com/api').then(()=>document.getElementById('network').textContent='allowed').catch(()=>document.getElementById('network').textContent='blocked');
</script>'''
bridge = ast.literal_eval(bridge_node.value.func.value).replace('FIXTURE', json.dumps(fixture))
bridge += "window.dshDesktop.resolveArtifacts=async()=>({ok:true,files:[FILE]});window.dshDesktop.previewFile=async()=>({ok:true,file:{...FILE,url:'file:///C:/outputs/interactive.html',text:SOURCE}});".replace('FILE', json.dumps(file)).replace('SOURCE', json.dumps(source))

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    for width in [1440, 960]:
        page = browser.new_page(viewport={'width': width, 'height': 900})
        requests = []
        popups = []
        page.route('https://example.com/**', lambda route: (requests.append(route.request.url), route.abort()))
        page.on('popup', lambda popup: popups.append(popup))
        page.add_init_script('if (window === window.top) {\n' + bridge + '\n}')
        page.goto((root / 'src/renderer/chat/claude.html').as_uri() + '?harness=codex&conversation=shared-fixture', wait_until='networkidle')
        page.wait_for_function('uiReady')
        page.locator('.artifact-file').click()
        frame = page.frame_locator('.file-preview-html')
        expect(frame.locator('#isolation')).to_have_text('isolated')
        expect(frame.locator('#network')).to_have_text('blocked')
        frame.locator('#increment').click()
        expect(frame.locator('#count')).to_have_text('1')
        frame.locator('#entry').fill('Hello preview')
        frame.locator('#echo').click()
        expect(frame.locator('#result')).to_have_text('Hello preview')
        assert frame.locator('canvas').evaluate('(canvas)=>canvas.getContext("2d").getImageData(0,0,1,1).data[3]') == 255
        assert frame.locator('body').evaluate('()=>typeof window.dshDesktop') == 'undefined'
        assert page.locator('.file-preview-html').evaluate('(frame)=>frame.contentDocument===null')
        original_url = page.url
        frame.locator('#popup').click()
        frame.locator('#escape').click()
        frame.locator('#submit').click()
        assert page.url == original_url
        assert not requests, requests
        assert not popups, popups
        assert page.evaluate('document.body.dataset.compromised') is None
        page.get_by_role('button', name='Reload', exact=True).click()
        expect(frame.locator('#count')).to_have_text('0')
        select = page.locator('.html-preview-toolbar select')
        select.select_option('static')
        expect(page.locator('.file-preview-html')).to_have_attribute('sandbox', '')
        frame.locator('#increment').click()
        expect(frame.locator('#count')).to_have_text('0')
        select.select_option('source')
        expect(page.locator('.file-preview-html')).to_have_count(0)
        expect(page.locator('.html-preview-content pre')).to_have_text(source)
        select.select_option('interactive')
        frame.locator('#increment').click()
        expect(frame.locator('#count')).to_have_text('1')
        output = root / 'dist/ui-preview'
        output.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(output / f'html-interactive-{width}.png'))
        page.locator('#fileViewerClose').click()
        expect(page.locator('.file-preview-html')).to_have_count(0)
        page.close()
    browser.close()
print('Interactive HTML: buttons, input, canvas, source/static modes, reload and sandbox boundaries passed')

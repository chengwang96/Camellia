"""Real browser checks for the trusted Android card-viewer asset; no server required."""
import argparse
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = (ROOT / 'android/app/src/main/assets/card-viewport.js').read_text(encoding='utf-8')
KEY = '__viewer_test'
BASE = '''<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;min-height:100%;font:16px Arial}*{box-sizing:border-box}.viz-theme{min-height:100%;padding:16px}
button,input,select{font:inherit;min-height:44px}.controls{height:96px}.stage{display:block;width:100%;height:100vh;background:#e7eaf1}
footer{height:140px;padding:12px;background:#f0f3ff}#inner{height:150px;overflow:auto}</style></head><body><div class="viz-theme">
<div class="controls"><input id="note" value="original"><button id="choice" onclick="this.textContent='Selected';window.clicks++">Choose</button>
<input id="slider" type="range" min="0" max="100" value="73"></div><canvas class="stage" id="drawing" width="160" height="120"></canvas>
<footer id="end">Source and details</footer></div><script>window.session={};window.clicks=0;drawing.getContext('2d').fillRect(0,0,20,20);</script></body></html>'''


def install(page, html=BASE):
    page.evaluate('(key)=>{if(window[key])window[key].destroy()}', KEY)
    page.set_content(html, wait_until='networkidle')
    page.evaluate(SCRIPT, KEY)
    return update(page, 'width')


def update(page, mode, scale=1):
    size = page.viewport_size
    return page.evaluate('''([key,mode,scale,width,height]) => window[key].update(width,height,mode,scale)''', [KEY, mode, scale, size['width'], size['height']])


def fit_assert(page):
    bounds = page.locator('.viz-theme').bounding_box()
    end = page.locator('#end').bounding_box()
    size = page.viewport_size
    assert bounds['x'] >= -1 and bounds['y'] >= -1, bounds
    assert bounds['x'] + bounds['width'] <= size['width'] + 2, bounds
    assert end['y'] + end['height'] <= size['height'] + 2, (end, size)
    page.mouse.wheel(0,300)
    page.wait_for_timeout(60)
    assert page.evaluate('window.scrollY') == 0, 'Whole-card overview must not scroll into blank space'


def run(page, output, name):
    completed = []
    install(page)
    assert page.evaluate('document.documentElement.scrollHeight') > page.viewport_size['height'] + 100
    page.evaluate("window.originalSession=session;window.originalCanvas=drawing;note.value='retained draft';slider.value='41'")
    state = update(page, 'page')
    assert 0 < state['scale'] < 1
    fit_assert(page)
    page.locator('#choice').click()
    assert page.evaluate("clicks===1&&note.value==='retained draft'&&slider.value==='41'&&drawing===originalCanvas&&session===originalSession")
    page.screenshot(path=str(output / f'{name}-whole-card.png'))
    completed.append('whole-card-and-live-controls')

    for scale in [1.25, 1.5625, .8, 3, 1]:
        assert abs(update(page, 'custom', scale)['scale'] - scale) < .0001
    assert page.evaluate("note.value==='retained draft'&&drawing===originalCanvas")
    update(page, 'width')
    assert page.evaluate('document.documentElement.scrollHeight') > page.viewport_size['height']
    completed.append('manual-zoom-and-reset')

    install(page, BASE.replace('<canvas class=', '<div style="width:1600px;height:70px">Wide content</div><canvas class='))
    assert update(page, 'width')['scale'] < 1
    update(page, 'page'); fit_assert(page)
    completed.append('wide-overflow')

    install(page); original_scale = update(page, 'page')['scale']
    page.evaluate("var extra=document.createElement('div');extra.style.height='2800px';extra.textContent='Additional details';document.querySelector('.viz-theme').insertBefore(extra,end)")
    page.wait_for_function('''([key,old])=>window[key].state().scale < old * .6''', arg=[KEY, original_scale])
    fit_assert(page)
    completed.append('dynamic-content-refit')

    install(page, BASE.replace('<canvas class=', '<div id="inner"><div style="height:900px">Internal scroll region</div></div><canvas class='))
    before = page.evaluate('[inner.scrollHeight,inner.clientHeight]')
    update(page, 'page'); fit_assert(page)
    assert page.evaluate('[inner.scrollHeight,inner.clientHeight]') == before
    page.evaluate('inner.scrollTop=100')
    actual_scroll = page.evaluate('inner.scrollTop')
    assert abs(actual_scroll - 100) <= 1 / page.evaluate('window.__viewer_test.state().scale') + .5, actual_scroll
    completed.append('nested-scroll-preserved')

    install(page, BASE.replace('<canvas class=', '<iframe id="embedded" srcdoc="<input id=child value=initial><script>window.identity={}</script>"></iframe><canvas class='))
    page.frame_locator('#embedded').locator('#child').fill('iframe draft')
    page.evaluate('embedded.contentWindow.saved=embedded.contentWindow.identity')
    for mode in ['page', 'width', 'page']:
        update(page, mode)
    assert page.frame_locator('#embedded').locator('#child').input_value() == 'iframe draft'
    assert page.evaluate('embedded.contentWindow.identity===embedded.contentWindow.saved')
    completed.append('iframe-not-reparented-or-reloaded')

    install(page)
    assert page.evaluate('''() => {
        let canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;canvas.style.height='80px';
        end.parentNode.insertBefore(canvas,end);window.glCanvas=canvas;
        let gl=canvas.getContext('webgl',{preserveDrawingBuffer:true});if(!gl)return false;
        window.gl=gl;window.savedTexture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,savedTexture);
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([255,0,0,255]));return gl.isTexture(savedTexture);
    }'''), 'A WebGL renderer is required for this check'
    for mode, scale in [('page',1),('custom',1.5),('width',1)]:
        update(page,mode,scale)
        assert page.evaluate('!gl.isContextLost()&&glCanvas.getContext("webgl")===gl&&gl.isTexture(savedTexture)&&gl.getParameter(gl.TEXTURE_BINDING_2D)===savedTexture')
    completed.append('webgl-context-and-texture-retained')

    install(page, BASE.replace('<body>', '<body style="margin:8px;padding:12px;border:3px solid gray;box-sizing:content-box;zoom:1.2">'))
    update(page, 'page'); fit_assert(page)
    page.evaluate('(key)=>window[key].destroy()', KEY)
    assert page.evaluate("document.body.style.zoom==='1.2'&&document.body.style.marginLeft==='8px'")
    completed.append('author-box-model-and-cleanup')

    install(page)
    page.evaluate("note.value='rotation state';window.savedCanvas=drawing")
    update(page, 'page')
    initial = page.viewport_size
    page.set_viewport_size({'width': initial['height'], 'height': initial['width']})
    update(page, 'page'); fit_assert(page)
    assert page.evaluate("note.value==='rotation state'&&drawing===savedCanvas")
    page.set_viewport_size(initial)
    completed.append('orientation-refit-retains-state')
    return completed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, default=ROOT / 'build/card-viewer-build186/browser')
    parser.add_argument('--browser-executable', default=None)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    results = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=args.browser_executable, args=['--enable-unsafe-swiftshader'])
        try:
            for name, width, height in [('phone',390,744),('short-landscape',844,286),('tablet',1280,696),('narrow',320,608)]:
                page = browser.new_page(viewport={'width':width,'height':height}, device_scale_factor=2, is_mobile=True)
                try:
                    passed = run(page,args.output,name)
                    results.append({'profile':name,'viewport':[width,height],'passed':passed})
                    print(f'{name}: {len(passed)} passed',flush=True)
                finally:
                    page.close()
        finally:
            browser.close()
    (args.output / 'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
    print('Total:',sum(len(row['passed']) for row in results))


if __name__ == '__main__':
    main()

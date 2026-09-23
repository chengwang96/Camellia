"""Capacity probe UI against the main-process harness and a local mock provider."""
import json
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
requests = []


class Provider(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        requests.append(body)
        result = {'choices': [{'message': {'content': 'CAP_START_73Q CAP_MIDDLE_92R CAP_END_46S'}}],
                  'usage': {'prompt_tokens': 9999, 'completion_tokens': 20}}
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(result).encode())

    def log_message(self, *args):
        pass


server = HTTPServer(('127.0.0.1', 0), Provider)
threading.Thread(target=server.serve_forever, daemon=True).start()
driver = subprocess.Popen(['node', str(repo / 'tests/claude-ui-driver.cjs')], stdin=subprocess.PIPE,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')


def rpc(method, payload=None):
    driver.stdin.write(json.dumps({'method': method, 'payload': payload}) + '\n')
    driver.stdin.flush()
    line = driver.stdout.readline()
    if not line:
        raise RuntimeError(driver.stderr.read())
    result = json.loads(line)
    if 'error' in result:
        raise RuntimeError(result['error'])
    return result


bridge = r"""(() => {
  const listeners = {};
  const channels = {'dsh:api-router-state':'onApiRouterState','dsh:provider-insights':'onProviderInsights','dsh:context-capacity':'onContextCapacity'};
  window.testCall=async(method,payload)=>{
    const reply=await window.testRpc(method,payload);
    for(const event of reply.events||[]) listeners[channels[event.channel]]?.(event.data);
    if(method==='contextCapacity') listeners.onContextCapacity?.(reply.result);
    return reply.result;
  };
  window.dshDesktop=new Proxy({},{get:(_,method)=>method.startsWith('on') ? callback=>{listeners[method]=callback;return ()=>{};} : payload=>window.testCall(method,payload)});
})();"""

try:
    configured = rpc('apiRouterSaveConfig', {'enabled': True, 'port': rpc('freePort')['result'], 'providers': [{
        'id': 'local', 'type': 'custom', 'name': 'Local capacity test', 'enabled': True, 'protocol': 'openai',
        'baseUrl': f'http://127.0.0.1:{server.server_port}/v1',
        'keys': [{'id': 'key', 'name': 'Test account', 'key': 'test-secret', 'enabled': True}],
        'models': [{'id': 'test-model', 'upstream': 'test-upstream', 'protocol': 'auto', 'maxContext': 131072}]
    }]})['result']
    assert configured['ok'], configured
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1100, 'height': 1000})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.expose_function('testRpc', rpc)
        page.add_init_script(bridge)
        page.goto((repo / 'src/renderer/settings/api-settings.html').as_uri() + '?page=providers')
        page.wait_for_load_state('networkidle')
        # A provider card renders two select buttons (title and footer).
        page.locator('[data-select="local"]').first.click()
        page.locator('#contextCapacityPanel summary').click()
        expect(page.locator('#contextCapacityResults')).to_contain_text('131,072')
        assert requests == []
        page.locator('#contextCapacityStart').click()
        expect(page.locator('#contextProbeSubmit')).to_be_disabled()
        expect(page.locator('#contextProbeTarget')).to_contain_text('test-model')
        page.locator('#contextProbeMax').select_option('8192')
        page.locator('#contextProbeRequests').fill('1')
        page.locator('#contextProbeConfirm').check()
        page.locator('#contextProbeSubmit').click()
        expect(page.locator('#contextProbeDialog')).not_to_be_visible()
        for attempt in range(10):
            state = page.evaluate("window.testCall('contextCapacity')")
            if state['active'] is None:
                break
        assert state['active'] is None, state
        expect(page.locator('#contextCapacityResults')).to_contain_text('Input cap reached')
        expect(page.locator('#contextCapacityResults')).to_contain_text('9,999')
        expect(page.locator('#contextCapacityCancel')).not_to_be_visible()
        assert len(requests) == 1 and requests[0]['model'] == 'test-upstream'
        unchanged = page.evaluate("window.testCall('apiRouterGetState')")
        assert 'contextWindow' not in unchanged['providers'][0]['models'][0]
        (repo / '.ci-logs').mkdir(exist_ok=True)
        page.screenshot(path=str(repo / '.ci-logs/context-capacity-ui.png'), full_page=True)
        page.evaluate("window.CamelliaI18n.setLanguage('zh-CN')")
        expect(page.locator('#contextCapacityStart')).to_have_text('检测上下文容量')
        expect(page.locator('#contextCapacityResults')).to_contain_text('已达到输入探测上限')
        page.locator('#contextCapacityStart').click()
        expect(page.locator('#contextProbeSubmit')).to_have_text('开始付费探测')
        expect(page.locator('#contextProbeSubmit')).to_be_disabled()
        page.screenshot(path=str(repo / '.ci-logs/context-capacity-consent-zh.png'), full_page=True)
        assert errors == [], errors
        browser.close()
    print('PASS context capacity UI: explicit consent, pinned route, budget, results, unchanged configuration')
finally:
    driver.terminate()
    driver.wait(timeout=10)
    server.shutdown()
    server.server_close()

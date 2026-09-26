"""Context-window caps: catalog backfill, input clamping, and save-time validation."""
import json, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import subprocess
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]

class Catalog(BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({'data': [{'id': 'kimi-k3', 'context_length': 262144}, {'id': 'model-test'}]}).encode()
        self.send_response(200); self.send_header('content-type', 'application/json'); self.end_headers(); self.wfile.write(body)
    def do_POST(self):
        body = json.dumps({'id': 'x', 'model': 'kimi-k3', 'choices': [{'message': {'role': 'assistant', 'content': 'ok'}, 'finish_reason': 'stop'}], 'usage': {'prompt_tokens': 1, 'completion_tokens': 1}}).encode()
        self.send_response(200); self.send_header('content-type', 'application/json'); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass

srv = HTTPServer(('127.0.0.1', 0), Catalog)
threading.Thread(target=srv.serve_forever, daemon=True).start()
upstream = f'http://127.0.0.1:{srv.server_address[1]}'

driver = subprocess.Popen(['node', str(repo/'tests/claude-ui-driver.cjs')], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
def rpc(method, payload=None):
    driver.stdin.write(json.dumps({'method': method, 'payload': payload})+'\n'); driver.stdin.flush()
    line = driver.stdout.readline()
    if not line: raise RuntimeError(driver.stderr.read())
    r = json.loads(line)
    if 'error' in r: raise RuntimeError(r['error'])
    return r

bridge = r"""(() => {
  let onRouter=()=>{},onInsights=()=>{};
  window.testCall=async(method,payload)=>{
    const r=await window.testRpc(method,payload);
    for(const e of r.events||[]){if(e.channel==='dsh:api-router-state')onRouter(e.data);if(e.channel==='dsh:provider-insights')onInsights(e.data);}
    return r.result;
  };
  window.dshDesktop=new Proxy({},{get:(_,m)=>m.startsWith('on')&&!['onApiRouterState','onProviderInsights'].includes(m)?()=>()=>{}:m==='onApiRouterState'?f=>onRouter=f:m==='onProviderInsights'?f=>onInsights=f:p=>window.testCall(m,p)});
})();"""
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1100, 'height': 900})
        errors = []; page.on('pageerror', lambda e: errors.append(str(e)))
        page.expose_function('testRpc', rpc); page.add_init_script(bridge)
        page.goto((repo/'src/renderer/settings/api-settings.html').as_uri() + '?page=providers'); page.wait_for_load_state('networkidle')
        expect(page.locator('#port')).to_be_visible()
        page.locator('#port').fill(str(rpc('freePort')['result']))
        page.locator('#addProvider').click()
        page.locator('#preset').select_option('ollama'); page.locator('#confirmAdd').click()
        page.locator('#connectionAdvanced > summary').click()
        page.locator('#pUrl').fill(upstream + '/v1')
        page.get_by_role('textbox', name='API Key 1', exact=True).fill('test-key')
        # The ollama preset ships default models; row 0 is kimi-k3 with no known limit yet.
        page.locator('#modelAdvanced > summary').click()
        ctx = page.locator('input[data-model="0"][data-field="contextWindow"]')
        assert ctx.get_attribute('placeholder') == 'Auto', ctx.get_attribute('placeholder')
        assert ctx.get_attribute('max') == '2000000'
        # Fetching the catalog proactively backfills the model's context limit.
        page.locator('#discoverModels').click()
        expect(page.locator('#status')).to_contain_text('Context limits updated for 1 of your models')
        expect(page.locator('#catalogList')).to_contain_text('256K ctx')
        page.locator('#modelDialog .dialog-head button').click()
        assert ctx.get_attribute('placeholder') == '≤ 262144', ctx.get_attribute('placeholder')
        assert ctx.get_attribute('max') == '262144', ctx.get_attribute('max')
        # A value beyond the model maximum is clamped with a visible warning.
        ctx.fill('999999'); ctx.press('Tab')
        expect(ctx).to_have_value('262144')
        expect(page.locator('#status')).to_contain_text("Context window capped at the model's maximum (262144)")
        # A valid value is kept and saved together with the fetched cap.
        ctx.fill('131072'); ctx.press('Tab')
        expect(ctx).to_have_value('131072')
        page.locator('#save').click()
        expect(page.locator('#status')).to_contain_text('Saved')
        models = rpc('apiRouterGetState')['result']['providers'][0]['models']
        assert models[0]['maxContext'] == 262144 and models[0]['contextWindow'] == 131072, models
        # Save-time validation still rejects anything above the cap.
        state = rpc('apiRouterGetState')['result']
        state['providers'][0]['models'][0]['contextWindow'] = 999999
        rejected = page.evaluate("s => window.testCall('apiRouterSaveConfig', s)", state)
        assert rejected['ok'] is False and "Context window exceeds the model's maximum (262144)" in rejected['error'], rejected
        assert errors == [], errors
        browser.close()
    print('PASS context window: catalog backfill, catalog hint, clamp, save, save-time rejection')
finally:
    driver.terminate()

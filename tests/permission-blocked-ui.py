from pathlib import Path
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[1]
source = (root / 'src/renderer/chat/claude.js').read_text(encoding='utf-8')
start = source.index("    if (ev.type === 'gui:tool') {")
end = source.index("    if (ev.type === 'gui:plan')", start)
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page()
    html = (root / 'src/renderer/chat/claude.html').read_text(encoding='utf-8')
    dialog_start = html.index('<dialog id="permissionBlockedDialog"')
    dialog_end = html.index('</dialog>', dialog_start) + len('</dialog>')
    page.set_content(html[dialog_start:dialog_end])
    page.evaluate('''body => {
      const seenPermissionBlocks = new Set(), pendingTools = {};
      const $ = id => document.getElementById(id);
      const makeToolCard = () => ({ setInput() {}, setOutput() {} });
      const running = false, was = false, maybeScroll = () => {};
      window.receiveTool = eval('(ev) => {' + body + '}');
    }''', source[start:end])
    event = {'type': 'gui:tool', 'id': 'denial-1', 'runId': 1, 'permissionBlocked': True,
             'status': 'failed', 'output': '<img src=x onerror=alert(1)> denied by native CLI'}
    page.evaluate('event => receiveTool(event)', event)
    expect(page.locator('#permissionBlockedDialog')).to_be_visible()
    expect(page.locator('#permissionBlockedDetail')).to_have_text(event['output'])
    expect(page.locator('#permissionBlockedDetail img')).to_have_count(0)
    expect(page.get_by_role('button')).to_have_count(1)
    page.get_by_role('button', name='Close').click()
    page.evaluate('event => receiveTool(event)', event)
    expect(page.locator('#permissionBlockedDialog')).not_to_be_visible()
    page.evaluate('event => receiveTool(event)', {**event, 'runId': 2})
    expect(page.locator('#permissionBlockedDialog')).to_be_visible()
    page.get_by_role('button', name='Close').click()
    page.evaluate('event => receiveTool(event)', {**event, 'id': 'ordinary-error', 'permissionBlocked': False})
    expect(page.locator('#permissionBlockedDialog')).not_to_be_visible()
    browser.close()
    print('PASS: blocked action notice, safe text, dismissal, replay deduplication and ordinary errors')

"""Render the DOM captured from the real Electron/Kimi integration test."""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[1]
shots = root / 'dist/ui-preview'
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    for name, scheme in [('kimi-permission', 'light'), ('kimi-chat', 'light'), ('kimi-chat', 'dark')]:
        page = browser.new_page(viewport={'width': 1280, 'height': 850}, color_scheme=scheme)
        page.goto((shots / (name + '.html')).as_uri())
        page.wait_for_load_state('networkidle')
        expect(page.locator('.logo-text')).to_have_text('Kimi Code')
        expect(page.locator('.ws-name')).to_have_text('示例工作区')
        if name == 'kimi-chat':
            expect(page.locator('.run-result.ok')).to_be_visible()
            expect(page.locator('.tool-card')).to_have_count(1)
            expect(page.locator('.tool-state.done')).to_have_count(1)
        else:
            expect(page.locator('#permOptions .perm-allow').first).to_be_visible()
            expect(page.locator('#permDefaultActions')).to_be_hidden()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.screenshot(path=str(shots / f'{name}-{scheme}.png'), animations='disabled')
        page.set_viewport_size({'width': 900, 'height': 720})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.close()
    browser.close()
print('PASS: real Kimi DOM snapshots, light/dark layout, completed tool, permission options, no horizontal overflow')

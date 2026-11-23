"""DeepSeek and Kimi layout rules align with the Agent content column."""
import json
import subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
providers = json.loads(subprocess.check_output([
    'node', '-e',
    "const p=require('./src/shared/web-providers').PROVIDERS;"
    "process.stdout.write(JSON.stringify({deepseek:p.deepseek.layout.css,kimi:p.kimi.layout.css}));",
], cwd=repo, text=True, encoding='utf-8'))

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)

    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    page.set_content("""
      <div class="_9a2f8e4" id="dsComposer"><div class="_77cefa5" id="dsInput"></div></div>
    """)
    page.add_style_tag(content=providers['deepseek'])
    assert page.evaluate("getComputedStyle(document.querySelector('#dsComposer')).maxWidth") == '816px'
    assert page.evaluate("document.querySelector('#dsComposer').getBoundingClientRect().width") == 816
    page.evaluate("document.documentElement.style.setProperty('--camellia-chat-content-width', '900px')")
    assert page.evaluate("getComputedStyle(document.querySelector('#dsComposer')).maxWidth") == '948px'
    assert page.evaluate("getComputedStyle(document.querySelector('#dsComposer')).paddingInline").startswith('24px')
    assert page.evaluate("getComputedStyle(document.querySelector('#dsComposer')).boxSizing") == 'border-box'
    assert page.evaluate("getComputedStyle(document.querySelector('#dsInput')).borderRadius") == '22px'

    for empty_header in (True, False):
        page.set_content(f"""
          <style>html, body {{ margin: 0; }}</style>
          <div class="app has-sidebar"><div class="main">
            <div class="layout-container"><div class="layout-content" style="height:600px">
              <div class="layout-header">
                <div class="header-left" id="kimiToggle">toggle</div>
                <div class="header-center"><div class="home-header-center">{'' if empty_header else 'controls'}</div></div>
              </div>
              <div class="layout-content-main">
                <div class="home-top" id="kimiHero"></div>
                <div class="chat-content-list" id="kimiContent"></div>
                <div class="chat-editor-wrap"><div class="chat-editor-content" id="kimiInput"></div></div>
              </div>
            </div></div>
          </div></div>
        """)
        page.add_style_tag(content=providers['kimi'])
        page.evaluate("document.documentElement.style.setProperty('--camellia-chat-content-width', '900px')")
        expect(page.locator('#kimiToggle')).to_be_hidden()
        assert page.evaluate("getComputedStyle(document.querySelector('.main')).margin") == '0px'
        assert page.evaluate("getComputedStyle(document.querySelector('.layout-container')).scrollbarWidth") == 'none'
        if empty_header:
            expect(page.locator('.layout-header')).to_be_hidden()
            assert page.evaluate("getComputedStyle(document.querySelector('.layout-content-main')).height") == '600px'
        else:
            expect(page.locator('.layout-header')).to_be_visible()
        assert page.evaluate("getComputedStyle(document.querySelector('#kimiContent')).maxWidth") == '948px'
        assert page.evaluate("getComputedStyle(document.querySelector('#kimiContent')).paddingLeft") == '24px'
        assert page.evaluate("getComputedStyle(document.querySelector('#kimiContent')).paddingTop") == '24px'
        assert page.evaluate("getComputedStyle(document.querySelector('#kimiContent')).boxSizing") == 'border-box'
        assert page.evaluate("document.querySelector('#kimiContent').getBoundingClientRect().width") == 948
        assert page.evaluate("getComputedStyle(document.querySelector('.chat-editor-wrap')).maxWidth") == '900px'
        assert page.evaluate("document.querySelector('.chat-editor-wrap').getBoundingClientRect().width") == 900
        assert page.evaluate("getComputedStyle(document.querySelector('#kimiHero')).paddingTop") \
            == ('123px' if empty_header else '0px')
        assert page.evaluate("getComputedStyle(document.querySelector('#kimiInput')).minHeight") == '126px'
        assert page.evaluate("getComputedStyle(document.querySelector('#kimiInput')).borderRadius") == '22px'

    page.set_viewport_size({'width': 700, 'height': 663})
    page.evaluate("document.documentElement.style.setProperty('--camellia-chat-content-width', '652px')")
    assert page.evaluate("document.querySelector('.main').getBoundingClientRect().width") == 700
    assert page.evaluate("document.querySelector('.chat-editor-wrap').getBoundingClientRect().width") == 652

    page.emulate_media(color_scheme='dark')
    assert page.evaluate("getComputedStyle(document.body).backgroundColor") == 'rgb(21, 21, 23)'
    assert page.evaluate("getComputedStyle(document.querySelector('.main')).backgroundColor") == 'rgb(21, 21, 23)'
    assert page.evaluate("getComputedStyle(document.querySelector('#kimiInput')).backgroundColor") == 'rgb(44, 44, 46)'
    assert page.evaluate("getComputedStyle(document.querySelector('#kimiInput')).borderColor") == 'rgba(255, 255, 255, 0.12)'
    page.emulate_media(color_scheme='light')
    assert page.evaluate("getComputedStyle(document.body).backgroundColor") == 'rgb(255, 255, 255)'
    assert page.evaluate("getComputedStyle(document.querySelector('#kimiInput')).backgroundColor") == 'rgb(255, 255, 255)'
    assert page.evaluate("getComputedStyle(document.querySelector('#kimiInput')).borderColor") == 'rgba(0, 0, 0, 0.1)'

    browser.close()
print('PASS: DeepSeek and Kimi content columns and composer chrome match the Agent layout')

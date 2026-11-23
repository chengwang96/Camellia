"""Kimi promotional controls are hidden in a real DOM, without fixed counts."""
import json
import subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
config = json.loads(subprocess.check_output([
    'node', '-e',
    "const p=require('./src/shared/web-providers').PROVIDERS.kimi;"
    "const {extractionScript}=require('./src/shared/web-layout-runtime');"
    "process.stdout.write(JSON.stringify({script:extractionScript(p),"
    "forceScript:extractionScript(p,null,{forceSync:true}),"
    "expectedScript:extractionScript(p,null,{expectedSessions:true}),css:p.layout.css}));",
], cwd=repo, text=True, encoding='utf-8'))

fixture = """
<!doctype html><html><head><meta charset="utf-8"></head><body>
  <div class="app has-sidebar">
    <aside class="sidebar-slot">
      <a class="next-sidebar-history-item__link" href="https://www.kimi.com/chat/one">
        <span class="next-sidebar-history-item__title">First conversation</span>
      </a>
      <a class="next-sidebar-history-item__link" href="https://www.kimi.com/chat/two">
        <span class="next-sidebar-history-item__title">Second conversation</span>
      </a>
    </aside>
    <header class="main-header user-nav">
      <div class="sub-item" id="desktopDownload">
        <div class="sub-item-content">
          <span class="kimi-menu-item-text user-nav-label">获取应用程序</span>
        </div>
      </div>
      <button class="kimi-button primary desktop-download-entry" id="downloadDesktop">
        <span class="kimi-menu-item-text">下载桌面端</span>
      </button>
      <button class="user-download-button" id="iconDownload" data-testid="sidebar-get-app"
              aria-label="获取应用程序"><svg width="16" height="16" viewBox="0 0 16 16"></svg></button>
      <div class="sub-item-content" id="accountSettings">账号设置</div>
      <div class="sub-item-content" id="referral">邀请有奖</div>
    </header>
    <section class="membership-upgrade" id="membership">开通会员</section>
    <section class="use-desktop-app-entry" id="legacyDownload">客户端限时优惠</section>
    <main id="chat">
      <div class="chat-editor-content" style="width:300px;height:100px"></div>
      <p>这条对话正文提到下载桌面端，但不应被当作导航推广位隐藏。</p>
    </main>
  </div>
</body></html>
"""

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1200, 'height': 800})
    page.set_content(fixture)
    page.add_style_tag(content=config['css'])
    result = page.evaluate(config['script'])

    assert result['layout']['historyCount'] == 2, result
    assert result['layout']['pageReady'] is True, result
    expect(page.locator('html')).to_have_attribute('data-camellia-web-hide-site-sidebar', '')
    expect(page.locator('html')).to_have_attribute('data-camellia-web-ready', '')
    expect(page.locator('html')).not_to_have_attribute('data-camellia-web-site-sidebar-visible', '')
    expect(page.locator('.sidebar-slot')).to_have_attribute('data-camellia-web-site-sidebar', '')
    expect(page.locator('.sidebar-slot')).to_be_hidden()

    hidden = ['#desktopDownload', '#downloadDesktop', '#iconDownload',
              '#referral', '#membership', '#legacyDownload']
    for selector in hidden:
        expect(page.locator(selector)).to_be_hidden()
        expect(page.locator(selector)).to_have_attribute('data-camellia-web-hidden', '')
    expect(page.locator('#accountSettings')).to_be_visible()
    expect(page.locator('#chat')).to_be_visible()
    expect(page.locator('#chat')).to_contain_text('下载桌面端')
    marked = page.locator('[data-camellia-web-hidden]').count()
    assert result['layout']['hiddenCount'] == marked
    assert marked >= len(hidden), (result, marked)
    visible_exact = lambda text: page.evaluate(
        """(text) => [...document.querySelectorAll('*')].filter(node => node.children.length === 0
          && (node.textContent || '').trim() === text
          && node.getClientRects().length > 0
          && getComputedStyle(node).visibility !== 'hidden').length""", text)
    assert visible_exact('获取应用程序') == 0
    assert visible_exact('下载桌面端') == 0
    assert page.evaluate("""() => [...document.querySelectorAll('[aria-label="获取应用程序"]')]
      .filter(node => node.getClientRects().length > 0
        && getComputedStyle(node).visibility !== 'hidden').length""") == 0

    # Repeated polling must not keep increasing the reported count.
    second = page.evaluate(config['script'])
    assert second['layout']['hiddenCount'] == marked, second
    assert page.locator('[data-camellia-web-hidden]').count() == marked

    # The provider can leave deleted conversations in the DOM but hidden.
    page.evaluate("document.querySelectorAll('.next-sidebar-history-item__link')[1].style.display = 'none'")
    stale = page.evaluate(config['script'])
    assert stale['layout']['historyCount'] == 1, stale
    assert [row['title'] for row in stale['sessions']] == ['First conversation'], stale

    # A conversation switch can replace the provider sidebar markup. The page
    # root state hides the replacement immediately, before extraction runs.
    page.evaluate("""() => {
      const late = document.createElement('aside');
      late.className = 'sidebar-slot';
      late.id = 'lateSidebar';
      late.style.width = '220px';
      late.style.height = '80px';
      late.textContent = 'Replacement navigation';
      document.body.appendChild(late);
    }""")
    expect(page.locator('#lateSidebar')).to_be_hidden()

    # A transient empty extraction keeps the provider sidebar hidden for a
    # short grace period, so SPA navigation cannot reveal it between polls.
    page.evaluate("document.querySelectorAll('.next-sidebar-history-item__link').forEach(node => node.remove())")
    transient = page.evaluate(config['script'])
    assert transient['layout']['historyCount'] == 0, transient
    expect(page.locator('html')).to_have_attribute('data-camellia-web-hide-site-sidebar', '')
    expect(page.locator('#lateSidebar')).to_be_hidden()
    page.evaluate(config['script'])
    page.evaluate(config['script'])
    expect(page.locator('html')).not_to_have_attribute('data-camellia-web-hide-site-sidebar', '')
    expect(page.locator('html')).to_have_attribute('data-camellia-web-site-sidebar-visible', '')
    expect(page.locator('#lateSidebar')).to_be_visible()

    # With cached Camellia history, repeated empty probes must not resurface
    # the provider sidebar and create a second hide cycle.
    page.close()
    page = browser.new_page(viewport={'width': 1200, 'height': 800})
    page.set_content(fixture)
    page.add_style_tag(content=config['css'])
    page.evaluate(config['expectedScript'])
    page.evaluate("document.querySelectorAll('.next-sidebar-history-item__link').forEach(node => node.remove())")
    for _ in range(5):
        page.evaluate(config['expectedScript'])
    expect(page.locator('html')).to_have_attribute('data-camellia-web-hide-site-sidebar', '')
    expect(page.locator('html')).not_to_have_attribute('data-camellia-web-site-sidebar-visible', '')
    expect(page.locator('.sidebar-slot')).to_be_hidden()

    # Explicit refresh uses an authoritative empty result instead of the grace
    # period used during automatic SPA navigation.
    page.close()
    page = browser.new_page(viewport={'width': 1200, 'height': 800})
    page.set_content(fixture)
    page.add_style_tag(content=config['css'])
    page.evaluate(config['script'])
    expect(page.locator('html')).to_have_attribute('data-camellia-web-hide-site-sidebar', '')
    page.evaluate("document.querySelectorAll('.next-sidebar-history-item__link').forEach(node => node.remove())")
    forced = page.evaluate(config['forceScript'])
    assert forced['layout']['historyCount'] == 0, forced
    expect(page.locator('html')).not_to_have_attribute('data-camellia-web-hide-site-sidebar', '')
    expect(page.locator('html')).to_have_attribute('data-camellia-web-site-sidebar-visible', '')
    assert page.evaluate("getComputedStyle(document.querySelector('.sidebar-slot')).display") != 'none'

    browser.close()
print('PASS: Kimi download, membership and referral controls are hidden in a real DOM')

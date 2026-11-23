"""Website session actions use the official menus and confirmation controls."""
import json
import subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
scripts = json.loads(subprocess.check_output([
    'node', '-e',
    "const providers=require('./src/shared/web-providers').PROVIDERS;"
    "const {sessionActionScript}=require('./src/shared/web-layout-runtime');"
    "const build=(provider,action,value='')=>sessionActionScript(providers[provider],"
    "{sessionId:'session-1',action,value});"
    "process.stdout.write(JSON.stringify({"
    "deepseek:{rename:build('deepseek','rename','Renamed by Camellia'),"
    "delete:build('deepseek','delete'),pin:build('deepseek','pin')},"
    "kimi:{share:build('kimi','share'),pin:build('kimi','pin')}"
    "}));",
], cwd=repo, text=True, encoding='utf-8'))

deepseek_fixture = """
<!doctype html><html><body>
  <div id="history">
    <a href="https://chat.deepseek.com/a/chat/s/session-1" id="conversation">
      <span>Original title</span>
      <div role="button" id="more">...</div>
    </a>
  </div>
  <div id="menu" role="menu" hidden>
    <button role="menuitem" data-action="rename">重命名</button>
    <button role="menuitem" data-action="pin">置顶</button>
    <button role="menuitem" data-action="share">分享</button>
    <button role="menuitem" data-action="delete">删除</button>
  </div>
  <div id="renameDialog" role="dialog" hidden>
    <input id="renameInput">
    <button id="saveRename">保存</button>
  </div>
  <div id="deleteDialog" role="dialog" hidden>
    <button id="confirmDelete">删除</button>
  </div>
  <script>
    window.actions = [];
    const menu = document.querySelector('#menu');
    const nameDialog = document.querySelector('#renameDialog');
    const deleteDialog = document.querySelector('#deleteDialog');
    document.querySelector('#more').addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation();
      menu.hidden = false;
    });
    menu.addEventListener('click', event => {
      const button = event.target.closest('[data-action]');
      if (!button) return;
      window.actions.push(button.dataset.action);
      menu.hidden = true;
      if (button.dataset.action === 'rename') {
        nameDialog.hidden = false;
        document.querySelector('#renameInput').focus();
      } else if (button.dataset.action === 'delete') {
        deleteDialog.hidden = false;
      }
    });
    document.querySelector('#saveRename').addEventListener('click', () => {
      window.renamed = document.querySelector('#renameInput').value;
      nameDialog.hidden = true;
    });
    document.querySelector('#confirmDelete').addEventListener('click', () => {
      window.deleted = true;
      deleteDialog.hidden = true;
    });
  </script>
</body></html>
"""

kimi_fixture = """
<!doctype html><html><body>
  <div class="next-sidebar-history-item">
    <a class="next-sidebar-history-item__link" href="https://www.kimi.com/chat/session-1">
      <span class="next-sidebar-history-item__title">Original title</span>
    </a>
    <button class="next-sidebar-history-item__more" id="kimiMore">...</button>
  </div>
  <div id="menu" role="menu" hidden>
    <button role="menuitem" data-action="rename">重命名</button>
    <button role="menuitem" data-action="pin">置顶</button>
    <button role="menuitem" data-action="share">分享</button>
    <button role="menuitem" data-action="delete">删除</button>
  </div>
  <script>
    window.actions = [];
    const menu = document.querySelector('#menu');
    document.querySelector('#kimiMore').addEventListener('click', () => { menu.hidden = false; });
    menu.addEventListener('click', event => {
      const button = event.target.closest('[data-action]');
      if (!button) return;
      window.actions.push(button.dataset.action);
      menu.hidden = true;
    });
  </script>
</body></html>
"""

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)

    page = browser.new_page()
    page.set_content(deepseek_fixture)
    renamed = page.evaluate(scripts['deepseek']['rename'])
    assert renamed == {'ok': True, 'action': 'rename'}, renamed
    assert page.evaluate('window.renamed') == 'Renamed by Camellia'

    page.close()
    page = browser.new_page()
    page.set_content(deepseek_fixture)
    deleted = page.evaluate(scripts['deepseek']['delete'])
    assert deleted == {'ok': True, 'action': 'delete'}, deleted
    assert page.evaluate('window.deleted') is True

    page.close()
    page = browser.new_page()
    page.set_content(deepseek_fixture)
    pinned = page.evaluate(scripts['deepseek']['pin'])
    assert pinned == {'ok': True, 'action': 'pin'}, pinned
    assert page.evaluate('window.actions') == ['pin']

    page.close()
    page = browser.new_page()
    page.set_content(kimi_fixture)
    shared = page.evaluate(scripts['kimi']['share'])
    assert shared == {'ok': True, 'action': 'share'}, shared
    assert page.evaluate('window.actions') == ['share']

    page.close()
    page = browser.new_page()
    page.set_content(deepseek_fixture)
    page.evaluate("window.actions = []; document.querySelector('#more').click()")
    expect(page.locator('#menu')).to_be_visible()
    expect(page.locator('#menu [data-action=rename]')).to_be_visible()
    expect(page.locator('#menu [data-action=pin]')).to_be_visible()
    expect(page.locator('#menu [data-action=share]')).to_be_visible()
    expect(page.locator('#menu [data-action=delete]')).to_be_visible()

    browser.close()
print('PASS: website menus drive rename, pin, share and delete actions')

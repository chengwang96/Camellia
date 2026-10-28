from pathlib import Path
from playwright.sync_api import sync_playwright, expect


root = Path(__file__).resolve().parents[1]
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1180, "height": 820})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    # Main-process history and I/O are covered by archived-settings-electron.cjs.
    # Keep a deletion pending here to exercise actual wheel input and progress
    # updates throughout the renderer's busy state.
    page.add_init_script("""
      let sessions = Array.from({length: 23}, (_, index) => ({
        source: 'shared', origin: 'codex', id: 'archived-' + index,
        title: 'Archived conversation ' + index, archivedAt: Date.now() - index,
      }));
      let onProgress;
      const empty = {ok: true, result: {}, engines: [], providers: [], models: [],
        config: {providers: [], usage: {}, active: {}}, state: {}};
      window.dshDesktop = new Proxy({}, {get: (_target, name) => {
        if (name === 'onArchivedDeleteProgress') return callback => { onProgress = callback; };
        if (String(name).startsWith('on')) return () => () => {};
        if (name === 'workbenchSettings') return async () => ({...empty,
          version: '1.0.1', language: 'zh-CN', theme: 'light', dataPath: '/test-profile'});
        if (name === 'archivedSessionsList') return async () => ({ok: true, sessions});
        if (name === 'archivedSessionAction') return async ({action}) => {
          if (action !== 'delete-all') throw Error('Unexpected action: ' + action);
          return new Promise(resolve => {
            let processed = 0;
            const timer = setInterval(() => onProgress({processed: ++processed, total: 23}), 100);
            window.finishBulkDelete = () => {
              clearInterval(timer); sessions = [];
              resolve({ok: true, deleted: 23});
            };
          });
        };
        return () => Promise.resolve({...empty});
      }});
    """)
    page.goto((root / "src/renderer/settings/api-settings.html").as_uri() + "?page=archived")
    page.wait_for_load_state("networkidle")
    expect(page.locator("#archivedList .archived-row")).to_have_count(23)
    page.locator("#deleteAllArchived").click()
    expect(page.locator("#deleteAllArchivedDialog")).to_be_visible()
    page.evaluate("window.firstArchivedRow = document.querySelector('#archivedList .archived-row')")
    page.locator("#confirmDeleteAllArchived").click()
    expect(page.locator("#deleteAllArchivedDialog")).not_to_be_visible()
    expect(page.locator("#archivedList")).to_have_attribute("aria-busy", "true")
    expect(page.locator("#deleteAllArchived")).to_be_disabled()
    expect(page.locator("#archivedDeleteActivity")).to_be_visible()
    content = page.locator(".scroll-content")
    box = content.bounding_box()
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    page.mouse.wheel(0, 650)
    page.wait_for_function("() => document.querySelector('.scroll-content').scrollTop > 300")
    page.wait_for_function("() => Number(document.querySelector('#archivedDeleteProgress').value) >= 2")
    before = content.evaluate("element => element.scrollTop")
    page.mouse.wheel(0, -300)
    page.wait_for_function("before => document.querySelector('.scroll-content').scrollTop < before - 100", arg=before)
    assert page.evaluate("document.querySelector('#archivedList .archived-row') === firstArchivedRow")
    expect(page.locator("#archivedList .archived-row")).to_have_count(23)
    page.evaluate("finishBulkDelete()")
    expect(page.locator("#archivedList .empty")).to_be_visible()
    expect(page.locator("#archivedDeleteActivity")).to_be_hidden()
    expect(page.locator("#archivedList")).to_have_attribute("aria-busy", "false")
    assert not errors, errors
    browser.close()

print("Archived settings: wheel input works during bulk deletion and progress updates preserve rows")

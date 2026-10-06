from pathlib import Path
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[1]
screenshots = root / "dist" / "qa-data-migration"
screenshots.mkdir(parents=True, exist_ok=True)
bridge = """
window.transferCalls = [];
window.storageCalls = [];
window.previewCategories = {api:{files:3,bytes:1200}, settings:{files:0,bytes:0}};
window.directoryState = {legacy:true,canMigrate:true,source:'C:/Users/Test/AppData/Roaming/dsh-desktop',destination:'C:/Users/Test/AppData/Roaming/camellia'};
const empty = {ok:true,providers:[],config:{providers:[],usage:{},active:{}},models:[],engines:[],state:{}};
window.dshDesktop = new Proxy({}, {get: (_target, name) => {
  if (String(name).startsWith('on')) return () => () => {};
  if (name === 'workbenchSettings') return async () => ({...empty,language:'en',theme:'light',dataPath:window.directoryState.source,version:'1.0.0',dataDirectory:window.directoryState});
  if (name === 'dataExport') return async scope => {
    transferCalls.push({type:'export',scope});
    return {ok:true,files:3,bytes:1200,file:'C:/exports/camellia.zip',scope};
  };
  if (name === 'dataImport') return async (file, scope) => {
    transferCalls.push({type:'import',file,scope});
    if (!scope) return {ok:true,needsSelection:true,file:'C:/exports/camellia.zip',categories:previewCategories};
    return {ok:true,restored:3,bytes:1200,scope};
  };
  if (name === 'dataDirectoryMigrate') return async () => {
    transferCalls.push({type:'directory'});
    return window.directoryResult || {ok:true,restarting:true};
  };
  if (name === 'storageScan') return async () => {
    storageCalls.push({type:'scan'});
    return {ok:true,token:'reviewed-data-scan',candidates:[{path:'conversations/unused.jsonl',category:'Unused conversation files',bytes:1200,count:1}]};
  };
  if (name === 'storageClean') return async token => {
    storageCalls.push({type:'clean',token});
    return {ok:true,files:1,bytes:1200,skipped:0,errors:[]};
  };
  if (name === 'archivedSessionsList') return async () => ({ok:true,sessions:[]});
  return async () => ({...empty});
}});
"""

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1040, "height": 900}, reduced_motion="reduce")
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.add_init_script(bridge)
    settings_url = (root / "src/renderer/settings/api-settings.html").as_uri()
    page.goto(settings_url)
    page.wait_for_load_state("networkidle")
    expect(page.locator("#generalPage")).to_be_visible()
    expect(page.locator("#dataPage")).to_be_hidden()
    expect(page.locator("#dataPath, #exportData, #scanStorage")).to_have_count(3)
    for control in ["#dataPath", "#exportData", "#scanStorage"]:
        expect(page.locator(control)).to_be_hidden()
    page.locator('[data-view="data"]').click()
    expect(page.locator("#pageTitle")).to_have_text("Data & backups")
    expect(page.locator('[data-view="data"]')).to_have_attribute("aria-current", "page")
    expect(page.locator("#generalPage")).to_be_hidden()
    expect(page.locator("#dataPage")).to_be_visible()
    assert page.evaluate("transferCalls.length + storageCalls.length") == 0
    expect(page.locator("#migrateDataDirectory")).to_be_visible()
    expect(page.locator("#dataDirectoryStatus")).to_have_text("Restart to move your data. The old folder is deleted after verification.")
    expect(page.locator("#exportConfig, #importConfig")).to_have_count(0)

    page.locator("#exportData").click()
    expect(page.locator("#dataScopeTitle")).to_have_text("Export data")
    expect(page.locator("#dataScopeAll")).to_be_checked()
    page.locator("#dataScopeAll").uncheck()
    page.locator("#confirmImportData").click()
    expect(page.locator("#importDataError")).to_have_text("Choose at least one category to export")
    assert page.evaluate("transferCalls.length") == 0
    page.locator("#importScopeApi").check()
    assert page.locator("#dataScopeAll").evaluate("input => input.indeterminate")
    page.locator("#confirmImportData").click()
    expect(page.locator("#exportData")).to_be_enabled()
    assert page.evaluate("transferCalls.at(-1).scope") == ["api"]

    page.locator("#exportData").click()
    page.locator("#importScopeSettings").uncheck()
    page.locator("#confirmImportData").click()
    expect(page.locator("#exportData")).to_be_enabled()
    assert page.evaluate("transferCalls.at(-1).scope") == ["api", "conversations"]
    page.locator("#exportData").click()
    page.locator("#confirmImportData").click()
    expect(page.locator("#exportData")).to_be_enabled()
    assert page.evaluate("transferCalls.at(-1).scope") == ["api", "settings", "conversations"]

    for cancel in ["close", "escape"]:
        previous = page.evaluate("transferCalls.length")
        page.locator("#exportData").click()
        if cancel == "close":
            page.locator("#importDataDialog .dialog-head button").click()
        else:
            page.keyboard.press("Escape")
        expect(page.locator("#exportData")).to_be_enabled()
        assert page.evaluate("transferCalls.length") == previous

    page.locator("#importData").click()
    expect(page.locator("#dataScopeTitle")).to_have_text("Import data")
    expect(page.locator("#importScopeApi")).to_be_checked()
    for category in ["Settings", "Conversations"]:
        expect(page.locator("#importScope" + category)).to_be_disabled()
        expect(page.locator("#importScope" + category)).not_to_be_checked()
    expect(page.locator("#importScopeSettingsHint")).to_have_text("None in this package")
    page.locator("#dataScopeAll").uncheck()
    page.locator("#dataScopeAll").check()
    expect(page.locator("#importScopeSettings")).not_to_be_checked()
    page.locator("#confirmImportData").click()
    expect(page.locator("#importData")).to_be_enabled()
    assert page.evaluate("transferCalls.at(-1)") == {"type": "import", "file": "C:/exports/camellia.zip", "scope": ["api"]}

    page.evaluate("previewCategories = {settings:{files:5,bytes:2048},conversations:{files:10,bytes:5120}}")
    page.locator("#importData").click()
    expect(page.locator("#importScopeApi")).to_be_disabled()
    page.locator("#importScopeSettings").uncheck()
    page.locator("#confirmImportData").click()
    expect(page.locator("#importData")).to_be_enabled()
    assert page.evaluate("transferCalls.at(-1).scope") == ["conversations"]

    for language in ["en", "zh-CN"]:
        page.evaluate("language => CamelliaI18n.setLanguage(language)", language)
        expect(page.locator("#pageTitle")).to_have_text("Data & backups" if language == "en" else "数据与备份")
        expect(page.locator('[data-view="data"]')).to_have_attribute("title", "Data & backups" if language == "en" else "数据与备份")
        expect(page.locator("#dataDirectoryStatus")).to_have_text(
            "Restart to move your data. The old folder is deleted after verification." if language == "en" else "重启后迁移数据，校验成功后删除旧目录。"
        )
        for width in [1040, 760, 390, 320]:
            page.set_viewport_size({"width": width, "height": 900})
            expect(page.locator("#dataPage #dataPath")).to_have_text("C:/Users/Test/AppData/Roaming/dsh-desktop")
            for row in page.locator("#dataPage .app-update").all():
                row_box = row.bounding_box()
                for button in row.locator("button:visible").all():
                    bounds = button.bounding_box()
                    assert bounds["x"] >= row_box["x"] and bounds["x"] + bounds["width"] <= row_box["x"] + row_box["width"] + 1, (language, width, bounds)
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), (language, width)
            page.locator("#dataPath").scroll_into_view_if_needed()
            page.screenshot(path=str(screenshots / f"data-{language}-{width}.png"))
            page.locator("#importData").click()
            expect(page.locator("#importDataDialog")).to_be_visible()
            layout = page.locator("#importDataDialog").evaluate("""dialog => ({
                fits: dialog.scrollWidth <= dialog.clientWidth,
                left: dialog.getBoundingClientRect().left,
                right: dialog.getBoundingClientRect().right,
                bottom: dialog.getBoundingClientRect().bottom
            })""")
            assert layout["fits"] and layout["left"] >= 0 and layout["right"] <= width and layout["bottom"] <= 900, layout
            page.screenshot(path=str(screenshots / f"import-{language}-{width}.png"))
            page.locator("#importDataDialog .dialog-head button").click()
            expect(page.locator("#importData")).to_be_enabled()
        page.locator("#exportData").click()
        expect(page.locator("#dataScopeTitle")).to_have_text("Export data" if language == "en" else "导出数据")
        expect(page.locator("#confirmImportData")).to_have_text("Export selected data" if language == "en" else "导出所选内容")
        page.locator("#importDataDialog .dialog-head button").click()
        expect(page.locator("#exportData")).to_be_enabled()

    page.evaluate("CamelliaI18n.setLanguage('en')")
    page.set_viewport_size({"width": 1040, "height": 900})
    page.locator('[data-view="archived"]').click()
    expect(page.locator("#archivedPage")).to_be_visible()
    expect(page.locator("#storageSection")).to_be_hidden()
    page.evaluate("navigateSettings({page:'storage'})")
    expect(page.locator("#dataPage")).to_be_visible()
    expect(page.locator("#archivedPage")).to_be_hidden()
    expect(page.locator("#cleanStorage")).to_be_disabled()
    assert page.evaluate("storageCalls.length") == 0
    page.locator("#scanStorage").click()
    expect(page.locator("#cleanStorage")).to_be_enabled()
    page.locator("#storageDetails summary").click()
    expect(page.locator("#storageFiles")).to_contain_text("conversations/unused.jsonl")
    page.locator("#cleanStorage").click()
    expect(page.locator("#cleanStorageDialog")).to_be_visible()
    page.keyboard.press("Escape")
    assert page.evaluate("storageCalls") == [{"type": "scan"}]
    page.locator("#cleanStorage").click()
    page.locator("#confirmCleanStorage").click()
    expect(page.locator("#storageStatus")).to_contain_text("Removed 1 files")
    assert page.evaluate("storageCalls.at(-1)") == {"type": "clean", "token": "reviewed-data-scan"}
    page.evaluate("navigateSettings({page:'general',focus:'exportData'})")
    expect(page.locator("#dataPage")).to_be_visible()

    page.evaluate("CamelliaI18n.setLanguage('en'); directoryResult = {ok:false,error:'Stop the current response or goal before moving your data'}")
    page.locator("#migrateDataDirectory").click()
    expect(page.locator("#dataDirectoryStatus")).to_have_text("Stop the current response or goal before moving your data")
    expect(page.locator("#migrateDataDirectory")).to_be_enabled()
    page.evaluate("directoryResult = {ok:true,restarting:true}")
    page.locator("#migrateDataDirectory").click()
    expect(page.locator("#dataDirectoryStatus")).to_have_text("Restarting to move your data…")
    expect(page.locator("#exportData")).to_be_disabled()
    expect(page.locator("#migrateDataDirectory")).to_be_disabled()

    page.reload(wait_until="networkidle")
    page.locator('[data-view="data"]').click()
    page.evaluate("renderDataDirectory({legacy:false,canMigrate:false})")
    expect(page.locator("#migrateDataDirectory")).to_be_hidden()
    expect(page.locator("#dataDirectoryStatus")).to_be_hidden()
    page.evaluate("CamelliaI18n.setLanguage('zh-CN'); renderDataDirectory({legacy:false,canMigrate:false,migrationError:'Data was moved and verified, but the old folder could not be completely removed'})")
    expect(page.locator("#migrateDataDirectory")).to_be_hidden()
    expect(page.locator("#dataDirectoryStatus")).to_have_text("数据已迁移并校验成功，但旧目录未能完全删除")
    page.evaluate("CamelliaI18n.setLanguage('en')")
    page.evaluate("renderDataDirectory({legacy:true,canMigrate:false,error:'The Camellia data directory already contains files; nothing was overwritten'})")
    expect(page.locator("#migrateDataDirectory")).to_be_disabled()
    expect(page.locator("#dataDirectoryStatus")).to_contain_text("nothing was overwritten")
    for query in ["?page=data", "?page=storage", "?page=general&focus=exportData"]:
        page.goto(settings_url + query)
        page.wait_for_load_state("networkidle")
        expect(page.locator("#dataPage")).to_be_visible()
        expect(page.locator("#generalPage")).to_be_hidden()
        expect(page.locator("#pageTitle")).to_have_text("Data & backups")
        assert page.evaluate("transferCalls.length + storageCalls.length") == 0
    for height in [820, 580, 480]:
        page.set_viewport_size({"width": 390, "height": height})
        page.locator('[data-view="devices"]').click()
        expect(page.locator("#devicesPage")).to_be_visible()
        bounds = page.locator('[data-view="devices"]').bounding_box()
        assert bounds["y"] >= 0 and bounds["y"] + bounds["height"] <= height, bounds
        assert page.evaluate("document.documentElement.scrollHeight <= innerHeight"), height
        page.locator('[data-view="data"]').click()
        expect(page.locator("#dataPage")).to_be_visible()
    assert errors == [], errors
    browser.close()
    print("PASS: data page navigation, manual cleanup, migration categories, cancellation, directory states and bilingual responsive layout")

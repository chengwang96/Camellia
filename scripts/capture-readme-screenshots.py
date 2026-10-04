"""Capture README examples from the current renderer without user data or API calls.

Requires Playwright for Python and an installed Chromium browser. The chat uses
the same local fixture as tests/shared-chat-ui.py; neither view starts an engine.
"""

import ast
import json
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
IMAGES = ROOT / "docs" / "images"
IMAGES.mkdir(parents=True, exist_ok=True)


def shared_chat_bridge():
    source = (ROOT / "tests" / "shared-chat-ui.py").read_text(encoding="utf-8")
    module = ast.parse(source)
    namespace = {"json": json}
    for name in ("fixture", "bridge"):
        assignment = next(
            node for node in module.body
            if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == name for target in node.targets)
        )
        statement = ast.Module(body=[assignment], type_ignores=[])
        exec(compile(statement, "shared-chat-ui.py", "exec"), namespace)
    bridge = namespace["bridge"]
    bridge = bridge.replace("fixture-model", "Demo model")
    bridge = bridge.replace(
        "if(action==='goal-get')",
        "if(action==='task-list') return {ok:true,tasks:[]};\n"
        "      if(action==='goal-get')",
    )
    bridge = bridge.replace("Compare the experiment results", "Review a sample project")
    bridge = bridge.replace(
        "Check the experiment and record the next steps.",
        "Outline the remaining checks for the parser refactor.",
    )
    bridge = bridge.replace(
        "## Experiment review\\n\\nThe results are ready. Next, validate the data and compare the two implementations.",
        "## Refactor checklist\\n\\nThe parser change needs a focused check.\\n\\n"
        "- Run the existing unit tests.\\n"
        "- Add one malformed-input case.\\n"
        "- Compare the generated output with the fixture.",
    )
    return bridge


HOME_BRIDGE = """(() => {
  const engines = ['claude', 'codex', 'dsh', 'kimi', 'antigravity', 'pi'];
  window.dshDesktop = {
    onLanguageChanged: () => () => {},
    onRuntimeState: () => {},
    onNetworkHealth: () => {},
    runtimeState: async () => ({ok: true, engines: engines.map(id => ({id, status:'ready', name:id}))}),
    runtimeCheckUpdates: async () => ({ok: true, engines: []}),
    listCliServers: async () => ({ok: true, language:'en', devices: []}),
    switchMode: async () => ({ok: true}),
    openSettingsWindow: async () => ({ok: true}),
    openCliDevices: async () => ({ok: true})
  };
})();"""


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        chat = browser.new_page(viewport={"width": 1320, "height": 760}, device_scale_factor=1)
        chat_errors = []
        chat.on("pageerror", lambda error: chat_errors.append(str(error)))
        chat.add_init_script(shared_chat_bridge())
        chat.goto((ROOT / "src" / "renderer" / "chat" / "claude.html").as_uri() + "?harness=claude", wait_until="networkidle")
        chat.wait_for_timeout(1500)
        chat.locator('[data-sid="shared-fixture"]').click()
        chat.get_by_text("Refactor checklist").wait_for()
        assert not chat_errors, f"Chat renderer errors: {chat_errors}"
        status = chat.locator("#statusLine").inner_text().strip()
        assert "Cannot" not in status and "Could not" not in status, status
        chat.screenshot(path=str(IMAGES / "shared-conversation.png"), animations="disabled")
        browser.close()

        browser = playwright.chromium.launch(headless=True)
        home = browser.new_page(viewport={"width": 1320, "height": 1050}, device_scale_factor=1)
        home.add_init_script(HOME_BRIDGE)
        home.goto((ROOT / "src" / "renderer" / "home" / "home.html").as_uri(), wait_until="networkidle")
        home.wait_for_function("document.querySelector('#openDiscussions')?.offsetHeight > 0")
        assert home.locator("#homeStatus").inner_text().strip() == ""
        home.locator(".home-panel").screenshot(path=str(IMAGES / "home.png"), animations="disabled")
        browser.close()


if __name__ == "__main__":
    main()

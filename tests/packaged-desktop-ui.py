"""Accept a built desktop application through its normal entry and real UI.

No source driver, patched Electron APIs, injected IPC handlers or paid APIs.
Only the upstream model response is a loopback fixture; Grok Build is downloaded and
run by the application's own bundled installer and runtime.
"""
import argparse
import hashlib
import json
import os
import re
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

MODEL = "package-acceptance-model"
PROMPT = "Verify the packaged desktop installation."
REPLY = "Package GUI verified. 安装版消息正常。"
OLD_TITLE = "Upgrade history 中文"
OLD_MESSAGE = "Preserve this conversation across an application upgrade."
REPO = Path(__file__).resolve().parents[1]
HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def free_port():
    with socket.socket() as connection:
        connection.bind(("127.0.0.1", 0))
        return connection.getsockname()[1]


def sha256(file):
    with file.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def ipc(page, method):
    return page.evaluate("""async method => {
        let timer;
        try {
            return await Promise.race([
                window.dshDesktop[method](),
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error('IPC timed out: ' + method)), 15000);
                }),
            ]);
        } finally { clearTimeout(timer); }
    }""", method)


def wait_value(page, method, matches, timeout=30, report=None):
    # wait_for_function polls synchronous predicates. A Promise is truthy even
    # when its eventual IPC result is false, so await IPC before testing it.
    deadline = time.monotonic() + timeout
    last = None
    next_report = 0
    while time.monotonic() < deadline:
        last = ipc(page, method)
        if report and time.monotonic() >= next_report:
            report(last)
            next_report = time.monotonic() + 15
        if matches(last):
            return last
        page.wait_for_timeout(150)
    raise AssertionError(f"Timed out waiting for {method}: {last}")


def isolated_environment(root):
    # Do not inherit provider keys, user CLI paths, npm config or the host's
    # ELECTRON_RUN_AS_NODE. Even the working directory is outside the checkout.
    keep = {"SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "PROGRAMFILES",
            "PROGRAMFILES(X86)", "PROGRAMDATA", "DISPLAY", "XAUTHORITY"}
    environment = {key: value for key, value in os.environ.items() if key.upper() in keep}
    home = root / "Home 中文"
    for folder in [home, root / "Temp", home / "AppData/Roaming", home / "AppData/Local"]:
        folder.mkdir(parents=True, exist_ok=True)
    if sys.platform == "win32":
        windows = Path(environment["SYSTEMROOT"])
        environment["PATH"] = os.pathsep.join(map(str, [windows / "System32", windows]))
        environment["HOMEDRIVE"] = home.drive
        environment["HOMEPATH"] = str(home)[len(home.drive):]
    else:
        environment["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin"
    environment.update({
        "HOME": str(home), "USERPROFILE": str(home),
        "APPDATA": str(home / "AppData/Roaming"), "LOCALAPPDATA": str(home / "AppData/Local"),
        "XDG_CONFIG_HOME": str(home / ".config"),
        "DSH_HOME": str(home / ".dsh"), "CLAUDE_CONFIG_DIR": str(home / ".claude"),
        "CODEX_HOME": str(home / ".codex"), "KIMI_CODE_HOME": str(home / ".kimi-code"),
        "TEMP": str(root / "Temp"), "TMP": str(root / "Temp"), "TMPDIR": str(root / "Temp"),
    })
    return environment


class ModelFixture:
    def __init__(self, file):
        owner = self
        self.requests = []
        text = REPLY + "\n\nInline $E=mc^2$.\n\n[Open acceptance file](<" + file.as_posix() + ">)"

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def reply(self, status, body):
                value = json.dumps(body, ensure_ascii=False).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(value)))
                self.end_headers()
                self.wfile.write(value)

            def do_GET(self):
                self.reply(200, {"object": "list", "data": [{"id": MODEL, "object": "model"}]})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                owner.requests.append({
                    "path": self.path, "model": body.get("model"), "stream": body.get("stream"),
                    "hasPrompt": PROMPT in json.dumps(body.get("messages", []), ensure_ascii=False),
                })
                if self.path != "/v1/chat/completions":
                    self.reply(404, {"error": "Unexpected model fixture path"})
                    return
                if self.headers.get("Authorization") != "Bearer local-package-key":
                    self.reply(401, {"error": "Expected the isolated fixture key"})
                    return
                if not body.get("stream"):
                    self.reply(200, {"id": "package-fixture", "object": "chat.completion", "model": MODEL,
                                     "choices": [{"index": 0, "message": {"role": "assistant", "content": text},
                                                  "finish_reason": "stop"}],
                                     "usage": {"prompt_tokens": 20, "completion_tokens": 30}})
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Connection", "close")
                self.end_headers()
                events = [{"choices": [{"index": 0, "delta": {"role": "assistant"}}]}]
                events += [{"choices": [{"index": 0, "delta": {"content": part}}]}
                           for part in [text[:25], text[25:55], text[55:]]]
                events += [{"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
                           {"choices": [], "usage": {"prompt_tokens": 20, "completion_tokens": 30}}, "[DONE]"]
                try:
                    for event in events:
                        value = event if isinstance(event, str) else json.dumps(
                            {"id": "package-fixture", "model": MODEL, **event}, ensure_ascii=False)
                        self.wfile.write(("data: " + value + "\n\n").encode("utf-8"))
                        self.wfile.flush()
                        time.sleep(.04)
                except (BrokenPipeError, ConnectionResetError):
                    pass
                self.close_connection = True

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}/v1"

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


class Application:
    def __init__(self, playwright, executable, resources, root, output, label, shortcut=None):
        self.root, self.output, self.label = root, output, label
        self.executable, self.resources = executable, resources
        self.profile = root / "App Data 中文"
        self.profile.mkdir(exist_ok=True)
        self.errors, self.failed_resources = [], []
        self.environment = isolated_environment(root)
        self.port = free_port()
        self.arguments = [f"--user-data-dir={self.profile}", f"--remote-debugging-port={self.port}",
                          "--remote-debugging-address=127.0.0.1", "--disable-gpu",
                          "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
                          "--disable-backgrounding-occluded-windows"]
        self.log = (output / f"{label}-process.log").open("w", encoding="utf-8")
        self.browser = None
        self.app_pid = None
        self.process = None
        self.shortcut = shortcut
        try:
            self.launch()
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                if self.process.poll() is not None:
                    raise AssertionError(f"Application exited during startup ({self.process.returncode})")
                try:
                    with HTTP.open(f"http://127.0.0.1:{self.port}/json/version", timeout=.5):
                        break
                except OSError:
                    time.sleep(.15)
            else:
                raise AssertionError("Packaged application did not expose its debugging endpoint")
            self.browser = playwright.chromium.connect_over_cdp(
                f"http://127.0.0.1:{self.port}", timeout=30000)
            self.context = self.browser.contexts[0]
            self.context.set_default_timeout(30000)
            self.context.tracing.start(screenshots=True, snapshots=True)
            self.context.on("page", self.observe)
            for page in self.context.pages:
                self.observe(page)
            self.home = self.wait_page("home/home.html")
            assert self.home.evaluate("typeof window.dshDesktop?.workbenchSettings === 'function'")
            state = ipc(self.home, "workbenchSettings")
            assert Path(state["dataPath"]).resolve() == self.profile.resolve(), state
            settings = ipc(self.home, "getSettings")
            expected_node = resources / "runtime" / ("node.exe" if sys.platform == "win32" else "node")
            detected_node = settings["detected"].get("nodeExe")
            assert detected_node and Path(detected_node).resolve() == expected_node.resolve(), (
                f"Bundled Node must be selected: expected {expected_node}; detected {detected_node}")
            self.evidence = {"executable": str(executable), "arguments": self.arguments,
                             "shortcut": str(shortcut) if shortcut else None,
                             "homeURL": self.home.url, "profile": state["dataPath"],
                             "version": state["version"], "node": settings["detected"]["nodeExe"],
                             "path": self.environment["PATH"]}
        except BaseException:
            self.stop(force=True)
            raise

    def launch(self):
        if self.shortcut:
            assert sys.platform == "win32", "Shortcut launch requires Windows"
            self.pid_file = self.root / f"{self.label}-pid.txt"
            environment = {**self.environment, "CAMELLIA_QA_SOURCE_LINK": str(self.shortcut),
                           "CAMELLIA_QA_LINK": str(self.root / f"{self.label}.lnk"),
                           "CAMELLIA_QA_EXE": str(self.executable),
                           "CAMELLIA_QA_ARGS": subprocess.list2cmdline(self.arguments),
                           "CAMELLIA_QA_LAUNCH_LOG": str(self.output / f"{self.label}-shortcut.json"),
                           "CAMELLIA_QA_PID": str(self.pid_file)}
            command = [str(Path(os.environ["SYSTEMROOT"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"),
                       "-NoProfile", "-NonInteractive", "-File", str(REPO / "tests/launch-desktop-shortcut.ps1")]
        else:
            environment = self.environment
            command = [str(self.executable), *self.arguments]
        self.process = subprocess.Popen(command, cwd=self.root, env=environment,
                                        stdout=self.log, stderr=self.log,
                                        creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
                                        start_new_session=sys.platform != "win32")
        if not self.shortcut:
            self.app_pid = self.process.pid

    def observe(self, page):
        # Keep CDP's focus support for hidden CI windows, but let the actual
        # Electron nativeTheme determine appearance instead of a forced light
        # color scheme from the browser driver's default context.
        self.context.new_cdp_session(page).send("Emulation.setEmulatedMedia", {"features": []})
        page.on("pageerror", lambda error: self.errors.append(str(error)))
        page.on("requestfailed", lambda request: self.failed_resources.append(
            {"url": request.url, "error": request.failure})
            if request.url.startswith("file:") and request.failure != "net::ERR_ABORTED" else None)

    def wait_page(self, suffix):
        from playwright.sync_api import TimeoutError as PlaywrightTimeout

        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            for page in self.context.pages:
                if not page.is_closed() and suffix in page.url:
                    # CDP can attach while a file-backed Electron page is
                    # loading and miss earlier request events. Its network-idle
                    # bookkeeping can then stall after the page has rendered.
                    # Await the document's load event, which also avoids
                    # wait_for_function's eval on pages with a strict CSP.
                    # Callers additionally await their UI elements/IPC state.
                    page.wait_for_load_state("load")
                    assert "/app.asar/src/renderer/" in unquote(page.url).replace("\\", "/"), page.url
                    assert self.resources.as_posix().lower() in unquote(page.url).lower(), page.url
                    return page
            try:
                if self.context.pages:
                    self.context.pages[0].wait_for_timeout(100)
                else:
                    self.context.wait_for_event("page", timeout=1000)
            except PlaywrightTimeout:
                pass
        raise AssertionError(f"Missing packaged window: {suffix}")

    def screenshot(self, page, name):
        page.screenshot(path=str(self.output / f"{self.label}-{name}.png"), animations="disabled")

    def stop(self, force=False):
        failure = None
        if self.browser:
            try:
                self.context.tracing.stop(path=str(self.output / f"{self.label}-trace.zip"))
                if not force:
                    for page in reversed(self.context.pages):
                        if not page.is_closed():
                            page.close()
                    self.process.wait(timeout=20)
                    assert self.process.returncode == 0, f"Application quit with {self.process.returncode}"
            except Exception as error:
                failure = error
            finally:
                try:
                    self.browser.close()
                except Exception:
                    pass
                self.browser = None
        if self.process and self.process.poll() is None:
            if self.shortcut and self.pid_file.exists():
                self.app_pid = int(self.pid_file.read_text(encoding="utf-8-sig").strip())
            if sys.platform == "win32":
                subprocess.run(["taskkill", "/PID", str(self.app_pid or self.process.pid), "/T", "/F"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
                if self.process.poll() is None:
                    self.process.kill()
            else:
                os.killpg(self.process.pid, signal.SIGKILL)
            self.process.wait(timeout=10)
        self.log.close()
        if self.profile.exists():
            for file in (self.profile / "logs").glob("*.log"):
                (self.output / f"{self.label}-{file.name}").write_bytes(file.read_bytes())
        if failure and not force:
            raise failure


def configure_provider(settings, fixture, port):
    settings.locator('[data-view="providers"]').click()
    settings.locator("#enabled").check()
    settings.locator("#port").fill(str(port))
    settings.locator("#addProvider").click()
    settings.locator("#preset").select_option("custom")
    settings.locator("#confirmAdd").click()
    settings.locator("#pName").fill("Packaged acceptance fixture")
    settings.locator("#pUrl").fill(fixture.url)
    settings.locator('#keyRows [data-field="key"]').fill("local-package-key")
    settings.locator("#modelAdvanced > summary").click()
    settings.locator("#addModel").click()
    settings.locator('[data-model="0"][data-field="id"]').fill(MODEL)
    settings.locator('[data-model="0"][data-field="upstream"]').fill(MODEL)
    settings.locator("#pName").click()
    wait_value(settings, "apiRouterGetState", lambda state:
               state.get("running") and state.get("port") == port and MODEL in state.get("models", [])
               and any(p["baseUrl"] == fixture.url and any(k.get("maskedKey") for k in p["keys"])
                       for p in state["providers"]))


def run_scenario(playwright, executable, resources, output, scenario, shortcut, install_timeout):
    from playwright.sync_api import expect

    result = {"scenario": scenario, "checks": [], "launches": []}
    with tempfile.TemporaryDirectory(prefix="camellia-package-ui-", ignore_cleanup_errors=True) as temporary:
        # Match Electron's canonical data path, including macOS's /var alias.
        root = Path(temporary).resolve()
        profile = root / "App Data 中文"
        profile.mkdir()
        artifact = root / "Acceptance 中文.md"
        artifact.write_text("# Packaged file preview\n\nUnicode 中文.\n\n$$x^2 + y^2 = z^2$$\n", encoding="utf-8")
        old_id = "a04e8712-bdcb-4f15-909d-af0a1a1d2e62"
        if scenario == "upgrade":
            (profile / "desktop-config.json").write_text(json.dumps({
                "theme": "light", "language": "en", "closeToTray": False,
                "computerName": "Packaged upgrade fixture", "mode": "grok",
                "autoRefreshBalances": False, "legacyMarker": "preserve-this-field",
                "grok": {"model": MODEL}, "port": 0,
            }), encoding="utf-8")
            history = profile / "conversations"
            history.mkdir()
            (history / f"{old_id}.json").write_text(json.dumps({
                "id": old_id, "origin": "grok", "currentEngine": "grok", "title": OLD_TITLE,
                "cwd": str(root), "workspaceId": None, "createdAt": 1700000000000,
                "updatedAt": 1700000000000, "seq": 1, "segments": {}, "handoffs": [],
            }, ensure_ascii=False), encoding="utf-8")
            (history / f"{old_id}.jsonl").write_text(json.dumps(
                {"role": "user", "seq": 1, "text": OLD_MESSAGE}, ensure_ascii=False) + "\n", encoding="utf-8")
        fixture = ModelFixture(artifact)
        application = None
        try:
            print(f"{scenario}: launching the packaged GUI", flush=True)
            application = Application(playwright, executable, resources, root, output, scenario, shortcut)
            result["launches"].append(application.evidence)
            home = application.home
            expect(home.locator("#enterGrok")).to_be_visible()
            assert home.evaluate("Array.from(document.images).every(img => img.complete && img.naturalWidth > 0)")
            rows = ipc(home, "runtimeState")["engines"]
            assert len(rows) == 6 and all(row["status"] == "missing" for row in rows), rows
            result["checks"].append("normal packaged entry, isolated profile, bundled Node, no preinstalled engines")
            application.screenshot(home, "home")
            home.locator("#openConfig").click()
            settings = application.wait_page("settings/api-settings.html")
            expect(settings.locator("#generalPage")).to_be_visible()
            settings.locator('[data-theme-choice="dark"]').click()
            wait_value(settings, "workbenchSettings", lambda state: state["theme"] == "dark")
            settings.locator('[data-view="data"]').click()
            expect(settings.locator("#dataPath")).to_have_text(str(profile))
            settings.locator('[data-view="network"]').click()
            settings.locator("#networkMode").select_option("direct")
            wait_value(settings, "networkSettings", lambda state: state.get("mode") == "direct")
            configure_provider(settings, fixture, free_port())
            result["checks"].append("settings saved through the real renderer and IPC; loopback provider configured")
            settings.locator('[data-view="engines"]').click()
            settings.locator('[role="tab"][data-engine="grok"]').click()
            print(f"{scenario}: downloading Grok Build through the application's UI", flush=True)
            settings.locator('[data-install="grok"]').click()
            install_started = time.monotonic()
            def report_install(state):
                runtime = next(row for row in state["engines"] if row["id"] == "grok")
                elapsed = int(time.monotonic() - install_started)
                print(f"{scenario}: Grok Build install ({elapsed}s): {runtime['status']} {runtime.get('message', '')[:400]}", flush=True)
            rows = wait_value(settings, "runtimeState", lambda state:
                              next(row for row in state["engines"] if row["id"] == "grok")["status"] in
                              ["ready", "error"], timeout=install_timeout, report=report_install)["engines"]
            runtime = next(row for row in rows if row["id"] == "grok")
            assert runtime["status"] == "ready", runtime
            assert Path(runtime["file"]).is_relative_to(profile), runtime
            assert all(row["status"] == "missing" for row in rows if row["id"] != "grok"), rows
            result["runtime"] = {key: runtime.get(key) for key in ["file", "version", "status", "source"]}
            result["checks"].append("real Grok Build download with bundled Node/npm; other engines remain uninstalled")
            application.screenshot(settings, "runtime")
            with settings.expect_event("close"):
                settings.locator("#closeSettings").click()
            home.locator("#enterGrok").click()
            chat = application.wait_page("chat/claude.html")
            expect(chat.locator("body > .app > .main #input")).to_be_visible()
            if scenario == "upgrade":
                chat.locator("body > .app > #sidebar").get_by_text(OLD_TITLE, exact=True).click()
                expect(chat.locator("body > .app > .main #chat")).to_contain_text(OLD_MESSAGE)
                chat.locator("body > .app > #sidebar #newSessionBtn").click()
                result["checks"].append("existing conversation is visible and readable")
            if chat.locator("body > .app > .main #modelPillName").inner_text() != MODEL:
                chat.locator("body > .app > .main #modelPill").click()
                chat.locator(".pop-row").filter(has_text=re.compile("^Model")).click()
                chat.locator(f'.pop-opt[data-model-id="{MODEL}"]').click()
            expect(chat.locator("body > .app > .main #modelPillName")).to_have_text(MODEL)
            print(f"{scenario}: streaming a reply and opening its local artifact", flush=True)
            chat.locator("body > .app > .main #input").fill(PROMPT)
            chat.locator("body > .app > .main #send").click()
            expect(chat.locator("body > .app > .main #chat")).to_contain_text(REPLY, timeout=90000)
            expect(chat.locator("body > .app > .main #send")).to_be_disabled(timeout=30000)
            expect(chat.locator("body > .app > .main #chat .katex")).to_have_count(1)
            assert any(request["hasPrompt"] and request["model"] == MODEL for request in fixture.requests), fixture.requests
            application.screenshot(chat, "chat")
            chat.locator("body > .app > .main #chat a[data-chat-file]").filter(has_text="Open acceptance file").click()
            expect(chat.locator("body > .app > #fileViewer #fileViewerTitle")).to_have_text(artifact.name)
            expect(chat.locator("body > .app > #fileViewer #fileViewerBody")).to_contain_text("Packaged file preview")
            expect(chat.locator("body > .app > #fileViewer #fileViewerBody .katex")).to_have_count(1)
            chat.evaluate("document.fonts.ready")
            assert chat.evaluate("Array.from(document.fonts).some(f => f.family.startsWith('KaTeX') && f.status === 'loaded')")
            application.screenshot(chat, "preview")
            result["checks"].append("real engine streamed a Unicode reply; Markdown, math, local fonts and file preview rendered")
            assert not application.errors and not application.failed_resources, (application.errors, application.failed_resources)
            application.stop()
            application = None

            saved = json.loads((profile / "desktop-config.json").read_text(encoding="utf-8"))
            assert saved["theme"] == "dark"
            if scenario == "upgrade":
                assert saved["legacyMarker"] == "preserve-this-field"
                assert saved["computerName"] == "Packaged upgrade fixture"
                assert OLD_MESSAGE in (profile / "conversations" / f"{old_id}.jsonl").read_text(encoding="utf-8")
            conversations = [json.loads(file.read_text(encoding="utf-8"))
                             for file in (profile / "conversations").glob("*.json")
                             if file.stem != old_id and (profile / "conversations" / (file.stem + ".jsonl")).exists()
                             and REPLY in (profile / "conversations" / (file.stem + ".jsonl")).read_text(encoding="utf-8")]
            assert len(conversations) == 1, conversations
            print(f"{scenario}: restarting and opening persisted history", flush=True)
            application = Application(playwright, executable, resources, root, output, f"{scenario}-restart", shortcut)
            result["launches"].append(application.evidence)
            assert ipc(application.home, "workbenchSettings")["theme"] == "dark"
            application.home.locator("#enterGrok").click()
            chat = application.wait_page("chat/claude.html")
            chat.locator("body > .app > #sidebar").get_by_text(conversations[0]["title"], exact=True).click()
            expect(chat.locator("body > .app > .main #chat")).to_contain_text(PROMPT)
            expect(chat.locator("body > .app > .main #chat")).to_contain_text(REPLY)
            expect(chat.locator("body > .app > .main #chat .katex")).to_have_count(1)
            application.screenshot(chat, "history")
            assert not application.errors and not application.failed_resources, (application.errors, application.failed_resources)
            result["checks"].append("normal quit/restart retained preferences, runtime, messages and rendered history")
            result["requests"] = fixture.requests
            application.stop()
            application = None
            result["passed"] = True
            print(f"PASS: {scenario}: {len(result['checks'])} packaged desktop checks", flush=True)
            return result
        except BaseException:
            result["passed"] = False
            result["error"] = traceback.format_exc()
            if application and application.browser:
                for index, page in enumerate(application.context.pages):
                    try:
                        application.screenshot(page, f"failure-{index}")
                    except Exception:
                        pass
                result["pageErrors"] = application.errors
                result["failedResources"] = application.failed_resources
            (output / f"{scenario}-failure.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
            raise
        finally:
            fixture.close()
            if application:
                application.stop(force=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True, help="win-unpacked/installed directory or macOS .app")
    parser.add_argument("--shortcut", type=Path, help="Installed Windows desktop .lnk (launch a temporary copy)")
    parser.add_argument("--output", type=Path, default=REPO / "dist" / f"packaged-desktop-{sys.platform}")
    parser.add_argument("--scenario", choices=["fresh", "upgrade"], action="append")
    parser.add_argument("--install-timeout", type=int, default=240)
    args = parser.parse_args()
    if args.install_timeout <= 0:
        parser.error("--install-timeout must be positive")
    assert sys.platform in ["win32", "darwin"], "Use a matching Windows or macOS desktop host"
    bundle = args.bundle.resolve(strict=True)
    resources = bundle / ("Contents/Resources" if sys.platform == "darwin" else "resources")
    executable = bundle / ("Contents/MacOS/Camellia" if sys.platform == "darwin" else "Camellia.exe")
    output = args.output.resolve()
    shortcut = args.shortcut.resolve(strict=True) if args.shortcut else None
    output.mkdir(parents=True, exist_ok=True)
    report = {"bundle": str(bundle), "platform": sys.platform, "executableSHA256": sha256(executable),
              "asarSHA256": sha256(resources / "app.asar"), "scenarios": [], "passed": False}
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as playwright:
            for scenario in args.scenario or ["fresh", "upgrade"]:
                try:
                    report["scenarios"].append(run_scenario(playwright, executable, resources, output,
                                                           scenario, shortcut, args.install_timeout))
                except BaseException:
                    failure = output / f"{scenario}-failure.json"
                    if failure.exists():
                        report["scenarios"].append(json.loads(failure.read_text(encoding="utf-8")))
                    raise
        report["passed"] = True
    finally:
        (output / "verification.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()

"""Check the real bridge's verification policy without a model or installed SDK."""

import asyncio
import importlib.metadata
from pathlib import Path
import runpy
import sys
import tempfile
from types import ModuleType, SimpleNamespace
from unittest.mock import patch

source = Path(__file__).resolve().parents[2] / "src/engines/antigravity/bridge.py"
sys.path.insert(0, str(source.parent))
google = ModuleType("google")
sdk = ModuleType("google.antigravity")
sdk.Agent = object
sdk.LocalOpenAIAgentConfig = object
sdk.types = SimpleNamespace()
hooks = ModuleType("google.antigravity.hooks")
hooks.hooks = SimpleNamespace()
hooks.policy = SimpleNamespace()

with patch.dict(sys.modules, {"google": google, "google.antigravity": sdk, "google.antigravity.hooks": hooks}):
    Bridge = runpy.run_path(str(source), run_name="camellia_policy_fixture")["Bridge"]

with tempfile.TemporaryDirectory(prefix="discussion-sdk-policy-") as home:
    for version in ["0.1.16", "0.1.20", "99.0.0-next.1"]:
        with patch.object(importlib.metadata, "version", return_value=version):
            bridge = Bridge({"home": home, "executionPolicy": "tool-free-v1"})
            assert bridge.tool_free
            assert asyncio.run(bridge.approve(None)) is False
    for policy in [None, "", "plan", "tool-free-v2"]:
        try:
            Bridge({"home": home, "executionPolicy": policy})
        except ValueError:
            pass
        else:
            raise AssertionError("Unknown execution policy was accepted")
    for native in [{"mcpServers": {"unexpected": {"command": "must-not-start"}}}, {"skillsPaths": ["must-not-load"]}]:
        try:
            Bridge({"home": home, "executionPolicy": "tool-free-v1", "settings": native})
        except ValueError:
            pass
        else:
            raise AssertionError("Verification loaded native extensions")

print("PASS: upgraded SDKs can verify; explicit policies and tool denial remain enforced")

"""Read the client version that package.json owns."""

import json
import os
from pathlib import Path


def app_version():
    configured = os.environ.get("CAMELLIA_APP_VERSION", "").strip()
    if configured:
        return configured
    for parent in Path(__file__).resolve().parents:
        package = parent / "package.json"
        if package.is_file():
            return json.loads(package.read_text(encoding="utf-8"))["version"]
    raise RuntimeError("package.json is unavailable")

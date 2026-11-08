"""Exercise the bridge with real SDK image primitives and no model calls."""
import asyncio
import base64
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src/engines/antigravity"))
import bridge
from google.antigravity import types


async def main():
    messages, calls = [], []
    bridge.emit = messages.append

    async def chunks():
        yield types.Text(text="accepted", step_index=0)

    async def chat(content):
        calls.append(content)
        return SimpleNamespace(chunks=chunks(), stop_reason=types.StopReason.UNSPECIFIED, usage_metadata=None)

    with tempfile.TemporaryDirectory(prefix="camellia-sdk-images-") as root:
        connection = bridge.Bridge({"home": root})
        connection.agent = SimpleNamespace(chat=chat, conversation_id=None)
        await connection.handle({"id": 1, "method": "initialize"})
        assert messages[-1]["result"]["agentCapabilities"]["promptCapabilities"]["image"] is True
        payload = b"literal image bytes \x00\xff"
        encoded = base64.b64encode(payload).decode("ascii")
        for mime in ("image/png", "image/jpeg", "image/webp"):
            result = await connection.prompt({"prompt": [
                {"type": "text", "text": "before"}, {"type": "image", "mimeType": mime, "data": encoded},
                {"type": "text", "text": "after"}, {"type": "image", "mimeType": mime, "data": encoded},
            ]})
            assert result["stopReason"] == "end_turn"
            assert calls[-1][0] == "before" and calls[-1][2] == "after"
            for index in (1, 3):
                assert isinstance(calls[-1][index], types.Image)
                assert calls[-1][index].data == payload and calls[-1][index].mime_type == mime
        for part, expected in [
            ({"type": "image", "mimeType": "image/png", "data": "not base64!"}, "Invalid Antigravity image data"),
            ({"type": "image", "mimeType": "image/gif", "data": encoded}, "requires PNG, JPEG or WebP"),
            ({"type": "audio"}, "Unsupported Antigravity input"),
        ]:
            before = len(calls)
            try:
                await connection.prompt({"prompt": [part]})
                raise AssertionError("Unsupported content was accepted")
            except ValueError as error:
                assert expected in str(error), str(error)
            assert len(calls) == before, "Invalid media must never become a text-only request"


asyncio.run(main())

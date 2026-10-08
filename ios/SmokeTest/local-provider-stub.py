#!/usr/bin/env python3
"""Loopback-only OpenAI-compatible stream for simulator UI checks.

Use base URL http://127.0.0.1:43871/v1, model qa-model, key qa-only.
Include QA_SLOW_STREAM in a prompt to leave time to press Stop after chunk one.
This server never contacts a provider or writes a request body to disk.
"""

import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/v1/chat/completions":
            self.send_error(404)
            return
        if self.headers.get("Authorization") != "Bearer qa-only":
            self.send_error(401)
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > 1024 * 1024:
            self.send_error(400)
            return
        body = self.rfile.read(length)
        try:
            request = json.loads(body)
        except (ValueError, UnicodeDecodeError):
            self.send_error(400)
            return
        if request.get("model") != "qa-model":
            self.send_error(400)
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        delay = 15 if b"QA_SLOW_STREAM" in body else 0.8
        try:
            for part in ("Camellia ", "QA reply"):
                event = {"choices": [{"delta": {"content": part}, "finish_reason": None}]}
                self.wfile.write(("data: " + json.dumps(event) + "\n\n").encode())
                self.wfile.flush()
                time.sleep(delay)
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            print("served one test chat", flush=True)
        except (BrokenPipeError, ConnectionResetError):
            print("test stream closed by client", flush=True)

    def log_message(self, *_args):
        pass


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", 43871), Handler)
    print("local QA provider listening on 127.0.0.1:43871", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

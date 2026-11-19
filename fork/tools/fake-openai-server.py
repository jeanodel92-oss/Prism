#!/usr/bin/env python3
"""Minimal OpenAI-compatible chat server for local tests. Test tooling only.

Serves GET /v1/models and POST /v1/chat/completions (streaming and not), and
answers every prompt with a fixed reply, so Prism can be exercised against a
"local OpenAI-compatible server" without a real model, a key or the network.

usage: fork/tools/fake-openai-server.py [--port 8099] [--reply TEXT]

The last request body is written to stderr, which helps check what Prism sends
(model id, sampling parameters, max tokens).
"""

import argparse
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL_ID = "fake-local"


def make_handler(reply: str):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):  # keep stdout clean
            pass

        def _json(self, status: int, payload: dict) -> None:
            body = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path.rstrip("/") == "/v1/models":
                self._json(200, {"object": "list", "data": [{"id": MODEL_ID, "object": "model", "owned_by": "local"}]})
            else:
                self._json(404, {"error": {"message": "not found"}})

        def do_POST(self):
            if self.path.rstrip("/") != "/v1/chat/completions":
                self._json(404, {"error": {"message": "not found"}})
                return
            length = int(self.headers.get("Content-Length", "0"))
            request = json.loads(self.rfile.read(length) or b"{}")
            print(json.dumps(request), file=sys.stderr, flush=True)
            model = request.get("model", MODEL_ID)
            created = int(time.time())
            usage = {"prompt_tokens": 10, "completion_tokens": len(reply.split()), "total_tokens": 10 + len(reply.split())}
            if not request.get("stream"):
                self._json(
                    200,
                    {
                        "id": "chatcmpl-fake",
                        "object": "chat.completion",
                        "created": created,
                        "model": model,
                        "choices": [{"index": 0, "message": {"role": "assistant", "content": reply}, "finish_reason": "stop"}],
                        "usage": usage,
                    },
                )
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()

            def send(chunk: dict) -> None:
                self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
                self.wfile.flush()

            base = {"id": "chatcmpl-fake", "object": "chat.completion.chunk", "created": created, "model": model}
            send({**base, "choices": [{"index": 0, "delta": {"role": "assistant", "content": ""}, "finish_reason": None}]})
            for word in reply.split(" "):
                send({**base, "choices": [{"index": 0, "delta": {"content": word + " "}, "finish_reason": None}]})
            send({**base, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]})
            send({**base, "choices": [], "usage": usage})
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=8099)
    parser.add_argument("--reply", default="Hello from the fake local server.")
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(args.reply))
    print(f"fake OpenAI-compatible server on http://127.0.0.1:{args.port}/v1 (model {MODEL_ID})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()

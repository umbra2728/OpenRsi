from __future__ import annotations

import json
import secrets
import ssl
import threading
import urllib.error
import urllib.request
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from .config import MODELS


@dataclass
class ProxyState:
    upstream_key: str
    client_token: str
    budget_usd: float
    spent_usd: float = 0.0
    requests: int = 0
    run_stop_usd: float | None = None


class OpenRouterProxy:
    def __init__(self, upstream_key: str, budget_usd: float, host: str = "127.0.0.1", port: int = 0):
        self.state = ProxyState(upstream_key, secrets.token_urlsafe(32), budget_usd)
        state = self.state

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, fmt: str, *args: Any) -> None:
                return

            def _error(self, status: int, message: str) -> None:
                body = json.dumps({"error": {"message": message}}).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self) -> None:
                auth = self.headers.get("Authorization", "").removeprefix("Bearer ")
                xkey = self.headers.get("x-api-key", "")
                if state.client_token not in {auth, xkey}:
                    self._error(401, "invalid run token")
                    return
                if state.spent_usd >= state.budget_usd or (state.run_stop_usd is not None and state.spent_usd >= state.run_stop_usd):
                    self._error(402, "campaign proxy budget exhausted")
                    return
                length = int(self.headers.get("Content-Length", "0"))
                body = self.rfile.read(length)
                try:
                    payload = json.loads(body)
                except json.JSONDecodeError:
                    self._error(400, "invalid JSON")
                    return
                model = str(payload.get("model", "")).removeprefix("~")
                if model not in MODELS:
                    self._error(403, f"model {model!r} is outside benchmark allowlist")
                    return
                payload["model"] = model
                body = json.dumps(payload, separators=(",", ":")).encode()
                path = self.path
                if path.startswith("/api/"):
                    upstream_path = path
                elif path.startswith("/v1/"):
                    upstream_path = "/api" + path
                else:
                    upstream_path = "/api/v1" + (path if path.startswith("/") else "/" + path)
                request = urllib.request.Request(
                    "https://openrouter.ai" + upstream_path,
                    data=body,
                    method="POST",
                    headers={
                        "Authorization": f"Bearer {state.upstream_key}",
                        "Content-Type": "application/json",
                        "Accept": self.headers.get("Accept", "application/json"),
                        "HTTP-Referer": "https://tracehouse.ai/runs",
                        "X-Title": "harnessblog",
                    },
                )
                try:
                    with urllib.request.urlopen(request, timeout=3600, context=ssl.create_default_context()) as response:
                        data = response.read()
                        status = response.status
                        headers = response.headers
                except urllib.error.HTTPError as exc:
                    data, status, headers = exc.read(), exc.code, exc.headers
                state.requests += 1
                try:
                    parsed = json.loads(data)
                    usage = parsed.get("usage", {})
                    state.spent_usd += float(usage.get("cost") or 0)
                except (json.JSONDecodeError, TypeError, ValueError):
                    # Streaming OpenRouter responses are SSE. The final event
                    # carries usage/cost, so account it without disabling
                    # streaming at the harness boundary.
                    try:
                        for line in data.decode("utf-8", "replace").splitlines():
                            if not line.startswith("data: ") or line[6:] == "[DONE]":
                                continue
                            item = json.loads(line[6:])
                            usage = item.get("usage") or {}
                            if usage.get("cost") is not None:
                                state.spent_usd += float(usage["cost"])
                    except (json.JSONDecodeError, TypeError, ValueError):
                        pass
                self.send_response(status)
                self.send_header("Content-Type", headers.get("Content-Type", "application/json"))
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer((host, port), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def port(self) -> int:
        return self.server.server_address[1]

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def begin_run(self, limit_usd: float) -> None:
        self.state.run_stop_usd = min(self.state.budget_usd, self.state.spent_usd + limit_usd)

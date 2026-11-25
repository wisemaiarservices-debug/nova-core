from __future__ import annotations

import ipaddress
from typing import Any


class PublicApiRateLimitMiddleware:
    """Apply a per-client, per-route abuse budget to public API v1 requests.

    Cloudflare supplies CF-Connecting-IP at the edge. Forwarded-for headers are
    intentionally ignored. This is a coarse abuse-control layer: Cloudflare's
    Worker Rate Limiting counters are approximate and location-local.
    """

    def __init__(self, app: Any, binding_name: str = "NOVA_PUBLIC_API_LIMITER"):
        self.app = app
        self.binding_name = binding_name

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        method = scope.get("method", "GET").upper()
        if not path.startswith("/api/v1/") or method == "OPTIONS":
            await self.app(scope, receive, send)
            return

        # The ASGI Workers adapter supplies env in Cloudflare. Native pytest
        # and local ASGI tools have no Workers env and remain usable.
        runtime_env = scope.get("env")
        if runtime_env is None:
            await self.app(scope, receive, send)
            return

        limiter = getattr(runtime_env, self.binding_name, None)
        if limiter is None:
            await self._reject(send, 503, "rate_limiter_unavailable")
            return

        headers = {
            key.decode("latin-1").lower(): value.decode("latin-1")
            for key, value in scope.get("headers", [])
        }
        raw_ip = headers.get("cf-connecting-ip", "").strip()
        try:
            client_ip = str(ipaddress.ip_address(raw_ip))
        except ValueError:
            await self._reject(send, 503, "client_identity_unavailable")
            return

        # Route-specific keys avoid one provider's usage consuming another
        # route's allowance. Do not include query strings or caller headers.
        key = f"{client_ip}:{method}:{path}"
        try:
            from js import Object
            from pyodide.ffi import to_js

            decision = await limiter.limit(
                to_js({"key": key}, dict_converter=Object.fromEntries)
            )
            allowed = bool(decision.success)
        except Exception:
            await self._reject(send, 503, "rate_limiter_failed")
            return

        if not allowed:
            await self._reject(send, 429, "rate_limit_exceeded")
            return

        await self.app(scope, receive, send)

    @staticmethod
    async def _reject(send, status: int, code: str) -> None:
        body = code.encode("ascii")
        headers = [
            (b"content-type", b"application/json; charset=utf-8"),
            (b"cache-control", b"no-store"),
        ]
        if status == 429:
            headers.append((b"retry-after", b"60"))
        await send({"type": "http.response.start", "status": status, "headers": headers})
        await send({"type": "http.response.body", "body": b'{"error":"' + body + b'"}'})

from __future__ import annotations

import ipaddress
from typing import Any


PUBLIC_API_RATE_LIMIT_ROUTES = frozenset({
    "/api/v1/data/catalogue",
    "/api/v1/data/water/wapor/mapsets",
    "/api/v1/data/water/wapor/rasters",
    "/api/v1/data/solar/pvgis/performance",
    "/api/v1/storage/status",
    "/api/v1/forecast/run",
    "/api/v1/recommendations/run",
    "/api/v1/scenarios/simulate",
    "/api/v1/assistant/explain",
    "/api/v1/data/weather/nasa-power/daily",
})


class PublicApiRateLimitMiddleware:
    """Apply a per-client, per-route abuse budget to public API v1 requests.

    Cloudflare supplies CF-Connecting-IP at the edge. Forwarded-for headers are
    intentionally ignored. Cloudflare's counters are approximate and
    location-local; this is not authentication or a global quota.
    """

    def __init__(self, app: Any, binding_name: str = "NOVA_PUBLIC_API_LIMITER", fallback_env: Any = None):
        self.app = app
        self.binding_name = binding_name
        self.fallback_env = fallback_env

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        method = scope.get("method", "GET").upper()
        if not path.startswith("/api/v1/") or method == "OPTIONS":
            await self.app(scope, receive, send)
            return

        runtime_env = scope.get("env")
        if runtime_env is None:
            runtime_env = self.fallback_env
        if runtime_env is None:
            # Native ASGI development/test environments have no Workers binding.
            await self.app(scope, receive, send)
            return

        limiter = getattr(runtime_env, self.binding_name, None)
        if limiter is None:
            await self._reject(send, 503, "rate_limiter_unavailable")
            return

        client_ip_headers = [
            value
            for key, value in scope.get("headers", [])
            if isinstance(key, bytes) and key.lower() == b"cf-connecting-ip"
        ]
        # Cloudflare emits one canonical address. Reject duplicates, whitespace,
        # non-ASCII bytes, and overlong values before parsing or key construction.
        if len(client_ip_headers) != 1:
            await self._reject(send, 503, "client_identity_unavailable")
            return
        raw_ip_bytes = client_ip_headers[0]
        if (
            not isinstance(raw_ip_bytes, bytes)
            or not 1 <= len(raw_ip_bytes) <= 45
            or any(byte > 0x7F for byte in raw_ip_bytes)
        ):
            await self._reject(send, 503, "client_identity_unavailable")
            return
        try:
            raw_ip = raw_ip_bytes.decode("ascii")
            if raw_ip != raw_ip.strip():
                raise ValueError("non-canonical client address")
            client_ip = str(ipaddress.ip_address(raw_ip))
        except (UnicodeDecodeError, ValueError):
            await self._reject(send, 503, "client_identity_unavailable")
            return

        route_key = path if path in PUBLIC_API_RATE_LIMIT_ROUTES else "__unmatched__"
        method_key = method if method in {"GET", "POST"} else "__other__"
        key = f"{client_ip}:{method_key}:{route_key}"
        try:
            from js import Object
            from pyodide.ffi import to_js

            decision = await limiter.limit(to_js({"key": key}, dict_converter=Object.fromEntries))
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

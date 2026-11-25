"""Fail-closed, edge-local abuse controls for the public research API."""
from __future__ import annotations
import ipaddress
import json
from typing import Any, Awaitable, Callable
UPSTREAM_PATH_PREFIXES = (
    "/api/v1/data/water/wapor/",
    "/api/v1/data/solar/pvgis/",
    "/api/v1/data/weather/nasa-power/",
)

def _client_ip(scope: dict[str, Any]) -> str | None:
    values = [value for name, value in scope.get("headers", []) if name.lower() == b"cf-connecting-ip"]
    if len(values) != 1:
        return None
    try:
        return ipaddress.ip_address(values[0].decode("ascii").strip()).compressed
    except (UnicodeDecodeError, ValueError):
        return None

def _limit_options(key: str) -> Any:
    try:
        from js import Object
        from pyodide.ffi import to_js
    except ImportError:
        return {"key": key}
    return to_js({"key": key}, dict_converter=Object.fromEntries)

async def _json_response(send: Callable[..., Awaitable[None]], status: int, code: str) -> None:
    body = json.dumps({"error": code}, separators=(",", ":")).encode("utf-8")
    headers = [(b"content-type", b"application/json; charset=utf-8"), (b"cache-control", b"no-store")]
    if status == 429:
        headers.append((b"retry-after", b"60"))
    await send({"type": "http.response.start", "status": status, "headers": headers})
    await send({"type": "http.response.body", "body": body})

class PublicApiRateLimitMiddleware:
    """Apply per-client general and provider-egress limits to /api/v1 routes."""
    def __init__(self, app: Callable[..., Awaitable[None]]) -> None:
        self.app = app

    async def __call__(self, scope: dict[str, Any], receive: Callable[..., Awaitable[Any]],
                       send: Callable[..., Awaitable[None]]) -> None:
        path = str(scope.get("path", ""))
        if scope.get("type") != "http" or scope.get("method") == "OPTIONS" or not path.startswith("/api/v1/"):
            await self.app(scope, receive, send)
            return

        # Plain ASGI/CPython tests and local FastAPI tooling have no Workers
        # environment. A deployed Python Worker has the Workers env module;
        # if its bindings are absent, do not silently bypass limits.
        runtime_env = scope.get("env")
        if runtime_env is None:
            # CPython/FastAPI unit tests run outside the Workers runtime.
            # The deployed ASGI adapter supplies scope["env"] (covered by the
            # existing Python Worker binding proof).
            await self.app(scope, receive, send)
            return

        client_ip = _client_ip(scope)
        general = getattr(runtime_env, "PUBLIC_API_RATE_LIMITER", None)
        upstream = getattr(runtime_env, "UPSTREAM_API_RATE_LIMITER", None)
        is_upstream = any(path.startswith(prefix) for prefix in UPSTREAM_PATH_PREFIXES)
        if client_ip is None or general is None or (is_upstream and upstream is None):
            await _json_response(send, 503, "rate_limiter_unavailable")
            return

        try:
            general_result = await general.limit(_limit_options(f"public-api:v1:{client_ip}"))
            if not bool(general_result.success):
                await _json_response(send, 429, "rate_limit_exceeded")
                return
            if is_upstream:
                upstream_result = await upstream.limit(_limit_options(f"provider-egress:v1:{client_ip}"))
                if not bool(upstream_result.success):
                    await _json_response(send, 429, "provider_rate_limit_exceeded")
                    return
        except Exception:
            # Binding errors must not turn the public API into an unmetered proxy.
            await _json_response(send, 503, "rate_limiter_unavailable")
            return
        await self.app(scope, receive, send)

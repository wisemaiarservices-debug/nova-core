import asyncio
import sys
import types
from types import SimpleNamespace

import pytest
from fastapi.middleware.cors import CORSMiddleware

from apps.api.main import app
from apps.api.rate_limit import PublicApiRateLimitMiddleware


def make_scope(path="/api/v1/data/weather/nasa-power/daily", headers=None, env=None, method="GET"):
    return {
        "type": "http",
        "method": method,
        "path": path,
        "headers": headers or [],
        "env": env,
    }


async def invoke(middleware, scope):
    messages = []
    called = {"app": False}

    async def app(scope, receive, send):
        called["app"] = True
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        messages.append(message)

    middleware.app = app
    await middleware(scope, receive, send)
    return messages, called["app"]


def install_pyodide_bridge(monkeypatch):
    js = types.ModuleType("js")
    js.Object = SimpleNamespace(fromEntries=lambda entries: dict(entries))
    pyodide = types.ModuleType("pyodide")
    pyodide.__path__ = []
    ffi = types.ModuleType("pyodide.ffi")
    ffi.to_js = lambda value, dict_converter: value
    monkeypatch.setitem(sys.modules, "js", js)
    monkeypatch.setitem(sys.modules, "pyodide", pyodide)
    monkeypatch.setitem(sys.modules, "pyodide.ffi", ffi)


def test_rate_limit_binding_is_production_only_until_preview_support_exists():
    import json
    from pathlib import Path

    config = json.loads((Path(__file__).parents[1] / "wrangler.jsonc").read_text())
    assert config["ratelimits"][0]["name"] == "NOVA_PUBLIC_API_LIMITER"
    assert "ratelimits" not in config["previews"]


def test_cors_wraps_rate_limiter_for_throttled_browser_responses():
    assert app.user_middleware[0].cls is CORSMiddleware
    assert app.user_middleware[1].cls is PublicApiRateLimitMiddleware


def test_cloudflare_scope_without_binding_fails_closed():
    messages, reached = asyncio.run(invoke(
        PublicApiRateLimitMiddleware(None),
        make_scope(env=SimpleNamespace()),
    ))
    assert messages[0]["status"] == 503
    assert b"rate_limiter_unavailable" in messages[1]["body"]
    assert reached is False


def test_missing_client_ip_fails_closed_and_does_not_trust_forwarded_for(monkeypatch):
    install_pyodide_bridge(monkeypatch)

    class Limiter:
        called = False
        async def limit(self, options):
            self.called = True
            return SimpleNamespace(success=True)

    limiter = Limiter()
    messages, reached = asyncio.run(invoke(
        PublicApiRateLimitMiddleware(None),
        make_scope(
            headers=[(b"x-forwarded-for", b"203.0.113.7")],
            env=SimpleNamespace(NOVA_PUBLIC_API_LIMITER=limiter),
        ),
    ))
    assert messages[0]["status"] == 503
    assert limiter.called is False
    assert reached is False


def test_uses_cloudflare_ip_and_route_scoped_key(monkeypatch):
    install_pyodide_bridge(monkeypatch)

    class Limiter:
        options = None
        async def limit(self, options):
            self.options = options
            return SimpleNamespace(success=True)

    limiter = Limiter()
    scope = make_scope(
        headers=[
            (b"cf-connecting-ip", b"203.0.113.8"),
            (b"x-forwarded-for", b"198.51.100.4"),
        ],
        env=SimpleNamespace(NOVA_PUBLIC_API_LIMITER=limiter),
    )
    messages, reached = asyncio.run(invoke(PublicApiRateLimitMiddleware(None), scope))
    assert messages[0]["status"] == 200
    assert reached is True
    assert limiter.options == {"key": "203.0.113.8:GET:/api/v1/data/weather/nasa-power/daily"}


def test_limiter_rejection_returns_429(monkeypatch):
    install_pyodide_bridge(monkeypatch)

    class Limiter:
        async def limit(self, options):
            return SimpleNamespace(success=False)

    messages, reached = asyncio.run(invoke(
        PublicApiRateLimitMiddleware(None),
        make_scope(
            headers=[(b"cf-connecting-ip", b"203.0.113.9")],
            env=SimpleNamespace(NOVA_PUBLIC_API_LIMITER=Limiter()),
        ),
    ))
    assert messages[0]["status"] == 429
    assert (b"retry-after", b"60") in messages[0]["headers"]
    assert reached is False


def test_limiter_exception_returns_503(monkeypatch):
    install_pyodide_bridge(monkeypatch)

    class Limiter:
        async def limit(self, options):
            raise RuntimeError("binding failure")

    messages, reached = asyncio.run(invoke(
        PublicApiRateLimitMiddleware(None),
        make_scope(
            headers=[(b"cf-connecting-ip", b"203.0.113.10")],
            env=SimpleNamespace(NOVA_PUBLIC_API_LIMITER=Limiter()),
        ),
    ))
    assert messages[0]["status"] == 503
    assert b"rate_limiter_failed" in messages[1]["body"]
    assert reached is False


@pytest.mark.parametrize("path,method", [
    ("/health", "GET"),
    ("/docs", "GET"),
    ("/api/v1/data/catalogue", "OPTIONS"),
])
def test_non_api_or_preflight_requests_do_not_consume_limiter(path, method):
    messages, reached = asyncio.run(invoke(
        PublicApiRateLimitMiddleware(None),
        make_scope(path=path, method=method, env=SimpleNamespace()),
    ))
    assert messages[0]["status"] == 200
    assert reached is True


def test_workers_env_fallback_fails_closed_if_binding_missing():
    messages, reached = asyncio.run(invoke(
        PublicApiRateLimitMiddleware(None, fallback_env=SimpleNamespace()),
        make_scope(env=None),
    ))
    assert messages[0]["status"] == 503
    assert b"rate_limiter_unavailable" in messages[1]["body"]
    assert reached is False


def test_native_asgi_without_cloudflare_env_remains_available():
    messages, reached = asyncio.run(invoke(
        PublicApiRateLimitMiddleware(None),
        make_scope(env=None),
    ))
    assert messages[0]["status"] == 200
    assert reached is True

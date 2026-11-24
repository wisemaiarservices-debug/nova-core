"""Minimal ASGI probe for Cloudflare's Python Worker Rate Limiting binding."""

from js import Object
from pyodide.ffi import to_js


async def route(scope, receive, send):
    if scope["type"] != "http":
        return
    await _respond(send, 200, b"route reached")


async def app(scope, receive, send):
    if scope["type"] != "http":
        await route(scope, receive, send)
        return

    env = scope.get("env")
    limiter = getattr(env, "TEST_RATE_LIMITER", None) if env is not None else None
    if limiter is None:
        await _respond(send, 503, b"rate limiter binding unavailable")
        return

    try:
        key = scope.get("path", "/")[:128]
        decision = await limiter.limit(
            to_js({"key": key}, dict_converter=Object.fromEntries)
        )
        allowed = bool(decision.success)
    except Exception:
        await _respond(send, 503, b"rate limiter binding failed")
        return

    if not allowed:
        await _respond(send, 429, b"rate limit exceeded")
        return

    await route(scope, receive, send)


async def _respond(send, status, body):
    await send({
        "type": "http.response.start",
        "status": status,
        "headers": [(b"content-type", b"text/plain; charset=utf-8")],
    })
    await send({"type": "http.response.body", "body": body})

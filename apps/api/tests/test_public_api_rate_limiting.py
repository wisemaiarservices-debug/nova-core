import asyncio
from types import SimpleNamespace
from apps.api.rate_limiting import PublicApiRateLimitMiddleware

class FakeLimiter:
    def __init__(self, decisions=None, raises=False):
        self.decisions = list(decisions or [True])
        self.raises = raises
        self.keys = []
    async def limit(self, options):
        if self.raises:
            raise RuntimeError("binding unavailable")
        self.keys.append(options["key"])
        return SimpleNamespace(success=self.decisions.pop(0))

async def invoke(middleware, path="/api/v1/data/catalogue", headers=None, env=None, method="GET"):
    messages = []
    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}
    async def send(message):
        messages.append(message)
    scope = {
        "type": "http", "method": method, "path": path,
        "headers": headers if headers is not None else [(b"cf-connecting-ip", b"203.0.113.10")],
    }
    if env is not None:
        scope["env"] = env
    await middleware(scope, receive, send)
    return messages

def app_response():
    async def app(scope, receive, send):
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b""})
    return app

def response_status(messages):
    return next(message["status"] for message in messages if message["type"] == "http.response.start")

def test_non_api_and_health_paths_do_not_consume_rate_limit():
    general = FakeLimiter()
    middleware = PublicApiRateLimitMiddleware(app_response())
    env = SimpleNamespace(PUBLIC_API_RATE_LIMITER=general)
    messages = asyncio.run(invoke(middleware, path="/health", env=env))
    assert response_status(messages) == 204
    assert general.keys == []

def test_plain_asgi_test_environment_is_not_mistaken_for_a_worker_deployment():
    middleware = PublicApiRateLimitMiddleware(app_response())
    messages = asyncio.run(invoke(middleware, env=None))
    assert response_status(messages) == 204

def test_general_limit_is_applied_to_api_requests():
    general = FakeLimiter([True])
    middleware = PublicApiRateLimitMiddleware(app_response())
    env = SimpleNamespace(PUBLIC_API_RATE_LIMITER=general)
    messages = asyncio.run(invoke(middleware, env=env))
    assert response_status(messages) == 204
    assert general.keys == ["public-api:v1:203.0.113.10"]

def test_general_limit_denial_stops_request_before_application():
    general = FakeLimiter([False])
    middleware = PublicApiRateLimitMiddleware(app_response())
    env = SimpleNamespace(PUBLIC_API_RATE_LIMITER=general)
    messages = asyncio.run(invoke(middleware, env=env))
    assert response_status(messages) == 429
    assert b"rate_limit_exceeded" in next(m["body"] for m in messages if m["type"] == "http.response.body")

def test_provider_routes_consume_general_and_provider_buckets():
    general = FakeLimiter([True])
    upstream = FakeLimiter([True])
    middleware = PublicApiRateLimitMiddleware(app_response())
    env = SimpleNamespace(PUBLIC_API_RATE_LIMITER=general, UPSTREAM_API_RATE_LIMITER=upstream)
    messages = asyncio.run(invoke(middleware, path="/api/v1/data/solar/pvgis/performance", env=env))
    assert response_status(messages) == 204
    assert general.keys == ["public-api:v1:203.0.113.10"]
    assert upstream.keys == ["provider-egress:v1:203.0.113.10"]

def test_provider_limit_denial_stops_upstream_request():
    general = FakeLimiter([True])
    upstream = FakeLimiter([False])
    middleware = PublicApiRateLimitMiddleware(app_response())
    env = SimpleNamespace(PUBLIC_API_RATE_LIMITER=general, UPSTREAM_API_RATE_LIMITER=upstream)
    messages = asyncio.run(invoke(middleware, path="/api/v1/data/weather/nasa-power/daily", env=env))
    assert response_status(messages) == 429
    assert b"provider_rate_limit_exceeded" in next(m["body"] for m in messages if m["type"] == "http.response.body")

def test_missing_binding_fails_closed_on_api_route():
    middleware = PublicApiRateLimitMiddleware(app_response())
    env = SimpleNamespace(PUBLIC_API_RATE_LIMITER=FakeLimiter())
    messages = asyncio.run(invoke(middleware, path="/api/v1/data/water/wapor/mapsets", env=env))
    assert response_status(messages) == 503

def test_missing_or_ambiguous_cloudflare_client_ip_fails_closed():
    middleware = PublicApiRateLimitMiddleware(app_response())
    env = SimpleNamespace(PUBLIC_API_RATE_LIMITER=FakeLimiter())
    for headers in ([], [(b"x-forwarded-for", b"203.0.113.10")],
                    [(b"cf-connecting-ip", b"bad-ip")],
                    [(b"cf-connecting-ip", b"203.0.113.10"), (b"cf-connecting-ip", b"203.0.113.11")]):
        messages = asyncio.run(invoke(middleware, env=env, headers=headers))
        assert response_status(messages) == 503

def test_binding_exception_fails_closed():
    middleware = PublicApiRateLimitMiddleware(app_response())
    env = SimpleNamespace(PUBLIC_API_RATE_LIMITER=FakeLimiter(raises=True))
    messages = asyncio.run(invoke(middleware, env=env))
    assert response_status(messages) == 503

def test_options_preflight_does_not_consume_rate_limit():
    general = FakeLimiter()
    middleware = PublicApiRateLimitMiddleware(app_response())
    env = SimpleNamespace(PUBLIC_API_RATE_LIMITER=general)
    messages = asyncio.run(invoke(middleware, env=env, method="OPTIONS"))
    assert response_status(messages) == 204
    assert general.keys == []

def test_missing_general_binding_fails_closed():
    middleware = PublicApiRateLimitMiddleware(app_response())
    env = SimpleNamespace()
    messages = asyncio.run(invoke(middleware, env=env))
    assert response_status(messages) == 503

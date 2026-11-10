from workers import asgi

try:
    from .main import app
except ImportError:
    from main import app

# Cloudflare's Python Workers ASGI adapter hosts the existing FastAPI application.
Default = asgi.entrypoint(app)

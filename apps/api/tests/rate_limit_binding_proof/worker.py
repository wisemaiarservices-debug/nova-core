from workers import asgi

from probe import app

Default = asgi.entrypoint(app)

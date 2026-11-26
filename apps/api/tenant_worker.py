from workers import asgi

try:
    from .tenant_main import app
except ImportError:
    from tenant_main import app

# Separate private ASGI Worker; access is intended only through a Service Binding.
Default = asgi.entrypoint(app)

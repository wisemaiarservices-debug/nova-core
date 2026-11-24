"""Native regression for fail-closed handling when the Rate Limiting binding throws."""

import asyncio
import importlib
import sys
import types
import unittest
from types import SimpleNamespace
from unittest.mock import patch


class RateLimitBindingFailureTest(unittest.TestCase):
    def test_binding_exception_returns_503_before_route(self):
        js = types.ModuleType("js")
        js.Object = SimpleNamespace(fromEntries=lambda entries: dict(entries))
        pyodide = types.ModuleType("pyodide")
        pyodide.__path__ = []
        ffi = types.ModuleType("pyodide.ffi")
        ffi.to_js = lambda value, dict_converter: value

        with patch.dict(
            sys.modules,
            {"js": js, "pyodide": pyodide, "pyodide.ffi": ffi},
        ):
            sys.modules.pop("probe", None)
            probe = importlib.import_module("probe")

            class BrokenLimiter:
                async def limit(self, options):
                    raise RuntimeError("simulated binding failure")

            messages = []

            async def send(message):
                messages.append(message)

            async def receive():
                return {"type": "http.request", "body": b"", "more_body": False}

            asyncio.run(
                probe.app(
                    {
                        "type": "http",
                        "path": "/probe",
                        "env": SimpleNamespace(TEST_RATE_LIMITER=BrokenLimiter()),
                    },
                    receive,
                    send,
                )
            )

            self.assertEqual(messages[0]["status"], 503)
            self.assertEqual(messages[1]["body"], b"rate limiter binding failed")
            self.assertEqual(len(messages), 2)

        sys.modules.pop("probe", None)


if __name__ == "__main__":
    unittest.main()

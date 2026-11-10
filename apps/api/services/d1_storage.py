"""Read-only Cloudflare D1 readiness probe.

This module deliberately exposes no mutation helpers. The probe confirms that
the binding can execute a read query and that the expected schema is present.
"""
from __future__ import annotations

from typing import Any

EXPECTED_TABLES = {"sites", "assets", "sources", "observations", "audit_events"}


async def inspect_d1_binding(env: Any | None) -> dict[str, Any]:
    """Return truthful D1 readiness without conflating API health and storage."""
    if env is None:
        return {
            "status": "unconfigured",
            "provider": "cloudflare-d1",
            "binding": "DB",
            "query_succeeded": False,
            "expected_tables": sorted(EXPECTED_TABLES),
            "present_tables": [],
            "missing_tables": sorted(EXPECTED_TABLES),
            "writes_enabled": False,
            "detail": "No Worker environment was supplied; D1 is not configured.",
        }

    try:
        database = getattr(env, "DB", None)
    except Exception:
        database = None

    if database is None:
        return {
            "status": "unconfigured",
            "provider": "cloudflare-d1",
            "binding": "DB",
            "query_succeeded": False,
            "expected_tables": sorted(EXPECTED_TABLES),
            "present_tables": [],
            "missing_tables": sorted(EXPECTED_TABLES),
            "writes_enabled": False,
            "detail": "The DB binding is absent. Provision and bind D1 before enabling persistence.",
        }

    try:
        statement = database.prepare(
            "SELECT name FROM sqlite_master WHERE type = ?"
        ).bind("table")
        result = await statement.all()
        rows = result.results.to_py()
        present = sorted(
            row["name"] for row in rows
            if isinstance(row, dict) and row.get("name") in EXPECTED_TABLES
        )
        missing = sorted(EXPECTED_TABLES - set(present))
        return {
            "status": "ready" if not missing else "schema_incomplete",
            "provider": "cloudflare-d1",
            "binding": "DB",
            "query_succeeded": True,
            "expected_tables": sorted(EXPECTED_TABLES),
            "present_tables": present,
            "missing_tables": missing,
            "writes_enabled": False,
            "detail": (
                "D1 read probe succeeded and the expected schema is present."
                if not missing
                else "D1 is reachable, but the NOVA Core schema migration is incomplete."
            ),
        }
    except Exception:
        return {
            "status": "unavailable",
            "provider": "cloudflare-d1",
            "binding": "DB",
            "query_succeeded": False,
            "expected_tables": sorted(EXPECTED_TABLES),
            "present_tables": [],
            "missing_tables": sorted(EXPECTED_TABLES),
            "writes_enabled": False,
            "detail": "The D1 read probe failed. Database details are intentionally not exposed.",
        }

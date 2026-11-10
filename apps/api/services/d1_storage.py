"""Read-only Cloudflare D1 connectivity and schema inspection.

This adapter never creates tables or writes records. It reports unconfigured
until a real D1 binding is attached to the Worker.
"""
from typing import Any

EXPECTED_TABLES = {"sites", "assets", "sources", "observations", "audit_events"}


async def inspect_d1_binding(database: Any) -> dict[str, Any]:
    """Inspect required schema tables through the documented D1 binding API."""
    result = await database.prepare(
        "SELECT name FROM sqlite_master WHERE type = ? ORDER BY name"
    ).bind("table").run()
    rows = list(result.results)
    present = sorted(
        str(row["name"]) for row in rows
        if isinstance(row, dict) and row.get("name") in EXPECTED_TABLES
    )
    missing = sorted(EXPECTED_TABLES - set(present))
    return {
        "status": "ready" if not missing else "schema_incomplete",
        "engine": "cloudflare_d1",
        "read_only": True,
        "required_tables": sorted(EXPECTED_TABLES),
        "present_tables": present,
        "missing_tables": missing,
        "writes_performed": False,
    }


async def storage_status(binding: Any = None) -> dict[str, Any]:
    """Return truthful storage state without confusing API health with DB health."""
    if binding is None:
        return {
            "status": "unconfigured",
            "engine": "cloudflare_d1",
            "read_only": True,
            "required_tables": sorted(EXPECTED_TABLES),
            "present_tables": [],
            "missing_tables": sorted(EXPECTED_TABLES),
            "writes_performed": False,
            "detail": "No D1 binding named DB is attached to this Worker.",
        }
    try:
        return await inspect_d1_binding(binding)
    except Exception:
        # Do not expose binding internals, SQL details, or credentials in API output.
        return {
            "status": "unavailable",
            "engine": "cloudflare_d1",
            "read_only": True,
            "required_tables": sorted(EXPECTED_TABLES),
            "present_tables": [],
            "missing_tables": sorted(EXPECTED_TABLES),
            "writes_performed": False,
            "detail": "The D1 binding could not be queried.",
        }

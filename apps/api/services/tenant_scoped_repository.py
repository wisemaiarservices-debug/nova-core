"""Read-only tenant-scoped resource repository.

Every read first checks the trusted tenant membership and exact resource grant,
then performs a parameterized query containing the same tenant_id and resource
ID. This module intentionally exposes no unscoped lookup or write operation.
"""
from __future__ import annotations

from typing import Any, Literal

from .tenant_authorization_storage import (
    TenantAuthorizationStorageError,
    authorize_tenant_resource_action,
)

ReadableResourceType = Literal["site", "asset", "source", "observation", "audit_event"]

RESOURCE_SELECTS: dict[ReadableResourceType, str] = {
    "site": """
        SELECT id, name, description, latitude, longitude, timezone, status,
               metadata_json, created_at, updated_at
        FROM sites WHERE tenant_id = ? AND id = ? LIMIT 1
    """,
    "asset": """
        SELECT id, site_id, name, asset_type, external_ref, status,
               metadata_json, created_at, updated_at
        FROM assets WHERE tenant_id = ? AND id = ? LIMIT 1
    """,
    "source": """
        SELECT id, site_id, module, provider, source_type, display_name,
               verification_status, verification_method, license_reference,
               metadata_json, created_at, updated_at
        FROM sources WHERE tenant_id = ? AND id = ? LIMIT 1
    """,
    "observation": """
        SELECT id, site_id, asset_id, source_id, module, metric, value, unit,
               observed_at, ingested_at, verification_status, provenance_json,
               quality_flags_json, retention_until
        FROM observations WHERE tenant_id = ? AND id = ? LIMIT 1
    """,
    "audit_event": """
        SELECT id, tenant_id, actor_type, actor_id, action, entity_type,
               entity_id, occurred_at, request_id, details_json
        FROM audit_events WHERE tenant_id = ? AND id = ? LIMIT 1
    """,
}


async def read_authorized_tenant_resource(
    database: Any,
    *,
    principal_subject: str,
    tenant_id: str,
    resource_type: ReadableResourceType,
    resource_id: str,
) -> dict[str, Any] | None:
    """Return one authorized tenant resource, or None for denied/not-found.

    Denial and absence deliberately share the same result to reduce resource
    enumeration. Callers must not bypass this function with direct ID lookups.
    """
    statement = RESOURCE_SELECTS.get(resource_type)
    if statement is None:
        raise ValueError("resource type is not supported by the tenant read repository")

    decision = await authorize_tenant_resource_action(
        database,
        principal_subject=principal_subject,
        tenant_id=tenant_id,
        resource_type=resource_type,
        resource_id=resource_id,
        action="read",
    )
    if not decision.allowed:
        return None

    try:
        result = await database.prepare(statement).bind(tenant_id, resource_id).run()
    except Exception as exc:
        raise TenantAuthorizationStorageError(
            "tenant resource storage is unavailable"
        ) from exc

    rows = getattr(result, "results", None)
    if rows is None and isinstance(result, dict):
        rows = result.get("results")
    if not isinstance(rows, list) or len(rows) > 1 or any(not isinstance(row, dict) for row in rows):
        raise TenantAuthorizationStorageError("tenant resource storage returned an invalid result")
    if not rows:
        return None
    row = rows[0]
    if row.get("tenant_id") != tenant_id or row.get("id") != resource_id:
        return None
    return row

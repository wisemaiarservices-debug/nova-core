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
        SELECT id, tenant_id, name, description, latitude, longitude, timezone, status,
               metadata_json, created_at, updated_at
        FROM sites WHERE tenant_id = ? AND id = ? LIMIT 1
    """,
    "asset": """
        SELECT id, tenant_id, site_id, name, asset_type, external_ref, status,
               metadata_json, created_at, updated_at
        FROM assets WHERE tenant_id = ? AND id = ? LIMIT 1
    """,
    "source": """
        SELECT id, tenant_id, site_id, module, provider, source_type, display_name,
               verification_status, verification_method, license_reference,
               metadata_json, created_at, updated_at
        FROM sources WHERE tenant_id = ? AND id = ? LIMIT 1
    """,
    "observation": """
        SELECT id, tenant_id, site_id, asset_id, source_id, module, metric, value, unit,
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
    if not isinstance(resource_type, str):
        raise ValueError("resource type is not supported by the tenant read repository")
    statement = RESOURCE_SELECTS.get(resource_type)
    if statement is None:
        raise ValueError("resource type is not supported by the tenant read repository")

    if (
        not isinstance(principal_subject, str) or not principal_subject.strip()
        or not isinstance(tenant_id, str) or not tenant_id.strip()
        or not isinstance(resource_id, str) or not resource_id.strip()
        or len(principal_subject) > 200 or len(tenant_id) > 120 or len(resource_id) > 160
    ):
        return None
    principal_subject = principal_subject.strip()
    tenant_id = tenant_id.strip()
    resource_id = resource_id.strip()

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

    success = getattr(result, "success", None)
    if success is None and isinstance(result, dict):
        success = result.get("success")
    if success is False:
        raise TenantAuthorizationStorageError("tenant resource storage returned an unsuccessful result")
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
    # Return only the statically declared projection, even if an adapter returns
    # unexpected extra columns.
    projection = statement.split("FROM", 1)[0].replace("SELECT", "", 1)
    allowed_columns = {column.strip() for column in projection.split(",")}
    return {key: value for key, value in row.items() if key in allowed_columns}

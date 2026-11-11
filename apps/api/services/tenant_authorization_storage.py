"""D1-backed loader for tenant authorization context.

All lookups are explicitly scoped by tenant and principal. This adapter does not
authenticate the principal; callers must pass a subject from a verified identity.
Storage errors fail closed and never produce an allow decision.
"""
from __future__ import annotations

from typing import Any

from .tenant_authorization import (
    Action,
    AuthorizationDecision,
    ResourceGrant,
    ResourceType,
    TenantMembership,
    authorize_resource_action,
)


class TenantAuthorizationStorageError(RuntimeError):
    """Trusted tenant authorization records could not be loaded safely."""


MEMBERSHIP_SQL = """
SELECT m.subject, m.tenant_id, m.role, m.status AS membership_status,
       t.status AS tenant_status
FROM tenant_memberships AS m
JOIN tenants AS t ON t.id = m.tenant_id
WHERE m.subject = ? AND m.tenant_id = ?
LIMIT 2
"""

RESOURCE_GRANTS_SQL = """
SELECT subject, tenant_id, resource_type, resource_id, action
FROM tenant_resource_grants
WHERE tenant_id = ? AND subject = ? AND resource_type = ? AND resource_id = ?
"""


def _result_rows(result: Any) -> list[dict[str, Any]]:
    rows = getattr(result, "results", None)
    if rows is None and isinstance(result, dict):
        rows = result.get("results")
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise TenantAuthorizationStorageError("authorization storage returned an invalid result")
    return rows


async def _query(database: Any, statement: str, parameters: tuple[str, ...]) -> list[dict[str, Any]]:
    try:
        result = await database.prepare(statement).bind(*parameters).run()
        return _result_rows(result)
    except TenantAuthorizationStorageError:
        raise
    except Exception as exc:
        # Do not expose SQL, binding, database or tenant details to API callers.
        raise TenantAuthorizationStorageError("tenant authorization storage is unavailable") from exc


async def authorize_tenant_resource_action(
    database: Any,
    *,
    principal_subject: str,
    tenant_id: str,
    resource_type: ResourceType,
    resource_id: str,
    action: Action,
) -> AuthorizationDecision:
    """Load trusted tenant membership and exact grants, then evaluate policy.

    No tenant or resource identifier supplied by a caller is trusted as an
    entitlement. They are selectors that must match server-owned records.
    """
    if database is None:
        raise TenantAuthorizationStorageError("tenant authorization storage is unavailable")
    if not principal_subject or not tenant_id or not resource_id:
        return AuthorizationDecision(allowed=False, reason_code="missing_membership")

    membership_rows = await _query(database, MEMBERSHIP_SQL, (principal_subject, tenant_id))
    if len(membership_rows) != 1:
        # No membership and duplicate/corrupt rows both deny without disclosure.
        return authorize_resource_action(
            principal_subject=principal_subject,
            tenant_id=tenant_id,
            resource_type=resource_type,
            resource_id=resource_id,
            action=action,
            memberships=(),
        )

    row = membership_rows[0]
    try:
        membership = TenantMembership(
            subject=row["subject"],
            tenant_id=row["tenant_id"],
            role=row["role"],
            active=row["membership_status"] == "active",
            tenant_active=row["tenant_status"] == "active",
        )
    except Exception as exc:
        raise TenantAuthorizationStorageError("tenant authorization records are invalid") from exc

    grants: tuple[ResourceGrant, ...] = ()
    if resource_type != "tenant":
        grant_rows = await _query(
            database,
            RESOURCE_GRANTS_SQL,
            (tenant_id, principal_subject, resource_type, resource_id),
        )
        try:
            grants = tuple(
                ResourceGrant(
                    subject=item["subject"],
                    tenant_id=item["tenant_id"],
                    resource_type=item["resource_type"],
                    resource_id=item["resource_id"],
                    actions=(item["action"],),
                )
                for item in grant_rows
            )
        except Exception as exc:
            raise TenantAuthorizationStorageError("tenant resource grants are invalid") from exc

    return authorize_resource_action(
        principal_subject=principal_subject,
        tenant_id=tenant_id,
        resource_type=resource_type,
        resource_id=resource_id,
        action=action,
        memberships=(membership,),
        resource_grants=grants,
    )

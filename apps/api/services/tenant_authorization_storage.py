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


def _python_value(value: Any) -> Any:
    """Normalize Pyodide JavaScript proxies into native Python values."""
    to_python = getattr(value, "to_py", None)
    if callable(to_python):
        try:
            return to_python()
        except Exception:
            return value
    return value


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
LIMIT 7
"""


def _result_rows(result: Any, *, maximum: int) -> list[dict[str, Any]]:
    success = _python_value(getattr(result, "success", None))
    if success is None and isinstance(result, dict):
        success = result.get("success")
    if success is not True:
        raise TenantAuthorizationStorageError("authorization storage returned an unsuccessful or incomplete result")
    rows = _python_value(getattr(result, "results", None))
    if rows is None and isinstance(result, dict):
        rows = result.get("results")
    if not isinstance(rows, list) or len(rows) > maximum:
        raise TenantAuthorizationStorageError("authorization storage returned an invalid result")
    rows = [_python_value(row) for row in rows]
    if any(not isinstance(row, dict) for row in rows):
        raise TenantAuthorizationStorageError("authorization storage returned an invalid result")
    return rows


async def _query(database: Any, statement: str, parameters: tuple[str, ...], *, maximum: int) -> list[dict[str, Any]]:
    try:
        result = await database.prepare(statement).bind(*parameters).run()
        return _result_rows(result, maximum=maximum)
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
    preflight = authorize_resource_action(
        principal_subject=principal_subject,
        tenant_id=tenant_id,
        resource_type=resource_type,
        resource_id=resource_id,
        action=action,
        memberships=(),
    )
    if preflight.reason_code in {"invalid_context", "resource_action_invalid"}:
        return preflight
    if (
        len(principal_subject) > 200
        or len(tenant_id) > 120
        or len(resource_id) > 160
    ):
        return AuthorizationDecision(allowed=False, reason_code="invalid_context")

    principal_subject = principal_subject.strip()
    tenant_id = tenant_id.strip()
    resource_id = resource_id.strip()
    membership_rows = await _query(
        database, MEMBERSHIP_SQL, (principal_subject, tenant_id), maximum=2
    )
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
        if membership.subject != principal_subject or membership.tenant_id != tenant_id:
            raise ValueError("membership query returned a different subject or tenant")
    except Exception as exc:
        raise TenantAuthorizationStorageError("tenant authorization records are invalid") from exc

    # Stop before loading resource grants for inactive memberships or suspended
    # tenants. This avoids unnecessary access to entitlement records.
    if not membership.active or not membership.tenant_active:
        return authorize_resource_action(
            principal_subject=principal_subject,
            tenant_id=tenant_id,
            resource_type=resource_type,
            resource_id=resource_id,
            action=action,
            memberships=(membership,),
        )

    grants: tuple[ResourceGrant, ...] = ()
    if resource_type != "tenant":
        grant_rows = await _query(
            database,
            RESOURCE_GRANTS_SQL,
            (tenant_id, principal_subject, resource_type, resource_id),
            maximum=6,
        )
        try:
            returned_actions = [item.get("action") for item in grant_rows]
            if len(returned_actions) != len(set(returned_actions)):
                raise ValueError("duplicate resource grant actions")
            if any(
                item.get("subject") != principal_subject
                or item.get("tenant_id") != tenant_id
                or item.get("resource_type") != resource_type
                or item.get("resource_id") != resource_id
                for item in grant_rows
            ):
                raise ValueError("resource grant query returned an unexpected scope")
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

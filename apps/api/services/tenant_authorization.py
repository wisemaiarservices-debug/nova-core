"""Fail-closed, in-memory tenant authorization policy primitives.

This module evaluates grants only. It does not verify JWTs, establish identity,
load memberships from storage, or provide persistence enforcement. Callers must
supply a principal subject obtained from a separately verified identity adapter.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


Role = Literal["tenant_owner", "tenant_admin", "operator", "analyst", "viewer", "service"]
ResourceType = Literal[
    "tenant", "site", "asset", "source", "observation", "experiment",
    "dataset_snapshot", "audit_event", "membership",
]
Action = Literal["read", "create", "update", "delete", "ingest", "manage_members"]


ROLE_ACTIONS: dict[Role, frozenset[Action]] = {
    "tenant_owner": frozenset({"read", "create", "update", "delete", "ingest", "manage_members"}),
    "tenant_admin": frozenset({"read", "create", "update", "delete", "ingest"}),
    "operator": frozenset({"read", "ingest"}),
    "analyst": frozenset({"read"}),
    "viewer": frozenset({"read"}),
    "service": frozenset({"read", "ingest"}),
}


class TenantMembership(BaseModel):
    """Server-owned membership record; never accept this from a request body."""

    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=True)

    subject: str = Field(min_length=1, max_length=200)
    tenant_id: str = Field(min_length=1, max_length=120)
    role: Role
    active: bool = True
    tenant_active: bool


class ResourceGrant(BaseModel):
    """An explicit grant to one resource and a bounded set of actions."""

    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=True)

    subject: str = Field(min_length=1, max_length=200)
    tenant_id: str = Field(min_length=1, max_length=120)
    resource_type: ResourceType
    resource_id: str = Field(min_length=1, max_length=160)
    actions: tuple[Action, ...] = Field(min_length=1)

    @field_validator("resource_id")
    @classmethod
    def exact_resource_only(cls, value: str) -> str:
        if value == "*" or any(char in value for char in "*?"):
            raise ValueError("resource grants must identify one exact resource; wildcards are forbidden")
        return value

    @field_validator("actions")
    @classmethod
    def unique_actions(cls, value: tuple[Action, ...]) -> tuple[Action, ...]:
        if len(value) != len(set(value)):
            raise ValueError("resource grant actions must be unique")
        return value


class AuthorizationDecision(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    allowed: bool
    reason_code: Literal[
        "allowed", "missing_membership", "inactive_membership",
        "tenant_mismatch", "role_denied", "missing_resource_grant",
        "resource_action_denied",
    ]


def authorize_resource_action(
    *,
    principal_subject: str,
    tenant_id: str,
    resource_type: ResourceType,
    resource_id: str,
    action: Action,
    memberships: tuple[TenantMembership, ...],
    resource_grants: tuple[ResourceGrant, ...] = (),
) -> AuthorizationDecision:
    """Evaluate one request against trusted, server-loaded membership/grant records.

    The subject must come from verified authentication. The membership and grant
    tuples must come from trusted server-side storage. Client-provided tenant IDs
    and resource IDs are selectors only and never create entitlements.
    """
    if not principal_subject or not tenant_id or not resource_id:
        return AuthorizationDecision(allowed=False, reason_code="missing_membership")

    matching = tuple(
        item for item in memberships
        if item.subject == principal_subject and item.tenant_id == tenant_id
    )
    if len(matching) != 1:
        # No membership, or conflicting duplicate membership rows, both deny.
        # Deliberately do not distinguish another tenant's membership.
        return AuthorizationDecision(allowed=False, reason_code="missing_membership")

    active = tuple(item for item in matching if item.active and item.tenant_active)
    if not active:
        return AuthorizationDecision(allowed=False, reason_code="inactive_membership")

    roles = {item.role for item in active}
    permitted_by_role = any(action in ROLE_ACTIONS[role] for role in roles)
    if not permitted_by_role:
        return AuthorizationDecision(allowed=False, reason_code="role_denied")

    # Tenant-level resources are scoped to the tenant ID itself. All other
    # resources require an exact resource grant; there are no wildcard grants.
    if resource_type == "tenant":
        if resource_id != tenant_id:
            return AuthorizationDecision(allowed=False, reason_code="tenant_mismatch")
        return AuthorizationDecision(allowed=True, reason_code="allowed")

    matching_grants = tuple(
        grant for grant in resource_grants
        if grant.subject == principal_subject
        and grant.tenant_id == tenant_id
        and grant.resource_type == resource_type
        and grant.resource_id == resource_id
    )
    if not matching_grants:
        return AuthorizationDecision(allowed=False, reason_code="missing_resource_grant")

    if not any(action in grant.actions for grant in matching_grants):
        return AuthorizationDecision(allowed=False, reason_code="resource_action_denied")

    return AuthorizationDecision(allowed=True, reason_code="allowed")

"""Fail-closed, in-memory tenant authorization policy primitives.

This module evaluates grants only. It does not verify JWTs, establish identity,
load memberships from storage, or provide persistence enforcement. Callers must
supply a principal subject obtained from a separately verified identity adapter.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


Role = Literal["tenant_owner", "tenant_admin", "operator", "analyst", "viewer", "service"]
ResourceType = Literal[
    "tenant", "site", "asset", "source", "observation", "experiment",
    "dataset_snapshot", "audit_event", "membership",
]
Action = Literal["read", "create", "update", "delete", "ingest", "manage_members"]


RESOURCE_ACTIONS: dict[ResourceType, frozenset[Action]] = {
    "tenant": frozenset({"read", "update", "manage_members"}),
    "site": frozenset({"read", "create", "update", "delete"}),
    "asset": frozenset({"read", "create", "update", "delete"}),
    "source": frozenset({"read", "create", "update", "delete", "ingest"}),
    "observation": frozenset({"read", "delete"}),
    "experiment": frozenset({"read", "create", "update", "delete"}),
    "dataset_snapshot": frozenset({"read", "create", "delete"}),
    "audit_event": frozenset({"read"}),
    "membership": frozenset({"read", "create", "update", "delete", "manage_members"}),
}


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
    actions: tuple[Action, ...] = Field(min_length=1, max_length=6)

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

    @model_validator(mode="after")
    def actions_match_resource_type(self) -> "ResourceGrant":
        if set(self.actions) - RESOURCE_ACTIONS[self.resource_type]:
            raise ValueError("resource grant contains an action invalid for its resource type")
        if self.resource_type == "tenant" and self.resource_id != self.tenant_id:
            raise ValueError("tenant resource grant ID must equal tenant_id")
        return self


class AuthorizationDecision(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    allowed: bool
    reason_code: Literal[
        "allowed", "missing_membership", "inactive_membership",
        "tenant_mismatch", "role_denied", "missing_resource_grant",
        "resource_action_denied", "resource_action_invalid", "invalid_context",
    ]

    @model_validator(mode="after")
    def allowed_matches_reason(self) -> "AuthorizationDecision":
        if self.allowed != (self.reason_code == "allowed"):
            raise ValueError("allowed must be true exactly when reason_code is allowed")
        return self


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
    """Evaluate a request against trusted server-loaded membership/grant records.

    The subject must come from verified authentication. Membership and grants
    must come from trusted server-side storage. Caller-supplied tenant/resource
    IDs are selectors only and never create entitlements.
    """
    if (
        not isinstance(principal_subject, str) or not principal_subject.strip()
        or not isinstance(tenant_id, str) or not tenant_id.strip()
        or not isinstance(resource_id, str) or not resource_id.strip()
        or any(char in resource_id for char in "*?")
    ):
        return AuthorizationDecision(allowed=False, reason_code="invalid_context")

    allowed_actions = RESOURCE_ACTIONS.get(resource_type)
    if allowed_actions is None or action not in allowed_actions:
        return AuthorizationDecision(allowed=False, reason_code="resource_action_invalid")

    if not isinstance(memberships, (tuple, list)) or len(memberships) > 500:
        return AuthorizationDecision(allowed=False, reason_code="invalid_context")
    if not isinstance(resource_grants, (tuple, list)) or len(resource_grants) > 5000:
        return AuthorizationDecision(allowed=False, reason_code="invalid_context")
    if any(not isinstance(item, TenantMembership) for item in memberships):
        return AuthorizationDecision(allowed=False, reason_code="invalid_context")
    if any(not isinstance(item, ResourceGrant) for item in resource_grants):
        return AuthorizationDecision(allowed=False, reason_code="invalid_context")

    principal_subject = principal_subject.strip()
    tenant_id = tenant_id.strip()
    resource_id = resource_id.strip()

    matching = tuple(
        item for item in memberships
        if item.subject == principal_subject and item.tenant_id == tenant_id
    )
    if len(matching) != 1:
        # Missing or conflicting duplicate membership rows both deny.
        return AuthorizationDecision(allowed=False, reason_code="missing_membership")

    membership = matching[0]
    if not membership.active or not membership.tenant_active:
        return AuthorizationDecision(allowed=False, reason_code="inactive_membership")

    if action not in ROLE_ACTIONS[membership.role]:
        return AuthorizationDecision(allowed=False, reason_code="role_denied")

    # Tenant resources are scoped to the tenant ID itself. All other resources
    # require an exact grant; there are no wildcard grants.
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

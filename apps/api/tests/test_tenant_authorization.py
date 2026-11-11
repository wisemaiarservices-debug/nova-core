from __future__ import annotations

import pytest
from pydantic import ValidationError

from apps.api.services.tenant_authorization import (
    ResourceGrant,
    TenantMembership,
    authorize_resource_action,
)


def membership(subject: str = "user-a", tenant: str = "tenant-a", role: str = "operator", active: bool = True):
    return TenantMembership(subject=subject, tenant_id=tenant, role=role, active=active)


def grant(subject: str = "user-a", tenant: str = "tenant-a", resource: str = "site-1", actions=("read", "ingest")):
    return ResourceGrant(
        subject=subject,
        tenant_id=tenant,
        resource_type="site",
        resource_id=resource,
        actions=actions,
    )


def decide(*, action="read", subject="user-a", tenant="tenant-a", resource="site-1", memberships=(), grants=()):
    return authorize_resource_action(
        principal_subject=subject,
        tenant_id=tenant,
        resource_type="site",
        resource_id=resource,
        action=action,
        memberships=tuple(memberships),
        resource_grants=tuple(grants),
    )


def test_allows_exact_tenant_membership_role_and_resource_grant():
    result = decide(memberships=(membership(),), grants=(grant(),))
    assert result.allowed is True
    assert result.reason_code == "allowed"


def test_denies_unknown_or_cross_tenant_membership():
    result = decide(memberships=(membership(tenant="tenant-b"),), grants=(grant(),))
    assert result.allowed is False
    assert result.reason_code == "missing_membership"


def test_denies_inactive_membership():
    result = decide(memberships=(membership(active=False),), grants=(grant(),))
    assert result.reason_code == "inactive_membership"


def test_denies_role_action_escalation():
    result = decide(action="delete", memberships=(membership(role="viewer"),), grants=(grant(actions=("delete",)),))
    assert result.reason_code == "role_denied"


def test_denies_missing_exact_resource_grant():
    result = decide(memberships=(membership(),), grants=(grant(resource="site-2"),))
    assert result.reason_code == "missing_resource_grant"


def test_denies_resource_grant_action_escalation():
    result = decide(action="delete", memberships=(membership(role="tenant_admin"),), grants=(grant(actions=("read",)),))
    assert result.reason_code == "resource_action_denied"


def test_tenant_owner_can_access_only_own_tenant_resource():
    own = authorize_resource_action(
        principal_subject="owner",
        tenant_id="tenant-a",
        resource_type="tenant",
        resource_id="tenant-a",
        action="manage_members",
        memberships=(membership(subject="owner", role="tenant_owner"),),
    )
    other = authorize_resource_action(
        principal_subject="owner",
        tenant_id="tenant-a",
        resource_type="tenant",
        resource_id="tenant-b",
        action="read",
        memberships=(membership(subject="owner", role="tenant_owner"),),
    )
    assert own.allowed is True
    assert other.allowed is False
    assert other.reason_code == "tenant_mismatch"


def test_service_role_still_requires_exact_source_grant():
    result = authorize_resource_action(
        principal_subject="producer-1",
        tenant_id="tenant-a",
        resource_type="source",
        resource_id="source-1",
        action="ingest",
        memberships=(membership(subject="producer-1", role="service"),),
        resource_grants=(ResourceGrant(
            subject="producer-1", tenant_id="tenant-a", resource_type="source",
            resource_id="source-2", actions=("ingest",),
        ),),
    )
    assert result.reason_code == "missing_resource_grant"


def test_duplicate_resource_actions_are_rejected():
    with pytest.raises(ValidationError):
        ResourceGrant(
            subject="user-a", tenant_id="tenant-a", resource_type="site",
            resource_id="site-1", actions=("read", "read"),
        )


def test_no_wildcard_resource_grants():
    with pytest.raises(ValidationError):
        ResourceGrant(
            subject="user-a", tenant_id="tenant-a", resource_type="site",
            resource_id="*", actions=("read",),
        )

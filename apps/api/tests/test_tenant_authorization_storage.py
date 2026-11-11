from __future__ import annotations

import asyncio
import pytest

from apps.api.services.tenant_authorization_storage import (
    MEMBERSHIP_SQL,
    RESOURCE_GRANTS_SQL,
    TenantAuthorizationStorageError,
    authorize_tenant_resource_action,
)


class Result:
    def __init__(self, results):
        self.results = results


class Statement:
    def __init__(self, database, sql):
        self.database = database
        self.sql = sql
        self.parameters = ()

    def bind(self, *parameters):
        self.parameters = parameters
        return self

    async def run(self):
        self.database.calls.append((self.sql, self.parameters))
        if self.database.error:
            raise RuntimeError("private database details")
        if self.sql == MEMBERSHIP_SQL:
            subject, tenant_id = self.parameters
            return Result([
                row for row in self.database.memberships
                if row["subject"] == subject and row["tenant_id"] == tenant_id
            ])
        if self.sql == RESOURCE_GRANTS_SQL:
            tenant_id, subject, resource_type, resource_id = self.parameters
            return Result([
                row for row in self.database.grants
                if row["tenant_id"] == tenant_id
                and row["subject"] == subject
                and row["resource_type"] == resource_type
                and row["resource_id"] == resource_id
            ])
        raise AssertionError("unexpected SQL statement")


class FakeDatabase:
    def __init__(self, memberships=(), grants=(), error=False):
        self.memberships = list(memberships)
        self.grants = list(grants)
        self.error = error
        self.calls = []

    def prepare(self, sql):
        return Statement(self, sql)


def member(tenant="tenant-a", subject="subject-a", role="operator", status="active", tenant_status="active"):
    return {
        "subject": subject,
        "tenant_id": tenant,
        "role": role,
        "membership_status": status,
        "tenant_status": tenant_status,
    }


def grant(tenant="tenant-a", subject="subject-a", resource="site-a", action="read"):
    return {
        "subject": subject,
        "tenant_id": tenant,
        "resource_type": "site",
        "resource_id": resource,
        "action": action,
    }


def test_loads_membership_and_exact_resource_grants():
    db = FakeDatabase(memberships=[member()], grants=[grant()])
    result = asyncio.run(authorize_tenant_resource_action(
        db,
        principal_subject="subject-a",
        tenant_id="tenant-a",
        resource_type="site",
        resource_id="site-a",
        action="read",
    ))
    assert result.allowed is True
    assert db.calls[0] == (MEMBERSHIP_SQL, ("subject-a", "tenant-a"))
    assert db.calls[1] == (RESOURCE_GRANTS_SQL, ("tenant-a", "subject-a", "site", "site-a"))


def test_cross_tenant_selector_cannot_reuse_other_tenant_membership():
    db = FakeDatabase(memberships=[member(tenant="tenant-a")], grants=[grant(tenant="tenant-a")])
    result = asyncio.run(authorize_tenant_resource_action(
        db,
        principal_subject="subject-a",
        tenant_id="tenant-b",
        resource_type="site",
        resource_id="site-a",
        action="read",
    ))
    assert result.allowed is False
    assert result.reason_code == "missing_membership"
    assert len(db.calls) == 1


def test_suspended_tenant_is_denied_before_grant_lookup():
    db = FakeDatabase(memberships=[member(tenant_status="suspended")], grants=[grant()])
    result = asyncio.run(authorize_tenant_resource_action(
        db,
        principal_subject="subject-a",
        tenant_id="tenant-a",
        resource_type="site",
        resource_id="site-a",
        action="read",
    ))
    assert result.allowed is False
    assert result.reason_code == "inactive_membership"
    assert len(db.calls) == 1


def test_duplicate_membership_rows_fail_closed():
    db = FakeDatabase(memberships=[member(), member(role="tenant_owner")], grants=[grant()])
    result = asyncio.run(authorize_tenant_resource_action(
        db,
        principal_subject="subject-a",
        tenant_id="tenant-a",
        resource_type="site",
        resource_id="site-a",
        action="read",
    ))
    assert result.allowed is False
    assert result.reason_code == "missing_membership"
    assert len(db.calls) == 1


def test_tenant_resource_requires_exact_tenant_identifier():
    db = FakeDatabase(memberships=[member()])
    own = asyncio.run(authorize_tenant_resource_action(
        db,
        principal_subject="subject-a",
        tenant_id="tenant-a",
        resource_type="tenant",
        resource_id="tenant-a",
        action="read",
    ))
    other = asyncio.run(authorize_tenant_resource_action(
        db,
        principal_subject="subject-a",
        tenant_id="tenant-a",
        resource_type="tenant",
        resource_id="tenant-b",
        action="read",
    ))
    assert own.allowed is True
    assert other.allowed is False
    assert len(db.calls) == 2


def test_database_failure_raises_generic_fail_closed_error():
    db = FakeDatabase(error=True)
    with pytest.raises(TenantAuthorizationStorageError, match="storage is unavailable"):
        asyncio.run(authorize_tenant_resource_action(
            db,
            principal_subject="subject-a",
            tenant_id="tenant-a",
            resource_type="site",
            resource_id="site-a",
            action="read",
        ))


def test_missing_database_fails_closed():
    with pytest.raises(TenantAuthorizationStorageError):
        asyncio.run(authorize_tenant_resource_action(
            None,
            principal_subject="subject-a",
            tenant_id="tenant-a",
            resource_type="site",
            resource_id="site-a",
            action="read",
        ))

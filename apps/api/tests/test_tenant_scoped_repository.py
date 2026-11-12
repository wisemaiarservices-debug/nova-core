from __future__ import annotations

import asyncio

from apps.api.services.tenant_scoped_repository import (
    RESOURCE_SELECTS,
    read_authorized_tenant_resource,
)
from apps.api.services.tenant_authorization_storage import MEMBERSHIP_SQL, RESOURCE_GRANTS_SQL


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
        if self.sql == MEMBERSHIP_SQL:
            subject, tenant = self.parameters
            return Result([row for row in self.database.memberships
                           if row["subject"] == subject and row["tenant_id"] == tenant])
        if self.sql == RESOURCE_GRANTS_SQL:
            tenant, subject, resource_type, resource_id = self.parameters
            return Result([row for row in self.database.grants
                           if row["tenant_id"] == tenant and row["subject"] == subject
                           and row["resource_type"] == resource_type and row["resource_id"] == resource_id])
        if self.sql in RESOURCE_SELECTS.values():
            tenant, resource_id = self.parameters
            return Result([row for row in self.database.resources.get(self.sql, [])
                           if row["tenant_id"] == tenant and row["id"] == resource_id])
        raise AssertionError("unexpected query")


class FakeDatabase:
    def __init__(self, memberships=(), grants=(), resources=None):
        self.memberships = list(memberships)
        self.grants = list(grants)
        self.resources = resources or {}
        self.calls = []

    def prepare(self, sql):
        return Statement(self, sql)


def membership():
    return {"subject": "subject-a", "tenant_id": "tenant-a", "role": "viewer",
            "membership_status": "active", "tenant_status": "active"}


def grant():
    return {"subject": "subject-a", "tenant_id": "tenant-a", "resource_type": "site",
            "resource_id": "site-a", "action": "read"}


def test_read_requires_membership_and_exact_grant_before_scoped_query():
    resource = {"id": "site-a", "tenant_id": "tenant-a", "name": "Research site"}
    db = FakeDatabase(
        memberships=[membership()],
        grants=[grant()],
        resources={RESOURCE_SELECTS["site"]: [resource]},
    )
    result = asyncio.run(read_authorized_tenant_resource(
        db, principal_subject="subject-a", tenant_id="tenant-a",
        resource_type="site", resource_id="site-a",
    ))
    assert result == resource
    assert db.calls[-1] == (RESOURCE_SELECTS["site"], ("tenant-a", "site-a"))


def test_cross_tenant_read_returns_same_not_found_result_without_resource_query():
    resource = {"id": "site-a", "tenant_id": "tenant-a", "name": "Research site"}
    db = FakeDatabase(
        memberships=[membership()],
        grants=[grant()],
        resources={RESOURCE_SELECTS["site"]: [resource]},
    )
    result = asyncio.run(read_authorized_tenant_resource(
        db, principal_subject="subject-a", tenant_id="tenant-b",
        resource_type="site", resource_id="site-a",
    ))
    assert result is None
    assert len(db.calls) == 1
    assert db.calls[0] == (MEMBERSHIP_SQL, ("subject-a", "tenant-b"))


def test_missing_resource_grant_does_not_query_resource_table():
    db = FakeDatabase(memberships=[membership()], grants=[])
    result = asyncio.run(read_authorized_tenant_resource(
        db, principal_subject="subject-a", tenant_id="tenant-a",
        resource_type="site", resource_id="site-a",
    ))
    assert result is None
    assert len(db.calls) == 2
    assert db.calls[-1][0] == RESOURCE_GRANTS_SQL


def test_repository_never_returns_another_tenants_row():
    resource = {"id": "site-a", "tenant_id": "tenant-b", "name": "Other tenant"}
    db = FakeDatabase(
        memberships=[membership()],
        grants=[grant()],
        resources={RESOURCE_SELECTS["site"]: [resource]},
    )
    result = asyncio.run(read_authorized_tenant_resource(
        db, principal_subject="subject-a", tenant_id="tenant-a",
        resource_type="site", resource_id="site-a",
    ))
    assert result is None


def test_missing_resource_returns_none_after_authorized_lookup():
    db = FakeDatabase(memberships=[membership()], grants=[grant()])
    result = asyncio.run(read_authorized_tenant_resource(
        db, principal_subject="subject-a", tenant_id="tenant-a",
        resource_type="site", resource_id="site-a",
    ))
    assert result is None


def test_every_resource_projection_includes_tenant_id_for_defensive_check():
    for statement in RESOURCE_SELECTS.values():
        projection = statement.split("FROM", 1)[0]
        assert "tenant_id" in [column.strip() for column in projection.replace("SELECT", "", 1).split(",")]

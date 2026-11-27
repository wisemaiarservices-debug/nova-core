from __future__ import annotations

import asyncio
import pytest

from apps.api.services.tenant_scoped_repository import (
    RESOURCE_SELECTS,
    read_authorized_tenant_resource,
)
from apps.api.services.tenant_authorization_storage import MEMBERSHIP_SQL, RESOURCE_GRANTS_SQL


class JsProxy:
    def __init__(self, value):
        self.value = value

    def to_py(self):
        if isinstance(self.value, list):
            return [JsProxy(item) if isinstance(item, dict) else item for item in self.value]
        return dict(self.value) if isinstance(self.value, dict) else self.value


class Result:
    def __init__(self, results, success=True, proxy=False):
        self.results = JsProxy(results) if proxy else results
        self.success = JsProxy(success) if proxy else success


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
                           if row["subject"] == subject and row["tenant_id"] == tenant],
                          proxy=self.database.pyodide_results)
        if self.sql == RESOURCE_GRANTS_SQL:
            tenant, subject, resource_type, resource_id = self.parameters
            return Result([row for row in self.database.grants
                           if row["tenant_id"] == tenant and row["subject"] == subject
                           and row["resource_type"] == resource_type and row["resource_id"] == resource_id], proxy=self.database.pyodide_results)
        if self.sql in RESOURCE_SELECTS.values():
            if self.database.resource_error:
                raise RuntimeError("private resource database details")
            tenant, resource_id = self.parameters
            if self.database.resource_override is not None:
                return Result(self.database.resource_override, success=self.database.resource_success, proxy=self.database.pyodide_results)
            return Result([row for row in self.database.resources.get(self.sql, [])
                           if row["tenant_id"] == tenant and row["id"] == resource_id],
                          success=self.database.resource_success, proxy=self.database.pyodide_results)
        raise AssertionError("unexpected query")


class FakeDatabase:
    def __init__(self, memberships=(), grants=(), resources=None,
                 resource_success=True, resource_error=False, resource_override=None, pyodide_results=False):
        self.memberships = list(memberships)
        self.grants = list(grants)
        self.resources = resources or {}
        self.resource_success = resource_success
        self.resource_error = resource_error
        self.resource_override = resource_override
        self.pyodide_results = pyodide_results
        self.calls = []

    def prepare(self, sql):
        return Statement(self, sql)


def membership():
    return {"subject": "subject-a", "tenant_id": "tenant-a", "role": "viewer",
            "membership_status": "active", "tenant_status": "active"}


def grant():
    return {"subject": "subject-a", "tenant_id": "tenant-a", "resource_type": "site",
            "resource_id": "site-a", "action": "read"}



def test_repository_normalizes_pyodide_d1_result_proxies():
    resource = {"id": "site-a", "tenant_id": "tenant-a", "name": "Research site"}
    db = FakeDatabase(
        memberships=[membership()],
        grants=[grant()],
        resources={RESOURCE_SELECTS["site"]: [resource]},
        pyodide_results=True,
    )
    result = asyncio.run(read_authorized_tenant_resource(
        db, principal_subject="subject-a", tenant_id="tenant-a",
        resource_type="site", resource_id="site-a",
    ))
    assert result == resource


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



def test_invalid_selectors_do_not_reach_database_or_resource_query():
    db = FakeDatabase(memberships=[membership()], grants=[grant()])
    import pytest
    with pytest.raises(ValueError, match="resource type"):
        asyncio.run(read_authorized_tenant_resource(
            db, principal_subject="subject-a", tenant_id="tenant-a",
            resource_type=[], resource_id="site-a",
        ))
    assert db.calls == []

    result = asyncio.run(read_authorized_tenant_resource(
        db, principal_subject="subject-a", tenant_id="tenant-a",
        resource_type="site", resource_id=" " * 3,
    ))
    assert result is None
    assert db.calls == []


def test_database_resource_failure_is_generic_and_fail_closed():
    db = FakeDatabase(
        memberships=[membership()], grants=[grant()],
        resource_error=True,
    )
    import pytest
    from apps.api.services.tenant_authorization_storage import TenantAuthorizationStorageError
    with pytest.raises(TenantAuthorizationStorageError, match="resource storage is unavailable"):
        asyncio.run(read_authorized_tenant_resource(
            db, principal_subject="subject-a", tenant_id="tenant-a",
            resource_type="site", resource_id="site-a",
        ))


@pytest.mark.parametrize("resource_success", [False, None])
def test_unsuccessful_or_incomplete_d1_resource_result_fails_closed(resource_success):
    db = FakeDatabase(
        memberships=[membership()], grants=[grant()],
        resource_success=resource_success,
    )
    from apps.api.services.tenant_authorization_storage import TenantAuthorizationStorageError
    with pytest.raises(TenantAuthorizationStorageError, match="unsuccessful or incomplete"):
        asyncio.run(read_authorized_tenant_resource(
            db, principal_subject="subject-a", tenant_id="tenant-a",
            resource_type="site", resource_id="site-a",
        ))


def test_repository_rejects_multiple_rows_despite_limit_one():
    rows = [
        {"id": "site-a", "tenant_id": "tenant-a", "name": "A"},
        {"id": "site-a", "tenant_id": "tenant-a", "name": "B"},
    ]
    db = FakeDatabase(
        memberships=[membership()], grants=[grant()],
        resource_override=rows,
    )
    import pytest
    from apps.api.services.tenant_authorization_storage import TenantAuthorizationStorageError
    with pytest.raises(TenantAuthorizationStorageError, match="invalid result"):
        asyncio.run(read_authorized_tenant_resource(
            db, principal_subject="subject-a", tenant_id="tenant-a",
            resource_type="site", resource_id="site-a",
        ))


def test_repository_drops_unselected_columns_from_storage_result():
    row = {
        "id": "site-a", "tenant_id": "tenant-a", "name": "Research site",
        "secret_internal_column": "must-not-escape",
    }
    db = FakeDatabase(
        memberships=[membership()], grants=[grant()],
        resources={RESOURCE_SELECTS["site"]: [row]},
    )
    result = asyncio.run(read_authorized_tenant_resource(
        db, principal_subject="subject-a", tenant_id="tenant-a",
        resource_type="site", resource_id="site-a",
    ))
    assert result == {"id": "site-a", "tenant_id": "tenant-a", "name": "Research site"}
    assert "secret_internal_column" not in result


def test_whitespace_around_authorized_selectors_is_normalized_once():
    row = {"id": "site-a", "tenant_id": "tenant-a", "name": "Research site"}
    db = FakeDatabase(
        memberships=[membership()], grants=[grant()],
        resources={RESOURCE_SELECTS["site"]: [row]},
    )
    result = asyncio.run(read_authorized_tenant_resource(
        db, principal_subject=" subject-a ", tenant_id=" tenant-a ",
        resource_type="site", resource_id=" site-a ",
    ))
    assert result == row
    assert db.calls[-1] == (RESOURCE_SELECTS["site"], ("tenant-a", "site-a"))

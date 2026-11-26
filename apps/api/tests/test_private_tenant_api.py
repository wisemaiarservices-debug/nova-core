from __future__ import annotations

import base64
import hashlib
import hmac
import json
import sqlite3
from pathlib import Path

import pytest

from apps.api.services.tenant_request_replay import NONCE_INSERT_SQL
from apps.api.services.tenant_authorization_storage import MEMBERSHIP_SQL, RESOURCE_GRANTS_SQL
from apps.api.services.tenant_scoped_repository import RESOURCE_SELECTS
from apps.api.tenant_main import resolve_private_tenant_read

ROOT = Path(__file__).resolve().parents[1]
NOW = 1_800_000_000
SECRET = "private-tenant-test-secret-material-32-bytes-minimum"
KEY_ID = "gateway-key-2026-11"
ISSUER = "nova-core-tenant-gateway"
AUDIENCE = "nova-core-private-tenant-api"
SUBJECT = "access-subject-123456"
PATH = "/api/v1/tenants/tenant-a/sites/site-a"


def b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def signed_assertion(path=PATH, *, method="GET", subject=SUBJECT, jti="private-request-id-00001"):
    header = {"alg": "HS256", "typ": "NOVA-Internal-Request", "kid": KEY_ID}
    claims = {
        "iss": ISSUER,
        "aud": AUDIENCE,
        "sub": subject,
        "iat": NOW - 5,
        "exp": NOW + 55,
        "jti": jti,
        "method": method,
        "path": path,
    }
    protected = b64url(json.dumps(header, separators=(",", ":")).encode())
    payload = b64url(json.dumps(claims, separators=(",", ":")).encode())
    signing_input = f"{protected}.{payload}"
    signature = hmac.new(SECRET.encode(), signing_input.encode(), hashlib.sha256).digest()
    return f"{signing_input}.{b64url(signature)}"


class D1Result:
    def __init__(self, results, success=True):
        self.results = results
        self.success = success


class D1Statement:
    def __init__(self, database, sql):
        self.database = database
        self.sql = sql
        self.parameters = ()

    def bind(self, *parameters):
        self.parameters = parameters
        return self

    async def run(self):
        self.database.calls.append((self.sql, self.parameters))
        cursor = self.database.connection.execute(self.sql, self.parameters)
        rows = [dict(row) for row in cursor.fetchall()] if cursor.description else []
        self.database.connection.commit()
        return D1Result(rows)


class SQLiteD1:
    def __init__(self):
        self.connection = sqlite3.connect(":memory:")
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA foreign_keys = ON")
        for migration in (
            "0001_initial.sql",
            "0002_tenant_isolation.sql",
            "0003_internal_request_nonces.sql",
        ):
            self.connection.executescript(
                (ROOT / "migrations" / migration).read_text(encoding="utf-8")
            )
        self.connection.executescript("""
            INSERT INTO tenants (id, display_name, status)
            VALUES ('tenant-a', 'Tenant A', 'active');
            INSERT INTO tenant_memberships (id, tenant_id, subject, role, status)
            VALUES ('membership-a', 'tenant-a', 'access-subject-123456', 'viewer', 'active');
            INSERT INTO tenant_resource_grants
              (id, tenant_id, subject, resource_type, resource_id, action)
            VALUES ('grant-a', 'tenant-a', 'access-subject-123456', 'site', 'site-a', 'read');
            INSERT INTO sites (id, tenant_id, name)
            VALUES ('site-a', 'tenant-a', 'Research site');
        """)
        self.connection.commit()
        self.calls = []

    def prepare(self, sql):
        return D1Statement(self, sql)

    def close(self):
        self.connection.close()


def env(database=None):
    return {
        "DB": database,
        "NOVA_INTERNAL_KEY_ID": KEY_ID,
        "NOVA_INTERNAL_HMAC_KEY": SECRET,
        "NOVA_INTERNAL_ISSUER": ISSUER,
        "NOVA_INTERNAL_AUDIENCE": AUDIENCE,
    }


def call(db, token=None, *, path=PATH, tenant="tenant-a", collection="sites", resource="site-a", method="GET"):
    token = signed_assertion(path) if token is None else token
    return resolve_private_tenant_read(
        method=method,
        raw_path=path,
        authorization_values=[f"Bearer {token}".encode("ascii")],
        env=env(db),
        tenant_id=tenant,
        resource_collection=collection,
        resource_id=resource,
        now=NOW,
    )


def test_private_read_runs_verification_nonce_authorization_and_scoped_read_in_order():
    db = SQLiteD1()
    result = __import__("asyncio").run(call(db))
    assert result["id"] == "site-a"
    assert result["tenant_id"] == "tenant-a"
    assert result["name"] == "Research site"
    assert [entry[0] for entry in db.calls] == [
        NONCE_INSERT_SQL,
        MEMBERSHIP_SQL,
        RESOURCE_GRANTS_SQL,
        RESOURCE_SELECTS["site"],
    ]
    assert db.connection.execute(
        "SELECT COUNT(*) FROM internal_request_nonces"
    ).fetchone()[0] == 1
    db.close()


def test_same_signed_request_is_rejected_on_second_use_before_authorization():
    db = SQLiteD1()
    token = signed_assertion()
    first = __import__("asyncio").run(call(db, token))
    call_count = len(db.calls)
    second = __import__("asyncio").run(call(db, token))
    assert first is not None
    assert second is None
    assert len(db.calls) == call_count + 1
    assert db.calls[-1][0] == NONCE_INSERT_SQL
    db.close()


def test_cross_tenant_membership_and_grant_cannot_be_reused():
    db = SQLiteD1()
    path = "/api/v1/tenants/tenant-b/sites/site-a"
    result = __import__("asyncio").run(
        call(db, signed_assertion(path, jti="private-request-id-00002"),
             path=path, tenant="tenant-b")
    )
    assert result is None
    assert [entry[0] for entry in db.calls] == [NONCE_INSERT_SQL, MEMBERSHIP_SQL]
    db.close()


def test_invalid_signature_and_path_binding_fail_before_nonce_storage():
    db = SQLiteD1()
    token = signed_assertion()
    tampered = token[:-1] + ("A" if token[-1] != "A" else "B")
    with pytest.raises(Exception, match="internal assertion rejected"):
        __import__("asyncio").run(call(db, tampered))
    path = PATH + "?tenant=tenant-b"
    with pytest.raises(Exception, match="internal assertion rejected"):
        __import__("asyncio").run(call(db, signed_assertion(path), path=path))
    assert db.calls == []
    db.close()


def test_duplicate_authorization_headers_and_non_get_requests_are_rejected():
    db = SQLiteD1()
    token = signed_assertion()
    with pytest.raises(Exception, match="internal assertion rejected"):
        __import__("asyncio").run(resolve_private_tenant_read(
            method="GET", raw_path=PATH,
            authorization_values=[f"Bearer {token}".encode(), f"Bearer {token}".encode()],
            env=env(db), tenant_id="tenant-a", resource_collection="sites",
            resource_id="site-a", now=NOW,
        ))
    with pytest.raises(Exception, match="internal assertion rejected"):
        __import__("asyncio").run(call(db, signed_assertion(method="POST"), method="POST"))
    assert db.calls == []
    db.close()


def test_missing_or_duplicate_authorization_is_rejected_before_database_access():
    db = SQLiteD1()
    with pytest.raises(Exception, match="internal assertion rejected"):
        __import__("asyncio").run(resolve_private_tenant_read(
            method="GET", raw_path=PATH, authorization_values=[],
            env=env(db), tenant_id="tenant-a", resource_collection="sites",
            resource_id="site-a", now=NOW,
        ))
    assert db.calls == []
    db.close()


def test_missing_database_binding_fails_closed():
    with pytest.raises(Exception, match="storage is unavailable"):
        __import__("asyncio").run(resolve_private_tenant_read(
            method="GET", raw_path=PATH,
            authorization_values=[f"Bearer {signed_assertion()}".encode()],
            env=env(None), tenant_id="tenant-a", resource_collection="sites",
            resource_id="site-a", now=NOW,
        ))


def test_missing_exact_resource_grant_returns_no_resource():
    db = SQLiteD1()
    db.connection.execute("DELETE FROM tenant_resource_grants")
    db.connection.commit()
    result = __import__("asyncio").run(call(db))
    assert result is None
    assert db.calls[-1][0] == RESOURCE_GRANTS_SQL
    assert RESOURCE_SELECTS["site"] not in [entry[0] for entry in db.calls]
    db.close()


def test_unknown_resource_collection_is_rejected_before_storage():
    db = SQLiteD1()
    with pytest.raises(Exception, match="internal assertion rejected"):
        __import__("asyncio").run(resolve_private_tenant_read(
            method="GET", raw_path="/api/v1/tenants/tenant-a/memberships/member-a",
            authorization_values=[f"Bearer {signed_assertion()}".encode()],
            env=env(db), tenant_id="tenant-a", resource_collection="memberships",
            resource_id="member-a", now=NOW,
        ))
    assert db.calls == []
    db.close()

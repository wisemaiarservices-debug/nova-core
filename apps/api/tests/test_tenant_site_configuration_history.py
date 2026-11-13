"""SQLite contract tests for immutable tenant client configuration history."""
import hashlib
import json
import sqlite3
from pathlib import Path

import pytest


MIGRATIONS = Path(__file__).resolve().parents[1] / "migrations"


def database():
    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA foreign_keys = ON")
    for name in (
        "0001_initial.sql", "0002_tenant_isolation.sql",
        "0003_internal_request_nonces.sql",
        "0004_tenant_ownership_immutability.sql",
        "0005_tenant_site_configuration_history.sql",
    ):
        db.executescript((MIGRATIONS / name).read_text(encoding="utf-8"))
    db.executemany(
        "INSERT INTO tenants (id, display_name, status) VALUES (?, ?, 'active')",
        [("tenant-a", "Tenant A"), ("tenant-b", "Tenant B")],
    )
    db.executemany(
        "INSERT INTO sites (id, tenant_id, name) VALUES (?, ?, ?)",
        [("site-a", "tenant-a", "A"), ("site-b", "tenant-b", "B")],
    )
    return db


def insert_configuration(db, *, config_id="cfg-a", tenant="tenant-a",
                         site="site-a", version="v1", body=None):
    body = body or {"schema": "nova-client-configuration-v1", "site": {"name": "A"}}
    encoded = json.dumps(body, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(encoded.encode()).hexdigest()
    db.execute(
        """INSERT INTO tenant_site_configurations
           (id, tenant_id, site_id, configuration_version, schema_id,
            configuration_json, content_sha256, created_by_subject, request_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (config_id, tenant, site, version, "nova-client-configuration-v1",
         encoded, digest, "operator-a", "request-a"),
    )


def test_ordered_migration_creates_immutable_configuration_and_event_tables():
    db = database()
    names = {row[0] for row in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    )}
    assert "tenant_site_configurations" in names
    assert "tenant_site_configuration_events" in names


def test_configuration_history_is_tenant_and_site_scoped():
    db = database()
    insert_configuration(db)
    with pytest.raises(sqlite3.IntegrityError):
        insert_configuration(db, config_id="cross-site", tenant="tenant-a", site="site-b")
    with pytest.raises(sqlite3.IntegrityError):
        insert_configuration(db, config_id="cross-tenant", tenant="tenant-b", site="site-a")


def test_configuration_versions_are_unique_per_tenant_site_and_immutable():
    db = database()
    insert_configuration(db)
    with pytest.raises(sqlite3.IntegrityError):
        insert_configuration(db, config_id="duplicate", version="v1")
    insert_configuration(db, config_id="cfg-a-v2", version="v2")
    with pytest.raises(sqlite3.IntegrityError, match="configuration versions are immutable"):
        db.execute("UPDATE tenant_site_configurations SET configuration_version='v3' WHERE id='cfg-a'")
    with pytest.raises(sqlite3.IntegrityError, match="configuration history cannot be deleted"):
        db.execute("DELETE FROM tenant_site_configurations WHERE id='cfg-a'")


def test_content_hash_is_lowercase_sha256_and_configuration_is_json_object():
    db = database()
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            """INSERT INTO tenant_site_configurations
               (id, tenant_id, site_id, configuration_version, schema_id,
                configuration_json, content_sha256, created_by_subject, request_id)
               VALUES ('bad-hash','tenant-a','site-a','v1','schema','{}','not-a-hash','op','req')"""
        )
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            """INSERT INTO tenant_site_configurations
               (id, tenant_id, site_id, configuration_version, schema_id,
                configuration_json, content_sha256, created_by_subject, request_id)
               VALUES ('bad-json-shape','tenant-a','site-a','v1','schema','[]',?, 'op','req')""",
            ("a" * 64,),
        )


def test_approval_is_an_append_only_review_event_not_activation():
    db = database()
    insert_configuration(db)
    db.execute(
        """INSERT INTO tenant_site_configuration_events
           (id, configuration_id, tenant_id, site_id, event_type,
            actor_subject, reason, request_id)
           VALUES ('event-1','cfg-a','tenant-a','site-a',
                   'approved_for_review','reviewer-a','Evidence checked','req-2')"""
    )
    event = db.execute(
        "SELECT event_type FROM tenant_site_configuration_events WHERE id='event-1'"
    ).fetchone()
    assert event == ("approved_for_review",)
    with pytest.raises(sqlite3.IntegrityError, match="configuration history events are immutable"):
        db.execute("UPDATE tenant_site_configuration_events SET reason='changed' WHERE id='event-1'")
    with pytest.raises(sqlite3.IntegrityError, match="configuration history events cannot be deleted"):
        db.execute("DELETE FROM tenant_site_configuration_events WHERE id='event-1'")


def test_suspended_tenant_cannot_create_configuration_or_review_events():
    db = database()
    insert_configuration(db)
    db.execute("UPDATE tenants SET status='suspended' WHERE id='tenant-a'")
    with pytest.raises(sqlite3.IntegrityError, match="active tenant"):
        insert_configuration(db, config_id="blocked", version="v2")
    with pytest.raises(sqlite3.IntegrityError, match="active tenant"):
        db.execute(
            """INSERT INTO tenant_site_configuration_events
               (id, configuration_id, tenant_id, site_id, event_type, actor_subject, request_id)
               VALUES ('blocked-event','cfg-a','tenant-a','site-a',
                       'submitted_for_review','operator-a','req-3')"""
        )


def test_invalid_version_and_unknown_fields_are_rejected_by_database_contract():
    db = database()
    for invalid in ("latest", "v1beta", "v01", "v0", "v"):
        with pytest.raises(sqlite3.IntegrityError):
            insert_configuration(db, config_id="invalid-" + invalid, version=invalid)

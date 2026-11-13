import re
import sqlite3

import pytest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
APPS_ROOT = ROOT.parent
TENANT_API = APPS_ROOT / "tenant-api" / "src" / "index.mjs"
MIGRATIONS = ROOT / "migrations"


def test_private_tenant_api_sql_compiles_against_ordered_schema_migrations():
    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA foreign_keys = ON")
    for migration in (
        MIGRATIONS / "0001_initial.sql",
        MIGRATIONS / "0002_tenant_isolation.sql",
        MIGRATIONS / "0003_internal_request_nonces.sql",
        MIGRATIONS / "0004_tenant_ownership_immutability.sql",
        MIGRATIONS / "0005_tenant_site_configuration_history.sql",
        MIGRATIONS / "0006_site_configuration_idempotency.sql",
        MIGRATIONS / "0007_water_quality_criteria_registry.sql",
        MIGRATIONS / "0008_water_quality_criteria_reviewer_events.sql",
    ):
        db.executescript(migration.read_text(encoding="utf-8"))

    source = TENANT_API.read_text(encoding="utf-8")
    statements = re.findall(r'"((?:SELECT|INSERT INTO)\s+[^"]+)"', source)
    assert len(statements) >= 8, "expected resource, membership, grant and nonce SQL"

    for statement in statements:
        placeholders = statement.count("?")
        db.execute("EXPLAIN " + statement, [None] * placeholders).fetchall()


def test_private_tenant_api_has_all_five_resource_queries():
    source = TENANT_API.read_text(encoding="utf-8")
    for table in ("sites", "assets", "sources", "observations", "audit_events"):
        assert re.search(rf"FROM {table} WHERE tenant_id = \? AND id = \?", source)


def _migrated_tenant_db():
    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA foreign_keys = ON")
    for migration in (
        MIGRATIONS / "0001_initial.sql",
        MIGRATIONS / "0002_tenant_isolation.sql",
        MIGRATIONS / "0003_internal_request_nonces.sql",
        MIGRATIONS / "0004_tenant_ownership_immutability.sql",
        MIGRATIONS / "0005_tenant_site_configuration_history.sql",
        MIGRATIONS / "0006_site_configuration_idempotency.sql",
        MIGRATIONS / "0007_water_quality_criteria_registry.sql",
    ):
        db.executescript(migration.read_text(encoding="utf-8"))
    return db


def _seed_two_tenants(db):
    db.executemany(
        "INSERT INTO tenants (id, display_name, status) VALUES (?, ?, 'active')",
        [("tenant-a", "Tenant A"), ("tenant-b", "Tenant B")],
    )
    db.executemany(
        "INSERT INTO sites (id, tenant_id, name) VALUES (?, ?, ?)",
        [("site-a", "tenant-a", "A site"), ("site-a2", "tenant-a", "A site 2"),
         ("site-b", "tenant-b", "B site")],
    )
    db.executemany(
        "INSERT INTO assets (id, tenant_id, site_id, name, asset_type) VALUES (?, ?, ?, ?, ?)",
        [("asset-a", "tenant-a", "site-a", "A pump", "pump"),
         ("asset-b", "tenant-b", "site-b", "B pump", "pump")],
    )
    db.executemany(
        "INSERT INTO sources (id, tenant_id, site_id, module, provider, source_type, display_name) "
        "VALUES (?, ?, ?, 'neoagro', 'fixture', 'sensor', ?)",
        [("source-a", "tenant-a", "site-a", "A sensor"),
         ("source-b", "tenant-b", "site-b", "B sensor")],
    )
    db.executemany(
        "INSERT INTO observations (id, tenant_id, site_id, asset_id, source_id, module, metric, "
        "value, unit, observed_at, idempotency_key, provenance_json) "
        "VALUES (?, ?, ?, ?, ?, 'neoagro', 'soil_moisture', 0.25, 'm3/m3', "
        "'2026-11-12T10:00:00Z', ?, '{}')",
        [("obs-a", "tenant-a", "site-a", "asset-a", "source-a", "key-a"),
         ("obs-b", "tenant-b", "site-b", "asset-b", "source-b", "key-b")],
    )
    db.executemany(
        "INSERT INTO audit_events (id, tenant_id, actor_type, action, entity_type, entity_id) "
        "VALUES (?, ?, 'operator', 'read', 'site', ?)",
        [("audit-a", "tenant-a", "site-a"), ("audit-b", "tenant-b", "site-b")],
    )
    return db


def test_tenant_resource_queries_never_return_another_tenants_rows():
    db = _migrated_tenant_db()
    _seed_two_tenants(db)
    queries = {
        "sites": "SELECT id, tenant_id FROM sites WHERE tenant_id = ? AND id = ?",
        "assets": "SELECT id, tenant_id FROM assets WHERE tenant_id = ? AND id = ?",
        "sources": "SELECT id, tenant_id FROM sources WHERE tenant_id = ? AND id = ?",
        "observations": "SELECT id, tenant_id FROM observations WHERE tenant_id = ? AND id = ?",
        "audit_events": "SELECT id, tenant_id FROM audit_events WHERE tenant_id = ? AND id = ?",
    }
    ids = {
        "sites": "site-b", "assets": "asset-b", "sources": "source-b",
        "observations": "obs-b", "audit_events": "audit-b",
    }
    for table, query in queries.items():
        assert db.execute(query, ("tenant-a", ids[table])).fetchall() == []
        assert db.execute(query, ("tenant-b", ids[table])).fetchall() == [
            (ids[table], "tenant-b")
        ]


def test_tenant_triggers_reject_cross_tenant_asset_source_and_observation_links():
    db = _migrated_tenant_db()
    _seed_two_tenants(db)
    with pytest.raises(sqlite3.IntegrityError, match="asset tenant must match"):
        db.execute(
            "INSERT INTO assets (id, tenant_id, site_id, name, asset_type) "
            "VALUES ('bad-asset', 'tenant-a', 'site-b', 'Bad', 'pump')"
        )
    with pytest.raises(sqlite3.IntegrityError, match="source requires a tenant"):
        db.execute(
            "INSERT INTO sources (id, tenant_id, site_id, module, provider, source_type, display_name) "
            "VALUES ('bad-source', 'tenant-a', 'site-b', 'neoagro', 'fixture', 'sensor', 'Bad')"
        )
    with pytest.raises(sqlite3.IntegrityError, match="observation site, source and asset"):
        db.execute(
            "INSERT INTO observations (id, tenant_id, site_id, asset_id, source_id, module, metric, "
            "value, unit, observed_at, idempotency_key, provenance_json) "
            "VALUES ('bad-obs', 'tenant-a', 'site-a', 'asset-b', 'source-a', 'neoagro', "
            "'soil_moisture', 0.3, 'm3/m3', '2026-11-12T10:00:00Z', 'bad-key', '{}')"
        )


def test_suspended_tenant_cannot_create_or_update_operational_records():
    db = _migrated_tenant_db()
    _seed_two_tenants(db)
    db.execute("UPDATE tenants SET status = 'suspended' WHERE id = 'tenant-a'")
    with pytest.raises(sqlite3.IntegrityError, match="active tenant"):
        db.execute(
            "INSERT INTO sites (id, tenant_id, name) VALUES ('blocked-site', 'tenant-a', 'Blocked')"
        )
    with pytest.raises(sqlite3.IntegrityError, match="active tenant"):
        db.execute("UPDATE assets SET name = 'Blocked update' WHERE id = 'asset-a'")
    with pytest.raises(sqlite3.IntegrityError, match="active tenant"):
        db.execute("UPDATE sources SET display_name = 'Blocked update' WHERE id = 'source-a'")
    with pytest.raises(sqlite3.IntegrityError, match="active tenant"):
        db.execute("UPDATE observations SET value = 0.4 WHERE id = 'obs-a'")


def test_internal_request_nonce_is_consumed_once_and_has_bounded_expiry():
    db = _migrated_tenant_db()
    insert = (
        "INSERT INTO internal_request_nonces (request_id, issued_at, expires_at) "
        "VALUES (?, ?, ?) ON CONFLICT(request_id) DO NOTHING"
    )
    first = db.execute(insert, ("request-1", 1000, 1600))
    assert first.rowcount == 1
    replay = db.execute(insert, ("request-1", 1000, 1600))
    assert replay.rowcount == 0
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(insert, ("request-bad-expiry", 1000, 999))


def test_ownership_and_grant_scope_cannot_be_silently_reassigned():
    db = _migrated_tenant_db()
    _seed_two_tenants(db)
    with pytest.raises(sqlite3.IntegrityError, match="site tenant ownership is immutable"):
        db.execute("UPDATE sites SET tenant_id = 'tenant-b' WHERE id = 'site-a'")
    with pytest.raises(sqlite3.IntegrityError, match="source tenant ownership is immutable"):
        db.execute("UPDATE sources SET tenant_id = 'tenant-b' WHERE id = 'source-a'")
    with pytest.raises(sqlite3.IntegrityError, match="asset tenant ownership is immutable"):
        db.execute("UPDATE assets SET tenant_id = 'tenant-b' WHERE id = 'asset-a'")
    with pytest.raises(sqlite3.IntegrityError, match="observation tenant ownership is immutable"):
        db.execute("UPDATE observations SET tenant_id = 'tenant-b' WHERE id = 'obs-a'")
    with pytest.raises(sqlite3.IntegrityError, match="source site cannot change"):
        db.execute("UPDATE sources SET site_id = 'site-b' WHERE id = 'source-a'")
    with pytest.raises(sqlite3.IntegrityError, match="audit event tenant ownership is immutable"):
        db.execute("UPDATE audit_events SET tenant_id = 'tenant-b' WHERE id = 'audit-a'")

    db.execute(
        "INSERT INTO tenant_memberships (id, tenant_id, subject, role) "
        "VALUES ('membership-a', 'tenant-a', 'operator-a', 'operator')"
    )
    with pytest.raises(sqlite3.IntegrityError, match="membership identity scope is immutable"):
        db.execute("UPDATE tenant_memberships SET tenant_id = 'tenant-b' WHERE id = 'membership-a'")

    db.execute(
        "INSERT INTO tenant_resource_grants "
        "(id, tenant_id, subject, resource_type, resource_id, action) "
        "VALUES ('grant-a', 'tenant-a', 'operator-a', 'site', 'site-a', 'read')"
    )
    with pytest.raises(sqlite3.IntegrityError, match="grant scope is immutable"):
        db.execute("UPDATE tenant_resource_grants SET resource_id = 'site-b' WHERE id = 'grant-a'")


def test_site_bound_source_cannot_be_used_for_another_site_observation():
    db = _migrated_tenant_db()
    _seed_two_tenants(db)
    with pytest.raises(sqlite3.IntegrityError, match="observation site must match"):
        db.execute(
            "INSERT INTO observations (id, tenant_id, site_id, source_id, module, metric, "
            "value, unit, observed_at, idempotency_key, provenance_json) "
            "VALUES ('wrong-site-observation', 'tenant-a', 'site-a2', 'source-a', 'neoagro', "
            "'soil_moisture', 0.3, 'm3/m3', '2026-11-12T10:00:00Z', 'wrong-site-key', '{}')"
        )

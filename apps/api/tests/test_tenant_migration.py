import sqlite3
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
INITIAL = ROOT / "migrations" / "0001_initial.sql"
TENANT = ROOT / "migrations" / "0002_tenant_isolation.sql"


def database():
    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA foreign_keys = ON")
    db.executescript(INITIAL.read_text(encoding="utf-8"))
    db.executescript(TENANT.read_text(encoding="utf-8"))
    return db


def seed_tenant(db, tenant_id):
    db.execute(
        "INSERT INTO tenants (id, display_name) VALUES (?, ?)",
        (tenant_id, tenant_id),
    )


def seed_site(db, tenant_id, site_id):
    db.execute(
        "INSERT INTO sites (id, name, tenant_id) VALUES (?, ?, ?)",
        (site_id, site_id, tenant_id),
    )


def test_tenant_schema_and_indexes_exist():
    db = database()
    tables = {
        row[0] for row in db.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
    }
    assert {"tenants", "tenant_memberships", "tenant_resource_grants"} <= tables
    columns = {
        row[1] for row in db.execute("PRAGMA table_info(observations)").fetchall()
    }
    assert "tenant_id" in columns


def test_new_site_requires_active_tenant():
    db = database()
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("INSERT INTO sites (id, name) VALUES ('site-x', 'Site X')")
    seed_tenant(db, "tenant-a")
    seed_site(db, "tenant-a", "site-a")
    db.execute("INSERT INTO tenants (id, display_name, status) VALUES ('tenant-b', 'Tenant B', 'suspended')")
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            "INSERT INTO sites (id, name, tenant_id) VALUES ('site-b', 'Site B', 'tenant-b')"
        )


def test_assets_and_sources_must_match_site_tenant():
    db = database()
    seed_tenant(db, "tenant-a")
    seed_tenant(db, "tenant-b")
    seed_site(db, "tenant-a", "site-a")
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            "INSERT INTO assets (id, site_id, name, asset_type, tenant_id) VALUES ('asset-x', 'site-a', 'Pump', 'pump', 'tenant-b')"
        )
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            "INSERT INTO sources (id, site_id, module, provider, source_type, display_name, tenant_id) "
            "VALUES ('source-x', 'site-a', 'neoagro', 'operator', 'manual', 'Manual', 'tenant-b')"
        )


def test_observation_cannot_join_site_source_or_asset_across_tenants():
    db = database()
    seed_tenant(db, "tenant-a")
    seed_tenant(db, "tenant-b")
    seed_site(db, "tenant-a", "site-a")
    seed_site(db, "tenant-b", "site-b")
    db.execute(
        "INSERT INTO sources (id, site_id, module, provider, source_type, display_name, tenant_id) "
        "VALUES ('source-a', 'site-a', 'neoagro', 'operator', 'manual', 'A', 'tenant-a')"
    )
    db.execute(
        "INSERT INTO sources (id, site_id, module, provider, source_type, display_name, tenant_id) "
        "VALUES ('source-b', 'site-b', 'neoagro', 'operator', 'manual', 'B', 'tenant-b')"
    )
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            "INSERT INTO observations "
            "(id, site_id, source_id, module, metric, unit, observed_at, idempotency_key, provenance_json, tenant_id) "
            "VALUES ('obs-x', 'site-a', 'source-b', 'neoagro', 'temperature', 'degC', "
            "'2026-01-01T00:00:00Z', 'key-x', '{}', 'tenant-a')"
        )


def test_membership_and_grant_constraints_are_tenant_scoped():
    db = database()
    seed_tenant(db, "tenant-a")
    db.execute(
        "INSERT INTO tenant_memberships (id, tenant_id, subject, role) VALUES ('m1', 'tenant-a', 'sub-a', 'viewer')"
    )
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            "INSERT INTO tenant_memberships (id, tenant_id, subject, role) VALUES ('m2', 'tenant-a', 'sub-a', 'tenant_owner')"
        )
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            "INSERT INTO tenant_resource_grants "
            "(id, tenant_id, subject, resource_type, resource_id, action) "
            "VALUES ('g1', 'tenant-a', 'sub-a', 'site', '*', 'read')"
        )
    db.execute(
        "INSERT INTO tenant_resource_grants "
        "(id, tenant_id, subject, resource_type, resource_id, action) "
        "VALUES ('g2', 'tenant-a', 'sub-a', 'site', 'site-a', 'read')"
    )


def test_legacy_null_tenant_rows_are_not_tenant_scoped():
    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA foreign_keys = ON")
    db.executescript(INITIAL.read_text(encoding="utf-8"))
    db.execute("INSERT INTO sites (id, name) VALUES ('legacy-site', 'Legacy')")
    db.executescript(TENANT.read_text(encoding="utf-8"))
    row = db.execute("SELECT tenant_id FROM sites WHERE id='legacy-site'").fetchone()
    assert row == (None,)
    # The migration intentionally leaves ownership unresolved; consumers must
    # filter by an authorized tenant_id and must not infer or backfill ownership.



def test_suspended_tenant_cannot_receive_new_memberships_grants_or_assets():
    db = database()
    seed_tenant(db, "tenant-a")
    seed_site(db, "tenant-a", "site-a")
    db.execute("UPDATE tenants SET status='suspended' WHERE id='tenant-a'")
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            "INSERT INTO tenant_memberships (id, tenant_id, subject, role) "
            "VALUES ('m-suspended', 'tenant-a', 'sub-a', 'viewer')"
        )
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            "INSERT INTO tenant_resource_grants "
            "(id, tenant_id, subject, resource_type, resource_id, action) "
            "VALUES ('g-suspended', 'tenant-a', 'sub-a', 'site', 'site-a', 'read')"
        )
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            "INSERT INTO assets (id, site_id, name, asset_type, tenant_id) "
            "VALUES ('asset-suspended', 'site-a', 'Pump', 'pump', 'tenant-a')"
        )



def test_tenant_audit_event_must_reference_existing_tenant():
    db = database()
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            "INSERT INTO audit_events "
            "(id, actor_type, action, entity_type, entity_id, tenant_id) "
            "VALUES ('event-x', 'operator', 'site.update', 'site', 'site-a', 'unknown-tenant')"
        )
    seed_tenant(db, "tenant-a")
    db.execute(
        "INSERT INTO audit_events "
        "(id, actor_type, action, entity_type, entity_id, tenant_id) "
        "VALUES ('event-a', 'operator', 'site.update', 'site', 'site-a', 'tenant-a')"
    )



def test_suspended_tenant_blocks_updates_but_allows_membership_revocation():
    db = database()
    seed_tenant(db, "tenant-a")
    seed_site(db, "tenant-a", "site-a")
    db.execute(
        "INSERT INTO assets (id, site_id, name, asset_type, tenant_id) "
        "VALUES ('asset-a', 'site-a', 'Pump', 'pump', 'tenant-a')"
    )
    db.execute(
        "INSERT INTO tenant_memberships (id, tenant_id, subject, role) "
        "VALUES ('m-a', 'tenant-a', 'sub-a', 'viewer')"
    )
    db.execute("UPDATE tenants SET status='suspended' WHERE id='tenant-a'")
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("UPDATE assets SET name='Changed' WHERE id='asset-a'")
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("UPDATE tenant_memberships SET status='active' WHERE id='m-a'")
    db.execute("UPDATE tenant_memberships SET status='revoked' WHERE id='m-a'")
    status = db.execute(
        "SELECT status FROM tenant_memberships WHERE id='m-a'"
    ).fetchone()
    assert status == ("revoked",)



def test_every_tenant_owned_resource_has_tenant_column_and_lookup_index():
    db = database()
    expected = {
        "sites": "idx_sites_tenant_status",
        "assets": "idx_assets_tenant_site",
        "sources": "idx_sources_tenant_site",
        "observations": "idx_observations_tenant_site_metric_time",
        "audit_events": "idx_audit_events_tenant_time",
    }
    for table, index in expected.items():
        columns = {
            row[1] for row in db.execute(f"PRAGMA table_info({table})").fetchall()
        }
        assert "tenant_id" in columns, table
        indexes = {
            row[1] for row in db.execute(f"PRAGMA index_list({table})").fetchall()
        }
        assert index in indexes, table


def test_suspended_tenant_blocks_site_source_and_observation_writes():
    db = database()
    seed_tenant(db, "tenant-a")
    seed_site(db, "tenant-a", "site-a")
    db.execute(
        "INSERT INTO sources (id, site_id, module, provider, source_type, display_name, tenant_id) "
        "VALUES ('source-a', 'site-a', 'neoagro', 'operator', 'manual', 'Manual', 'tenant-a')"
    )
    db.execute("UPDATE tenants SET status='suspended' WHERE id='tenant-a'")

    with pytest.raises(sqlite3.IntegrityError):
        db.execute("UPDATE sites SET name='Changed' WHERE id='site-a'")
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            "INSERT INTO sources (id, site_id, module, provider, source_type, display_name, tenant_id) "
            "VALUES ('source-b', 'site-a', 'neoagro', 'operator', 'manual', 'Manual 2', 'tenant-a')"
        )
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            "INSERT INTO observations "
            "(id, site_id, source_id, module, metric, unit, observed_at, idempotency_key, provenance_json, tenant_id) "
            "VALUES ('obs-suspended', 'site-a', 'source-a', 'neoagro', 'temperature', 'degC', "
            "'2026-11-12T00:00:00Z', 'key-suspended', '{}', 'tenant-a')"
        )

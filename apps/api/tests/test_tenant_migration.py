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
    ownership = ROOT / "migrations" / "0004_site_tenant_transfer_guard.sql"
    db.executescript(ownership.read_text(encoding="utf-8"))
    audit_guard = ROOT / "migrations" / "0006_site_audit_transfer_guard.sql"
    db.executescript(audit_guard.read_text(encoding="utf-8"))
    site_audit_tenant_guard = ROOT / "migrations" / "0007_site_audit_tenant_match_guard.sql"
    db.executescript(site_audit_tenant_guard.read_text(encoding="utf-8"))
    site_audit_id_guard = ROOT / "migrations" / "0008_site_id_reuse_guard.sql"
    db.executescript(site_audit_id_guard.read_text(encoding="utf-8"))
    related_audit_guard = ROOT / "migrations" / "0009_related_entity_audit_guards.sql"
    db.executescript(related_audit_guard.read_text(encoding="utf-8"))
    tenant_identity_guard = ROOT / "migrations" / "0010_tenant_membership_audit_guards.sql"
    db.executescript(tenant_identity_guard.read_text(encoding="utf-8"))
    tombstone_guard = ROOT / "migrations" / "0011_deleted_entity_audit_tenant_continuity.sql"
    db.executescript(tombstone_guard.read_text(encoding="utf-8"))
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


def test_tenant_owned_audit_events_require_tenant_id():
    db = database()
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            "INSERT INTO audit_events "
            "(id, actor_type, action, entity_type, entity_id) "
            "VALUES ('event-missing-tenant', 'operator', 'site.update', 'site', 'site-a')"
        )
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            "INSERT INTO audit_events "
            "(id, actor_type, action, entity_type, entity_id) "
            "VALUES ('event-missing-tenant-2', 'operator', 'observation.ingest', 'observation', 'obs-a')"
        )
    # Global operational events remain possible when they do not describe a
    # tenant-owned entity.
    db.execute(
        "INSERT INTO audit_events "
        "(id, actor_type, action, entity_type, entity_id) "
        "VALUES ('global-event', 'system', 'health.check', 'worker', 'nova-core')"
    )



def test_grants_require_membership_and_resource_action_compatibility():
    db = database()
    seed_tenant(db, "tenant-a")
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            "INSERT INTO tenant_resource_grants "
            "(id, tenant_id, subject, resource_type, resource_id, action) "
            "VALUES ('orphan', 'tenant-a', 'no-membership', 'site', 'site-a', 'read')"
        )
    db.execute(
        "INSERT INTO tenant_memberships (id, tenant_id, subject, role) "
        "VALUES ('m-a', 'tenant-a', 'sub-a', 'operator')"
    )
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            "INSERT INTO tenant_resource_grants "
            "(id, tenant_id, subject, resource_type, resource_id, action) "
            "VALUES ('invalid-action', 'tenant-a', 'sub-a', 'site', 'site-a', 'ingest')"
        )
    db.execute(
        "INSERT INTO tenant_resource_grants "
        "(id, tenant_id, subject, resource_type, resource_id, action) "
        "VALUES ('valid-source-ingest', 'tenant-a', 'sub-a', 'source', 'source-a', 'ingest')"
    )
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("DELETE FROM tenant_memberships WHERE id='m-a'")


def test_suspended_tenant_blocks_resource_deletes():
    db = database()
    seed_tenant(db, "tenant-a")
    seed_site(db, "tenant-a", "site-a")
    db.execute(
        "INSERT INTO assets (id, site_id, name, asset_type, tenant_id) "
        "VALUES ('asset-a', 'site-a', 'Pump', 'pump', 'tenant-a')"
    )
    db.execute(
        "INSERT INTO sources (id, site_id, module, provider, source_type, display_name, tenant_id) "
        "VALUES ('source-a', 'site-a', 'neoagro', 'operator', 'manual', 'Manual', 'tenant-a')"
    )
    db.execute(
        "INSERT INTO observations "
        "(id, site_id, source_id, module, metric, unit, observed_at, idempotency_key, provenance_json, tenant_id) "
        "VALUES ('obs-a', 'site-a', 'source-a', 'neoagro', 'temperature', 'degC', "
        "'2026-11-12T00:00:00Z', 'key-a', '{}', 'tenant-a')"
    )
    db.execute("UPDATE tenants SET status='suspended' WHERE id='tenant-a'")
    for table, record_id in (
        ("observations", "obs-a"), ("assets", "asset-a"),
        ("sources", "source-a"), ("sites", "site-a"),
    ):
        with pytest.raises(sqlite3.IntegrityError):
            db.execute(f"DELETE FROM {table} WHERE id=?", (record_id,))


def test_audit_events_are_append_only():
    db = database()
    db.execute(
        "INSERT INTO audit_events (id, actor_type, action, entity_type, entity_id) "
        "VALUES ('global-event', 'system', 'health.check', 'worker', 'nova-core')"
    )
    with pytest.raises(sqlite3.IntegrityError, match="append-only"):
        db.execute("UPDATE audit_events SET action='changed' WHERE id='global-event'")
    with pytest.raises(sqlite3.IntegrityError, match="append-only"):
        db.execute("DELETE FROM audit_events WHERE id='global-event'")



def test_resource_grants_require_an_active_membership():
    db = database()
    seed_tenant(db, "tenant-a")
    db.execute(
        "INSERT INTO tenant_memberships (id, tenant_id, subject, role, status) "
        "VALUES ('m-inactive', 'tenant-a', 'sub-inactive', 'viewer', 'inactive')"
    )
    with pytest.raises(sqlite3.IntegrityError, match="active tenant membership"):
        db.execute(
            "INSERT INTO tenant_resource_grants "
            "(id, tenant_id, subject, resource_type, resource_id, action) "
            "VALUES ('g-inactive', 'tenant-a', 'sub-inactive', 'site', 'site-a', 'read')"
        )



def test_site_tenant_transfer_is_blocked_when_dependent_records_exist():
    db = database()
    seed_tenant(db, "tenant-a")
    seed_tenant(db, "tenant-b")
    seed_site(db, "tenant-a", "site-a")
    db.execute(
        "INSERT INTO assets (id, site_id, name, asset_type, tenant_id) "
        "VALUES ('asset-a', 'site-a', 'Pump', 'pump', 'tenant-a')"
    )
    db.execute(
        "INSERT INTO sources (id, site_id, module, provider, source_type, display_name, tenant_id) "
        "VALUES ('source-a', 'site-a', 'neoagro', 'operator', 'manual', 'Manual', 'tenant-a')"
    )
    db.execute(
        "INSERT INTO observations "
        "(id, site_id, source_id, module, metric, unit, observed_at, idempotency_key, provenance_json, tenant_id) "
        "VALUES ('obs-a', 'site-a', 'source-a', 'neoagro', 'temperature', 'degC', "
        "'2026-11-27T00:00:00Z', 'key-a', '{}', 'tenant-a')"
    )

    with pytest.raises(sqlite3.IntegrityError, match="dependent records"):
        db.execute("UPDATE sites SET tenant_id='tenant-b' WHERE id='site-a'")

    assert db.execute(
        "SELECT tenant_id FROM sites WHERE id='site-a'"
    ).fetchone() == ("tenant-a",)


def test_legacy_site_without_dependent_records_can_receive_approved_tenant():
    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA foreign_keys = ON")
    db.executescript(INITIAL.read_text(encoding="utf-8"))
    db.execute("INSERT INTO sites (id, name) VALUES ('legacy-site', 'Legacy')")
    db.executescript(TENANT.read_text(encoding="utf-8"))
    ownership = ROOT / "migrations" / "0004_site_tenant_transfer_guard.sql"
    db.executescript(ownership.read_text(encoding="utf-8"))
    audit_guard = ROOT / "migrations" / "0006_site_audit_transfer_guard.sql"
    db.executescript(audit_guard.read_text(encoding="utf-8"))
    site_audit_tenant_guard = ROOT / "migrations" / "0007_site_audit_tenant_match_guard.sql"
    db.executescript(site_audit_tenant_guard.read_text(encoding="utf-8"))
    seed_tenant(db, "tenant-a")

    db.execute("UPDATE sites SET tenant_id='tenant-a' WHERE id='legacy-site'")
    assert db.execute(
        "SELECT tenant_id FROM sites WHERE id='legacy-site'"
    ).fetchone() == ("tenant-a",)

 
def test_site_tenant_transfer_is_blocked_when_site_audit_history_exists():
    db = database()
    seed_tenant(db, "tenant-a")
    seed_tenant(db, "tenant-b")
    seed_site(db, "tenant-a", "site-a")
    db.execute(
        "INSERT INTO audit_events "
        "(id, actor_type, action, entity_type, entity_id, tenant_id) "
        "VALUES ('event-site-a', 'operator', 'site.update', 'site', 'site-a', 'tenant-a')"
    )

    with pytest.raises(sqlite3.IntegrityError, match="audit history"):
        db.execute("UPDATE sites SET tenant_id='tenant-b' WHERE id='site-a'")

    assert db.execute(
        "SELECT tenant_id FROM sites WHERE id='site-a'"
    ).fetchone() == ("tenant-a",)
    assert db.execute(
        "SELECT tenant_id FROM audit_events WHERE id='event-site-a'"
    ).fetchone() == ("tenant-a",)


def test_legacy_unassigned_site_audit_history_blocks_tenant_assignment():
    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA foreign_keys = ON")
    db.executescript(INITIAL.read_text(encoding="utf-8"))
    db.execute("INSERT INTO sites (id, name) VALUES ('legacy-site', 'Legacy')")
    db.execute(
        "INSERT INTO audit_events "
        "(id, actor_type, action, entity_type, entity_id) "
        "VALUES ('legacy-site-event', 'system', 'site.created', 'site', 'legacy-site')"
    )
    db.executescript(TENANT.read_text(encoding="utf-8"))
    ownership = ROOT / "migrations" / "0004_site_tenant_transfer_guard.sql"
    db.executescript(ownership.read_text(encoding="utf-8"))
    audit_guard = ROOT / "migrations" / "0006_site_audit_transfer_guard.sql"
    db.executescript(audit_guard.read_text(encoding="utf-8"))
    seed_tenant(db, "tenant-a")

    with pytest.raises(sqlite3.IntegrityError, match="audit history"):
        db.execute("UPDATE sites SET tenant_id='tenant-a' WHERE id='legacy-site'")

    assert db.execute(
        "SELECT tenant_id FROM sites WHERE id='legacy-site'"
    ).fetchone() == (None,)
    assert db.execute(
        "SELECT tenant_id FROM audit_events WHERE id='legacy-site-event'"
    ).fetchone() == (None,)

def test_site_id_cannot_be_reused_after_audit_history_exists():
    db = database()
    seed_tenant(db, "tenant-a")
    seed_tenant(db, "tenant-b")
    seed_site(db, "tenant-a", "site-reused")
    db.execute(
        "INSERT INTO audit_events "
        "(id, actor_type, action, entity_type, entity_id, tenant_id) "
        "VALUES ('event-before-delete', 'operator', 'site.update', 'site', 'site-reused', 'tenant-a')"
    )

    db.execute("DELETE FROM sites WHERE id='site-reused'")

    with pytest.raises(sqlite3.IntegrityError, match="site ID cannot be reused while audit history exists"):
        seed_site(db, "tenant-b", "site-reused")

    assert db.execute(
        "SELECT COUNT(*) FROM sites WHERE id='site-reused'"
    ).fetchone() == (0,)
    assert db.execute(
        "SELECT tenant_id FROM audit_events WHERE id='event-before-delete'"
    ).fetchone() == ("tenant-a",)


def test_site_audit_event_tenant_must_match_existing_site_owner():
    db = database()
    seed_tenant(db, "tenant-a")
    seed_tenant(db, "tenant-b")
    seed_site(db, "tenant-a", "site-a")

    db.execute(
        "INSERT INTO audit_events "
        "(id, actor_type, action, entity_type, entity_id, tenant_id) "
        "VALUES ('event-site-correct', 'operator', 'site.update', 'site', 'site-a', 'tenant-a')"
    )

    with pytest.raises(sqlite3.IntegrityError, match="site audit event tenant must match site"):
        db.execute(
            "INSERT INTO audit_events "
            "(id, actor_type, action, entity_type, entity_id, tenant_id) "
            "VALUES ('event-site-wrong', 'operator', 'site.update', 'site', 'site-a', 'tenant-b')"
        )

    assert db.execute(
        "SELECT tenant_id FROM audit_events WHERE id='event-site-correct'"
    ).fetchone() == ("tenant-a",)
    assert db.execute(
        "SELECT COUNT(*) FROM audit_events WHERE id='event-site-wrong'"
    ).fetchone() == (0,)

    # A deletion/tombstone event may be appended after the site row is gone.
    db.execute("DELETE FROM sites WHERE id='site-a'")
    db.execute(
        "INSERT INTO audit_events "
        "(id, actor_type, action, entity_type, entity_id, tenant_id) "
        "VALUES ('event-site-deleted', 'operator', 'site.delete', 'site', 'site-a', 'tenant-a')"
    )
    assert db.execute(
        "SELECT tenant_id FROM audit_events WHERE id='event-site-deleted'"
    ).fetchone() == ("tenant-a",)

def test_asset_source_and_observation_audit_tenant_must_match_owner():
    db = database()
    seed_tenant(db, "tenant-a")
    seed_tenant(db, "tenant-b")
    seed_site(db, "tenant-a", "site-a")
    db.execute(
        "INSERT INTO assets (id, site_id, name, asset_type, tenant_id) "
        "VALUES ('asset-a', 'site-a', 'Pump', 'pump', 'tenant-a')"
    )
    db.execute(
        "INSERT INTO sources (id, site_id, module, provider, source_type, display_name, tenant_id) "
        "VALUES ('source-a', 'site-a', 'neoagro', 'operator', 'manual', 'Manual', 'tenant-a')"
    )
    db.execute(
        "INSERT INTO observations "
        "(id, site_id, source_id, module, metric, unit, observed_at, idempotency_key, provenance_json, tenant_id) "
        "VALUES ('obs-a', 'site-a', 'source-a', 'neoagro', 'temperature', 'degC', "
        "'2026-01-01T00:00:00Z', 'obs-key-a', '{}', 'tenant-a')"
    )

    for entity_type, entity_id in (
        ("asset", "asset-a"),
        ("source", "source-a"),
        ("observation", "obs-a"),
    ):
        with pytest.raises(sqlite3.IntegrityError, match="audit event tenant must match entity"):
            db.execute(
                "INSERT INTO audit_events "
                "(id, actor_type, action, entity_type, entity_id, tenant_id) "
                "VALUES (?, 'operator', 'entity.update', ?, ?, 'tenant-b')",
                (f"wrong-{entity_type}", entity_type, entity_id),
            )


def test_asset_source_and_observation_ids_cannot_be_reused_after_audit_history():
    db = database()
    seed_tenant(db, "tenant-a")
    seed_site(db, "tenant-a", "site-a")
    db.execute(
        "INSERT INTO assets (id, site_id, name, asset_type, tenant_id) "
        "VALUES ('asset-a', 'site-a', 'Pump', 'pump', 'tenant-a')"
    )
    db.execute(
        "INSERT INTO sources (id, site_id, module, provider, source_type, display_name, tenant_id) "
        "VALUES ('source-a', 'site-a', 'neoagro', 'operator', 'manual', 'Manual', 'tenant-a')"
    )
    db.execute(
        "INSERT INTO observations "
        "(id, site_id, source_id, module, metric, unit, observed_at, idempotency_key, provenance_json, tenant_id) "
        "VALUES ('obs-a', 'site-a', 'source-a', 'neoagro', 'temperature', 'degC', "
        "'2026-01-01T00:00:00Z', 'obs-key-a', '{}', 'tenant-a')"
    )

    # Delete in FK dependency order: observations, then sources, then assets.
    for table, entity_type, entity_id in (
        ("observations", "observation", "obs-a"),
        ("sources", "source", "source-a"),
        ("assets", "asset", "asset-a"),
    ):
        db.execute(
            "INSERT INTO audit_events "
            "(id, actor_type, action, entity_type, entity_id, tenant_id) "
            "VALUES (?, 'operator', 'entity.created', ?, ?, 'tenant-a')",
            (f"history-{entity_type}", entity_type, entity_id),
        )
        db.execute(f"DELETE FROM {table} WHERE id=?", (entity_id,))
        # Tombstone events remain valid after the resource row is absent.
        db.execute(
            "INSERT INTO audit_events "
            "(id, actor_type, action, entity_type, entity_id, tenant_id) "
            "VALUES (?, 'operator', 'entity.deleted', ?, ?, 'tenant-a')",
            (f"tombstone-{entity_type}", entity_type, entity_id),
        )

    with pytest.raises(sqlite3.IntegrityError, match="asset ID cannot be reused"):
        db.execute(
            "INSERT INTO assets (id, site_id, name, asset_type, tenant_id) "
            "VALUES ('asset-a', 'site-a', 'Replacement', 'pump', 'tenant-a')"
        )
    with pytest.raises(sqlite3.IntegrityError, match="source ID cannot be reused"):
        db.execute(
            "INSERT INTO sources (id, site_id, module, provider, source_type, display_name, tenant_id) "
            "VALUES ('source-a', 'site-a', 'neoagro', 'operator', 'manual', 'Replacement', 'tenant-a')"
        )
    with pytest.raises(sqlite3.IntegrityError, match="observation ID cannot be reused"):
        db.execute(
            "INSERT INTO observations "
            "(id, site_id, source_id, module, metric, unit, observed_at, idempotency_key, provenance_json, tenant_id) "
            "VALUES ('obs-a', 'site-a', 'source-a', 'neoagro', 'temperature', 'degC', "
            "'2026-01-02T00:00:00Z', 'obs-key-b', '{}', 'tenant-a')"
        )

def test_tenant_and_membership_audit_events_must_match_entity_owner():
    db = database()
    seed_tenant(db, "tenant-a")
    seed_tenant(db, "tenant-b")
    db.execute(
        "INSERT INTO tenant_memberships (id, tenant_id, subject, role) "
        "VALUES ('membership-a', 'tenant-a', 'subject-a', 'viewer')"
    )

    with pytest.raises(sqlite3.IntegrityError, match="audit event tenant must match entity"):
        db.execute(
            "INSERT INTO audit_events "
            "(id, actor_type, action, entity_type, entity_id, tenant_id) "
            "VALUES ('wrong-tenant', 'operator', 'tenant.update', 'tenant', 'tenant-a', 'tenant-b')"
        )
    with pytest.raises(sqlite3.IntegrityError, match="audit event tenant must match entity"):
        db.execute(
            "INSERT INTO audit_events "
            "(id, actor_type, action, entity_type, entity_id, tenant_id) "
            "VALUES ('wrong-membership', 'operator', 'membership.update', 'membership', 'membership-a', 'tenant-b')"
        )

    db.execute(
        "INSERT INTO audit_events "
        "(id, actor_type, action, entity_type, entity_id, tenant_id) "
        "VALUES ('correct-tenant', 'operator', 'tenant.update', 'tenant', 'tenant-a', 'tenant-a')"
    )
    db.execute(
        "INSERT INTO audit_events "
        "(id, actor_type, action, entity_type, entity_id, tenant_id) "
        "VALUES ('correct-membership', 'operator', 'membership.update', 'membership', 'membership-a', 'tenant-a')"
    )


def test_membership_tenant_transfer_and_id_reuse_are_blocked_after_audit_history():
    db = database()
    seed_tenant(db, "tenant-a")
    seed_tenant(db, "tenant-b")
    db.execute(
        "INSERT INTO tenant_memberships (id, tenant_id, subject, role) "
        "VALUES ('membership-a', 'tenant-a', 'subject-a', 'viewer')"
    )
    db.execute(
        "INSERT INTO audit_events "
        "(id, actor_type, action, entity_type, entity_id, tenant_id) "
        "VALUES ('membership-history', 'operator', 'membership.created', 'membership', 'membership-a', 'tenant-a')"
    )

    with pytest.raises(sqlite3.IntegrityError, match="membership tenant cannot change while audit history exists"):
        db.execute(
            "UPDATE tenant_memberships SET tenant_id='tenant-b' WHERE id='membership-a'"
        )

    db.execute("DELETE FROM tenant_memberships WHERE id='membership-a'")
    with pytest.raises(sqlite3.IntegrityError, match="membership ID cannot be reused"):
        db.execute(
            "INSERT INTO tenant_memberships (id, tenant_id, subject, role) "
            "VALUES ('membership-a', 'tenant-b', 'subject-b', 'viewer')"
        )


def test_tenant_id_cannot_be_reused_after_legacy_audit_history():
    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA foreign_keys = ON")
    db.executescript(INITIAL.read_text(encoding="utf-8"))
    db.executescript(TENANT.read_text(encoding="utf-8"))
    seed_tenant(db, "tenant-a")
    seed_tenant(db, "tenant-b")
    # Simulate a legacy misattributed event that predates migration 0010.
    db.execute(
        "INSERT INTO audit_events "
        "(id, actor_type, action, entity_type, entity_id, tenant_id) "
        "VALUES ('legacy-tenant-history', 'operator', 'tenant.update', 'tenant', 'tenant-a', 'tenant-b')"
    )
    tenant_identity_guard = ROOT / "migrations" / "0010_tenant_membership_audit_guards.sql"
    db.executescript(tenant_identity_guard.read_text(encoding="utf-8"))
    db.execute("DELETE FROM tenants WHERE id='tenant-a'")
    with pytest.raises(sqlite3.IntegrityError, match="tenant ID cannot be reused"):
        db.execute(
            "INSERT INTO tenants (id, display_name) VALUES ('tenant-a', 'Recreated tenant A')"
        )


@pytest.mark.parametrize("entity_type", ["experiment", "dataset_snapshot"])
def test_reserved_deleted_entity_tombstones_preserve_prior_tenant_history(entity_type):
    db = database()
    seed_tenant(db, "tenant-a")
    seed_tenant(db, "tenant-b")
    db.execute(
        "INSERT INTO audit_events "
        "(id, actor_type, action, entity_type, entity_id, tenant_id) "
        "VALUES (?, 'operator', 'entity.created', ?, 'reserved-id', 'tenant-a')",
        (f"prior-{entity_type}", entity_type),
    )

    with pytest.raises(sqlite3.IntegrityError, match="tombstone audit tenant must match history"):
        db.execute(
            "INSERT INTO audit_events "
            "(id, actor_type, action, entity_type, entity_id, tenant_id) "
            "VALUES (?, 'operator', 'entity.deleted', ?, 'reserved-id', 'tenant-b')",
            (f"wrong-tombstone-{entity_type}", entity_type),
        )

    db.execute(
        "INSERT INTO audit_events "
        "(id, actor_type, action, entity_type, entity_id, tenant_id) "
        "VALUES (?, 'operator', 'entity.deleted', ?, 'reserved-id', 'tenant-a')",
        (f"correct-tombstone-{entity_type}", entity_type),
    )


def test_deleted_site_tombstone_cannot_change_prior_tenant_attribution():
    db = database()
    seed_tenant(db, "tenant-a")
    seed_tenant(db, "tenant-b")
    seed_site(db, "tenant-a", "site-tombstone")
    db.execute(
        "INSERT INTO audit_events "
        "(id, actor_type, action, entity_type, entity_id, tenant_id) "
        "VALUES ('site-prior', 'operator', 'site.created', 'site', 'site-tombstone', 'tenant-a')"
    )
    db.execute("DELETE FROM sites WHERE id='site-tombstone'")

    with pytest.raises(sqlite3.IntegrityError, match="tombstone audit tenant must match history"):
        db.execute(
            "INSERT INTO audit_events "
            "(id, actor_type, action, entity_type, entity_id, tenant_id) "
            "VALUES ('site-wrong-tombstone', 'operator', 'site.deleted', 'site', 'site-tombstone', 'tenant-b')"
        )

    db.execute(
        "INSERT INTO audit_events "
        "(id, actor_type, action, entity_type, entity_id, tenant_id) "
        "VALUES ('site-correct-tombstone', 'operator', 'site.deleted', 'site', 'site-tombstone', 'tenant-a')"
    )

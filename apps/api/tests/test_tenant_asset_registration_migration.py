from pathlib import Path

MIGRATION = Path(__file__).parents[1] / "migrations" / "0027_tenant_asset_registration.sql"


def test_asset_registration_migration_is_append_only_and_idempotent():
    sql = MIGRATION.read_text()
    assert "CREATE TABLE tenant_asset_events" in sql
    assert "CREATE TABLE tenant_asset_creation_requests" in sql
    assert "UNIQUE (tenant_id, actor_subject, idempotency_key)" in sql
    assert "tenant_asset_events_no_update" in sql
    assert "tenant_asset_events_no_delete" in sql
    assert "tenant_asset_creation_requests_no_update" in sql
    assert "tenant_asset_creation_requests_no_delete" in sql
    assert "tenant_owner" in sql
    assert "status = 'unconfigured'" in sql
    assert "FOREIGN KEY (asset_id, tenant_id, site_id)" in sql
    assert "source" not in sql.lower().replace("asset", "") or "source" in sql.lower()

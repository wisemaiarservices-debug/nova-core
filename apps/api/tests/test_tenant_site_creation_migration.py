from pathlib import Path

MIGRATION = Path(__file__).parents[1] / "migrations" / "0022_tenant_site_creation.sql"


def test_site_creation_migration_adds_append_only_audit_and_idempotency_guards():
    sql = MIGRATION.read_text()
    assert "CREATE TABLE tenant_site_events" in sql
    assert "CREATE TABLE tenant_site_creation_requests" in sql
    assert "UNIQUE (tenant_id, actor_subject, idempotency_key)" in sql
    assert "tenant_site_grant_events" in sql
    assert "tenant_owner" in sql
    assert "tenant_site_events_no_update" in sql
    assert "tenant_site_events_no_delete" in sql
    assert "tenant_site_creation_requests_no_update" in sql
    assert "tenant_site_creation_requests_no_delete" in sql
    assert "tenant_site_creation_request_insert_guard" in sql

import sqlite3
from pathlib import Path


MIGRATION = Path(__file__).resolve().parents[1] / "migrations" / "0001_initial.sql"


def _database():
    connection = sqlite3.connect(":memory:")
    connection.execute("PRAGMA foreign_keys = ON")
    connection.executescript(MIGRATION.read_text(encoding="utf-8"))
    return connection


def test_initial_migration_creates_expected_tables_and_indexes():
    db = _database()
    tables = {
        row[0]
        for row in db.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
    }
    assert {"sites", "assets", "sources", "observations", "audit_events"} <= tables
    indexes = {
        row[0]
        for row in db.execute(
            "SELECT name FROM sqlite_master WHERE type='index'"
        ).fetchall()
    }
    assert "idx_observations_idempotency" in indexes
    assert "idx_audit_entity_time" in indexes


def test_site_coordinates_must_be_a_valid_pair():
    db = _database()
    try:
        db.execute("INSERT INTO sites (id, name, latitude) VALUES ('s1', 'Site 1', 36.8)")
        assert False, "one-sided coordinates should be rejected"
    except sqlite3.IntegrityError:
        pass
    db.execute(
        "INSERT INTO sites (id, name, latitude, longitude) VALUES ('s2', 'Site 2', 36.8, 10.2)"
    )


def test_observation_requires_source_and_enforces_idempotency():
    db = _database()
    db.execute("INSERT INTO sites (id, name) VALUES ('site-a', 'Site A')")
    db.execute(
        "INSERT INTO sources (id, site_id, module, provider, source_type, display_name) "
        "VALUES ('src-a', 'site-a', 'neoagro', 'NASA POWER', 'gridded_weather', 'NASA POWER Daily')"
    )
    values = (
        "obs-a", "site-a", None, "src-a", "neoagro", "T2M", 21.5, "degC",
        "2026-01-01T00:00:00Z", "request-001", '{"method":"provider_api"}', "[]"
    )
    db.execute(
        "INSERT INTO observations "
        "(id, site_id, asset_id, source_id, module, metric, value, unit, observed_at, "
        "idempotency_key, provenance_json, quality_flags_json) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        values,
    )
    try:
        db.execute(
            "INSERT INTO observations "
            "(id, site_id, asset_id, source_id, module, metric, value, unit, observed_at, "
            "idempotency_key, provenance_json, quality_flags_json) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("obs-b", *values[1:]),
        )
        assert False, "duplicate idempotency key should be rejected"
    except sqlite3.IntegrityError:
        pass


def test_asset_cannot_be_attached_to_observation_from_another_site():
    db = _database()
    db.execute("INSERT INTO sites (id, name) VALUES ('site-a', 'Site A')")
    db.execute("INSERT INTO sites (id, name) VALUES ('site-b', 'Site B')")
    db.execute(
        "INSERT INTO assets (id, site_id, name, asset_type) VALUES ('asset-a', 'site-a', 'Pump', 'pump')"
    )
    db.execute(
        "INSERT INTO sources (id, site_id, module, provider, source_type, display_name) "
        "VALUES ('src-b', 'site-b', 'neocell', 'operator', 'manual', 'Operator entry')"
    )
    try:
        db.execute(
            "INSERT INTO observations "
            "(id, site_id, asset_id, source_id, module, metric, unit, observed_at, "
            "idempotency_key, provenance_json) "
            "VALUES ('obs-x', 'site-b', 'asset-a', 'src-b', 'neocell', 'temperature', "
            "'degC', '2026-01-01T00:00:00Z', 'request-x', '{}')"
        )
        assert False, "cross-site asset reference should be rejected"
    except sqlite3.IntegrityError:
        pass

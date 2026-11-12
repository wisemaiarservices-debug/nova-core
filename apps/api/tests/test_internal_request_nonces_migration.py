"""SQLite contract tests for the private tenant gateway nonce migration.

These tests validate the migration SQL and atomic insert semantics locally. They
do not substitute for a disposable Cloudflare D1 integration test.
"""
import sqlite3
from pathlib import Path

import pytest


MIGRATIONS = Path(__file__).resolve().parents[1] / "migrations"


def database():
    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA foreign_keys = ON")
    # Exercise the real ordered migration chain, not migration 0003 in isolation.
    for name in (
        "0001_initial.sql",
        "0002_tenant_isolation.sql",
        "0003_internal_request_nonces.sql",
    ):
        db.executescript((MIGRATIONS / name).read_text(encoding="utf-8"))
    return db


def consume(db, request_id: str, issued_at: int) -> bool:
    cursor = db.execute(
        """INSERT INTO internal_request_nonces (request_id, issued_at, expires_at)
           VALUES (?, ?, ?)
           ON CONFLICT(request_id) DO NOTHING""",
        (request_id, issued_at, issued_at + 600),
    )
    return cursor.rowcount == 1


def test_nonce_migration_creates_primary_key_and_expiry_index():
    db = database()
    columns = {
        row[1]: row for row in db.execute(
            "PRAGMA table_info(internal_request_nonces)"
        ).fetchall()
    }
    assert set(columns) >= {"request_id", "issued_at", "expires_at", "created_at"}
    assert columns["request_id"][5] == 1
    indexes = {
        row[1] for row in db.execute(
            "PRAGMA index_list(internal_request_nonces)"
        ).fetchall()
    }
    assert "idx_internal_request_nonces_expiry" in indexes


def test_request_id_is_consumed_exactly_once():
    db = database()
    assert consume(db, "gateway-request-1", 1_800_000_000) is True
    assert consume(db, "gateway-request-1", 1_800_000_001) is False
    assert db.execute(
        "SELECT COUNT(*) FROM internal_request_nonces WHERE request_id = ?",
        ("gateway-request-1",),
    ).fetchone() == (1,)


def test_nonce_rejects_empty_ids_and_non_positive_lifetimes():
    db = database()
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            "INSERT INTO internal_request_nonces (request_id, issued_at, expires_at) VALUES ('', 10, 20)"
        )
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            "INSERT INTO internal_request_nonces (request_id, issued_at, expires_at) VALUES ('bad-lifetime', 20, 20)"
        )


def test_expiry_index_supports_bounded_cleanup_selection():
    db = database()
    db.execute(
        "INSERT INTO internal_request_nonces (request_id, issued_at, expires_at) VALUES ('expired', 10, 20)"
    )
    db.execute(
        "INSERT INTO internal_request_nonces (request_id, issued_at, expires_at) VALUES ('live', 30, 40)"
    )
    expired = db.execute(
        "SELECT request_id FROM internal_request_nonces WHERE expires_at <= ? ORDER BY expires_at LIMIT 100",
        (25,),
    ).fetchall()
    assert expired == [("expired",)]

from __future__ import annotations

import asyncio
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from apps.api.services.tenant_request_replay import (
    NONCE_CLEANUP_SQL,
    NONCE_INSERT_SQL,
    RequestReplayStorageError,
    cleanup_expired_request_nonces,
    consume_request_nonce,
)

ROOT = Path(__file__).resolve().parents[1]
INITIAL = ROOT / "migrations" / "0001_initial.sql"
TENANT = ROOT / "migrations" / "0002_tenant_isolation.sql"
REPLAY = ROOT / "migrations" / "0003_internal_request_nonces.sql"


def database(path=":memory:"):
    db = sqlite3.connect(path, timeout=10)
    db.execute("PRAGMA foreign_keys = ON")
    db.execute("PRAGMA busy_timeout = 10000")
    db.executescript(INITIAL.read_text(encoding="utf-8"))
    db.executescript(TENANT.read_text(encoding="utf-8"))
    db.executescript(REPLAY.read_text(encoding="utf-8"))
    return db


def claim(db, jti, now=1_800_000_000, exp=None):
    exp = exp or now + 60
    return db.execute(
        NONCE_INSERT_SQL,
        (jti, exp, exp + 86_400, now),
    ).fetchall()


def test_replay_migration_creates_unique_durable_store_and_retention_index():
    db = database()
    columns = {row[1] for row in db.execute(
        "PRAGMA table_info(internal_request_nonces)"
    ).fetchall()}
    indexes = {row[1] for row in db.execute(
        "PRAGMA index_list(internal_request_nonces)"
    ).fetchall()}
    assert {"jti", "expires_at", "retained_until", "consumed_at"} <= columns
    assert "idx_internal_request_nonces_retention" in indexes


def test_nonce_is_consumed_once_and_replay_returns_no_claim():
    db = database()
    assert claim(db, "request-id-00000001") == [("request-id-00000001",)]
    assert claim(db, "request-id-00000001") == []
    assert db.execute("SELECT COUNT(*) FROM internal_request_nonces").fetchone() == (1,)


def test_concurrent_duplicate_nonce_has_exactly_one_winner(tmp_path):
    path = str(tmp_path / "nonce-concurrency.sqlite")
    setup = database(path)
    setup.close()
    barrier = threading.Barrier(12)

    def attempt():
        connection = sqlite3.connect(path, timeout=10)
        connection.execute("PRAGMA busy_timeout = 10000")
        barrier.wait()
        try:
            rows = claim(connection, "concurrent-request-0001")
            connection.commit()
            return len(rows) == 1
        finally:
            connection.close()

    with ThreadPoolExecutor(max_workers=12) as pool:
        outcomes = list(pool.map(lambda _: attempt(), range(12)))
    assert sum(outcomes) == 1
    verify = sqlite3.connect(path)
    assert verify.execute(
        "SELECT COUNT(*) FROM internal_request_nonces WHERE jti=?",
        ("concurrent-request-0001",),
    ).fetchone() == (1,)
    verify.close()


def test_cleanup_removes_only_retention_expired_rows_in_a_bounded_batch():
    db = database()
    now = 1_800_000_000
    claim(db, "retained-request-000001", now=now, exp=now + 60)
    claim(db, "still-retained-request-01", now=now, exp=now + 60)
    db.execute(
        "UPDATE internal_request_nonces SET expires_at=?, retained_until=? WHERE jti=?",
        (now - 1, now - 1, "retained-request-000001"),
    )
    removed = db.execute(
        NONCE_CLEANUP_SQL,
        (now, 1),
    ).fetchall()
    assert removed == [("retained-request-000001",)]
    assert db.execute("SELECT COUNT(*) FROM internal_request_nonces").fetchone() == (1,)


def test_malformed_or_expired_assertion_envelope_is_rejected_before_storage():
    class NeverDatabase:
        def prepare(self, _sql):
            raise AssertionError("invalid envelope must not reach storage")

    for kwargs in (
        {"jti": "short", "issued_at": 100, "expires_at": 160, "now": 120},
        {"jti": "request-id-00000002", "issued_at": 100, "expires_at": 120, "now": 120},
        {"jti": "request-id-00000003", "issued_at": 100, "expires_at": 300, "now": 120},
        {"jti": "request-id-00000004", "issued_at": 200, "expires_at": 260, "now": 120},
        {"jti": "request-id-00000005", "issued_at": True, "expires_at": 160, "now": 120},
    ):
        assert asyncio.run(consume_request_nonce(NeverDatabase(), **kwargs)) is False


class Result:
    def __init__(self, results, success=True):
        self.results = results
        self.success = success


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
        if self.database.error:
            raise RuntimeError("sensitive D1 details")
        return self.database.result


class FakeD1:
    def __init__(self, result=None, error=False):
        self.result = result or Result([])
        self.error = error
        self.calls = []

    def prepare(self, sql):
        return Statement(self, sql)


def test_d1_nonce_claim_is_one_atomic_insert_and_returns_consumed_id():
    db = FakeD1(Result([{"jti": "request-id-00000006"}]))
    consumed = asyncio.run(consume_request_nonce(
        db, jti="request-id-00000006", issued_at=100, expires_at=160, now=120,
    ))
    assert consumed is True
    sql, parameters = db.calls[0]
    assert sql == NONCE_INSERT_SQL
    assert parameters == ("request-id-00000006", 160, 160 + 86_400, 120)


def test_d1_conflict_is_a_replay_not_a_storage_error():
    db = FakeD1(Result([]))
    assert asyncio.run(consume_request_nonce(
        db, jti="request-id-00000007", issued_at=100, expires_at=160, now=120,
    )) is False


def test_d1_storage_failure_fails_closed_without_leaking_details():
    db = FakeD1(error=True)
    with pytest.raises(RequestReplayStorageError, match="storage is unavailable") as error:
        asyncio.run(consume_request_nonce(
            db, jti="request-id-00000008", issued_at=100, expires_at=160, now=120,
        ))
    assert "sensitive D1 details" not in str(error.value)


def test_cleanup_uses_bounded_parameterized_delete():
    db = FakeD1(Result([{"jti": "expired-request-000001"}]))
    removed = asyncio.run(cleanup_expired_request_nonces(db, now=1_800_000_000, limit=25))
    assert removed == 1
    assert db.calls == [(NONCE_CLEANUP_SQL, (1_800_000_000, 25))]


def test_cleanup_rejects_unbounded_or_invalid_batches():
    db = FakeD1()
    with pytest.raises(ValueError):
        asyncio.run(cleanup_expired_request_nonces(db, now=1_800_000_000, limit=501))
    assert db.calls == []

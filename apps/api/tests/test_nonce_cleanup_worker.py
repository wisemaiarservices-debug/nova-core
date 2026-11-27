from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from apps.api.nonce_cleanup_worker import Default, _scheduled_epoch_seconds, run_nonce_cleanup
from apps.api.services.tenant_request_replay import MAX_CLEANUP_BATCH, NONCE_CLEANUP_SQL, RequestReplayStorageError


class Result:
    success = True
    def __init__(self, rows): self.results = rows

class Statement:
    def __init__(self, database, sql): self.database, self.sql, self.parameters = database, sql, ()
    def bind(self, *parameters): self.parameters = parameters; return self
    async def run(self):
        self.database.calls.append((self.sql, self.parameters))
        if self.database.error: raise RuntimeError("private database diagnostic")
        return Result(self.database.rows)

class FakeD1:
    def __init__(self, rows=(), error=False): self.rows, self.error, self.calls = list(rows), error, [] 
    def prepare(self, sql): return Statement(self, sql)


def test_nonce_cleanup_worker_observability_redacts_query_strings():
    import json
    from pathlib import Path

    config = json.loads((Path(__file__).parents[1] / "wrangler.nonce-cleanup.jsonc").read_text())
    assert config["observability"]["enabled"] is True
    assert "redactQueryString" not in config["observability"]
    assert config["observability"]["head_sampling_rate"] == 0
    assert config["observability"]["logs"]["enabled"] is True
    assert config["observability"]["logs"]["invocation_logs"] is False


def test_scheduled_time_accepts_integral_python_and_javascript_number_representations():
    assert _scheduled_epoch_seconds(1_800_000_000_999) == 1_800_000_000
    assert _scheduled_epoch_seconds(1_800_000_000_999.0) == 1_800_000_000
    for invalid in (None, 0, -1, True, 1.5, float("nan"), float("inf"), "1800000000000"):
        with pytest.raises(ValueError): _scheduled_epoch_seconds(invalid)


def test_cleanup_worker_runs_exactly_one_bounded_parameterized_batch():
    database = FakeD1([{"jti": "expired-request-000001"}])
    removed = asyncio.run(run_nonce_cleanup(database, scheduled_time_ms=1_800_000_000_000))
    assert removed == 1
    assert database.calls == [(NONCE_CLEANUP_SQL, (1_800_000_000, MAX_CLEANUP_BATCH))]


def test_cleanup_worker_fails_closed_without_database_binding():
    with pytest.raises(RequestReplayStorageError, match="cleanup is unavailable"):
        asyncio.run(run_nonce_cleanup(None, scheduled_time_ms=1_800_000_000_000))


def test_cleanup_worker_propagates_storage_failure_without_exposing_details():
    database = FakeD1(error=True)
    with pytest.raises(RequestReplayStorageError, match="cleanup is unavailable") as error:
        asyncio.run(run_nonce_cleanup(database, scheduled_time_ms=1_800_000_000_000))
    assert "private database diagnostic" not in str(error.value)


def test_scheduled_entrypoint_uses_only_tenant_db_binding_and_platform_time():
    database = FakeD1()
    worker = object.__new__(Default)
    controller = SimpleNamespace(scheduledTime=1_800_000_000_000.0)
    env = SimpleNamespace(TENANT_DB=database)
    asyncio.run(worker.scheduled(controller, env, None))
    assert database.calls == [(NONCE_CLEANUP_SQL, (1_800_000_000, MAX_CLEANUP_BATCH))]


def test_scheduled_worker_cleans_sqlite_migrated_replay_store_across_repeated_invocations(tmp_path):
    import sqlite3
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    connection = sqlite3.connect(tmp_path / "scheduled-cleanup.sqlite")
    connection.executescript((root / "migrations/0001_initial.sql").read_text(encoding="utf-8"))
    connection.executescript((root / "migrations/0002_tenant_isolation.sql").read_text(encoding="utf-8"))
    connection.executescript((root / "migrations/0003_internal_request_nonces.sql").read_text(encoding="utf-8"))

    class SQLiteStatement:
        def __init__(self, sql):
            self.sql = sql
            self.parameters = ()

        def bind(self, *parameters):
            self.parameters = parameters
            return self

        async def run(self):
            cursor = connection.execute(self.sql, self.parameters)
            rows = [{"jti": row[0]} for row in cursor.fetchall()]
            connection.commit()
            return SimpleNamespace(success=True, results=rows)

    class SQLiteD1:
        def prepare(self, sql): return SQLiteStatement(sql)

    now = 1_800_000_000
    expired = [
        (f"expired-retained-{index:06d}", now - 86_500, now - 1, now - 86_560)
        for index in range(MAX_CLEANUP_BATCH + 1)
    ]
    connection.executemany(
        "INSERT INTO internal_request_nonces (jti, expires_at, retained_until, consumed_at) VALUES (?, ?, ?, ?)",
        expired + [("still-retained-00000001", now - 10, now + 10, now - 70)],
    )
    database = SQLiteD1()
    worker = object.__new__(Default)
    env = SimpleNamespace(TENANT_DB=database)

    asyncio.run(worker.scheduled(SimpleNamespace(scheduledTime=(now * 1000) + 999.0), env, None))
    remaining = {
        row[0] for row in connection.execute(
            "SELECT jti FROM internal_request_nonces ORDER BY jti"
        ).fetchall()
    }
    assert remaining == {"still-retained-00000001", f"expired-retained-{MAX_CLEANUP_BATCH:06d}"}

    asyncio.run(worker.scheduled(SimpleNamespace(scheduledTime=((now + 1) * 1000.0)), env, None))
    remaining = {
        row[0] for row in connection.execute(
            "SELECT jti FROM internal_request_nonces ORDER BY jti"
        ).fetchall()
    }
    assert remaining == {"still-retained-00000001"}
    connection.close()

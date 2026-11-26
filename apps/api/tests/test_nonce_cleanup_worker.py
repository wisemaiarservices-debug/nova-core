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


def test_scheduled_time_is_converted_from_milliseconds_without_bool_coercion():
    assert _scheduled_epoch_seconds(1_800_000_000_999) == 1_800_000_000
    for invalid in (None, 0, -1, True, 1.5, "1800000000000"):
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
    controller = SimpleNamespace(scheduledTime=1_800_000_000_000)
    env = SimpleNamespace(TENANT_DB=database)
    asyncio.run(worker.scheduled(controller, env, None))
    assert database.calls == [(NONCE_CLEANUP_SQL, (1_800_000_000, MAX_CLEANUP_BATCH))]

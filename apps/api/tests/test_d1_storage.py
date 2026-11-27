from __future__ import annotations

import asyncio

from apps.api.services.d1_storage import EXPECTED_TABLES, inspect_d1_binding, storage_status


class Result:
    def __init__(self, results, success=True):
        self.results = results
        self.success = success


class Statement:
    def __init__(self, result):
        self.result = result
        self.parameters = ()

    def bind(self, *parameters):
        self.parameters = parameters
        return self

    async def run(self):
        return self.result


class Database:
    def __init__(self, result):
        self.result = result
        self.sql = None

    def prepare(self, sql):
        self.sql = sql
        return Statement(self.result)


def table_result(names, *, success=True):
    return Result([{"name": name} for name in names], success=success)


def test_inspect_d1_binding_requires_explicit_success_and_complete_rows():
    database = Database(table_result(EXPECTED_TABLES))
    status = asyncio.run(inspect_d1_binding(database))
    assert status["status"] == "ready"
    assert status["present_tables"] == sorted(EXPECTED_TABLES)
    assert database.sql is not None


def test_inspect_d1_binding_fails_on_unsuccessful_result_even_with_rows():
    database = Database(table_result(EXPECTED_TABLES, success=False))
    try:
        asyncio.run(inspect_d1_binding(database))
    except RuntimeError as exc:
        assert "unsuccessful or incomplete" in str(exc)
    else:
        raise AssertionError("unsuccessful D1 result must not report ready")


def test_inspect_d1_binding_fails_on_missing_success_metadata():
    class IncompleteResult:
        results = [{"name": name} for name in EXPECTED_TABLES]

    database = Database(IncompleteResult())
    try:
        asyncio.run(inspect_d1_binding(database))
    except RuntimeError as exc:
        assert "unsuccessful or incomplete" in str(exc)
    else:
        raise AssertionError("incomplete D1 result must not report ready")


def test_inspect_d1_binding_fails_on_malformed_rows():
    database = Database(Result([{"name": "sites"}, "not-a-row"]))
    try:
        asyncio.run(inspect_d1_binding(database))
    except RuntimeError as exc:
        assert "invalid result set" in str(exc)
    else:
        raise AssertionError("malformed D1 rows must be rejected")


def test_storage_status_reports_unavailable_for_failed_d1_envelope():
    database = Database(table_result(EXPECTED_TABLES, success=False))
    status = asyncio.run(storage_status(database))
    assert status["status"] == "unavailable"
    assert status["present_tables"] == []
    assert status["writes_performed"] is False


def test_inspect_d1_binding_normalizes_pyodide_result_proxies():
    class Proxy:
        def __init__(self, value):
            self.value = value

        def to_py(self):
            return self.value

    class ProxyResult:
        success = Proxy(True)
        results = Proxy([Proxy({"name": name}) for name in EXPECTED_TABLES])

    status = asyncio.run(inspect_d1_binding(Database(ProxyResult())))
    assert status["status"] == "ready"
    assert status["present_tables"] == sorted(EXPECTED_TABLES)

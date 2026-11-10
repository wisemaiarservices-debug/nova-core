import asyncio
from types import SimpleNamespace

from apps.api.services.d1_storage import EXPECTED_TABLES, inspect_d1_binding


class _Rows:
    def __init__(self, rows):
        self._rows = rows

    def to_py(self):
        return self._rows


class _Statement:
    def __init__(self, rows):
        self.rows = rows

    def bind(self, *_args):
        return self

    async def all(self):
        return SimpleNamespace(results=_Rows(self.rows))


class _Database:
    def __init__(self, rows=None, fail=False):
        self.rows = rows or []
        self.fail = fail

    def prepare(self, _query):
        if self.fail:
            raise RuntimeError("private database failure")
        return _Statement(self.rows)


def test_d1_status_is_unconfigured_without_worker_env():
    result = asyncio.run(inspect_d1_binding(None))
    assert result["status"] == "unconfigured"
    assert result["query_succeeded"] is False
    assert result["writes_enabled"] is False


def test_d1_status_is_unconfigured_without_db_binding():
    result = asyncio.run(inspect_d1_binding(SimpleNamespace()))
    assert result["status"] == "unconfigured"
    assert result["binding"] == "DB"


def test_d1_status_ready_only_when_expected_schema_exists():
    rows = [{"name": name} for name in sorted(EXPECTED_TABLES)]
    result = asyncio.run(inspect_d1_binding(SimpleNamespace(DB=_Database(rows))))
    assert result["status"] == "ready"
    assert result["query_succeeded"] is True
    assert result["missing_tables"] == []
    assert result["writes_enabled"] is False


def test_d1_status_reports_incomplete_schema():
    rows = [{"name": "sites"}, {"name": "assets"}]
    result = asyncio.run(inspect_d1_binding(SimpleNamespace(DB=_Database(rows))))
    assert result["status"] == "schema_incomplete"
    assert "observations" in result["missing_tables"]
    assert result["writes_enabled"] is False


def test_d1_status_hides_database_exception_details():
    result = asyncio.run(
        inspect_d1_binding(SimpleNamespace(DB=_Database(fail=True)))
    )
    assert result["status"] == "unavailable"
    assert result["query_succeeded"] is False
    assert "private database failure" not in result["detail"]

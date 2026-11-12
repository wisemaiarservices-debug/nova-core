import re
import sqlite3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = ROOT.parent.parent
TENANT_API = REPOSITORY_ROOT / "tenant-api" / "src" / "index.mjs"
MIGRATIONS = ROOT / "migrations"


def test_private_tenant_api_sql_compiles_against_ordered_schema_migrations():
    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA foreign_keys = ON")
    for migration in (
        MIGRATIONS / "0001_initial.sql",
        MIGRATIONS / "0002_tenant_isolation.sql",
        MIGRATIONS / "0003_internal_request_nonces.sql",
    ):
        db.executescript(migration.read_text(encoding="utf-8"))

    source = TENANT_API.read_text(encoding="utf-8")
    statements = re.findall(r'"((?:SELECT|INSERT INTO)\\s+[^"]+)"', source)
    assert len(statements) >= 8, "expected resource, membership, grant and nonce SQL"

    for statement in statements:
        placeholders = statement.count("?")
        db.execute("EXPLAIN " + statement, [None] * placeholders).fetchall()


def test_private_tenant_api_has_all_five_resource_queries():
    source = TENANT_API.read_text(encoding="utf-8")
    for table in ("sites", "assets", "sources", "observations", "audit_events"):
        assert re.search(rf"FROM {table} WHERE tenant_id = \\? AND id = \\?", source)

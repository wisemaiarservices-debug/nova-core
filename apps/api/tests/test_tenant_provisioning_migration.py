from pathlib import Path
import sqlite3
import unittest


ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "migrations"


class TenantProvisioningMigrationTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.executescript("""
            CREATE TABLE tenants (
              id TEXT PRIMARY KEY,
              display_name TEXT NOT NULL,
              status TEXT NOT NULL
            );
        """)
        self.db.executescript((MIGRATIONS / "0017_tenant_provisioning_idempotency.sql").read_text())
        self.db.execute(
            "INSERT INTO tenants(id, display_name, status) VALUES ('tenant-a', 'Research tenant', 'active')"
        )

    def tearDown(self):
        self.db.close()

    def insert_request(self, request_id="request-1", actor="access-subject-a",
                       key="bootstrap-1", digest="a" * 64, tenant="tenant-a"):
        self.db.execute("""
            INSERT INTO tenant_provisioning_requests
              (id, actor_subject, idempotency_key, request_sha256, tenant_id)
            VALUES (?, ?, ?, ?, ?)
        """, (request_id, actor, key, digest, tenant))

    def test_records_actor_key_digest_and_tenant(self):
        self.insert_request()
        row = self.db.execute("""
            SELECT actor_subject, idempotency_key, request_sha256, tenant_id
            FROM tenant_provisioning_requests
        """).fetchone()
        self.assertEqual(row, ("access-subject-a", "bootstrap-1", "a" * 64, "tenant-a"))

    def test_actor_and_idempotency_key_are_unique(self):
        self.insert_request()
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert_request(request_id="request-2")

    def test_request_digest_must_be_lowercase_sha256_hex(self):
        for digest in ("A" * 64, "g" * 64, "short"):
            with self.subTest(digest=digest), self.assertRaises(sqlite3.IntegrityError):
                self.insert_request(request_id="bad-" + str(len(digest)) + digest[:1], digest=digest)

    def test_provisioning_requests_are_immutable(self):
        self.insert_request()
        with self.assertRaisesRegex(sqlite3.IntegrityError, "immutable"):
            self.db.execute(
                "UPDATE tenant_provisioning_requests SET request_sha256=? WHERE id='request-1'",
                ("b" * 64,),
            )
        with self.assertRaisesRegex(sqlite3.IntegrityError, "immutable"):
            self.db.execute("DELETE FROM tenant_provisioning_requests WHERE id='request-1'")

    def test_request_cannot_reference_unknown_tenant(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert_request(tenant="missing-tenant")


if __name__ == "__main__":
    unittest.main()

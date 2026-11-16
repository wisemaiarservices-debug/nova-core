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
        self.db.executescript((MIGRATIONS / "0026_tenant_provisioning_identity_binding.sql").read_text())
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

    def test_request_binds_verified_supabase_identity_and_nova_os_tenant(self):
        self.db.execute("""
            INSERT INTO tenant_provisioning_requests
              (id, actor_subject, idempotency_key, request_sha256, tenant_id,
               supabase_issuer, supabase_subject, nova_os_tenant_id, nova_os_assertion_jti, nova_os_receipt_jti)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, ("request-bound", "access-subject-a", "bootstrap-bound", "b" * 64,
              "tenant-a", "https://project.example.test/auth/v1",
              "supabase-user-a", "nova-tenant-a", "owner-proof-a", "receipt-one"))
        row = self.db.execute("""
            SELECT supabase_issuer, supabase_subject, nova_os_tenant_id, nova_os_assertion_jti, nova_os_receipt_jti
            FROM tenant_provisioning_requests WHERE id='request-bound'
        """).fetchone()
        self.assertEqual(row, ("https://project.example.test/auth/v1",
                               "supabase-user-a", "nova-tenant-a", "owner-proof-a", "receipt-one"))

    def test_identity_binding_must_be_complete(self):
        with self.assertRaisesRegex(sqlite3.IntegrityError, "identity binding"):
            self.db.execute("""
                INSERT INTO tenant_provisioning_requests
                  (id, actor_subject, idempotency_key, request_sha256, tenant_id,
                   supabase_issuer, supabase_subject)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, ("request-partial", "access-subject-a", "bootstrap-partial",
                  "c" * 64, "tenant-a", "https://project.example.test/auth/v1",
                  "supabase-user-a"))

    def test_nova_os_tenant_can_be_provisioned_only_once(self):
        self.db.execute("""
            INSERT INTO tenant_provisioning_requests
              (id, actor_subject, idempotency_key, request_sha256, tenant_id,
               supabase_issuer, supabase_subject, nova_os_tenant_id, nova_os_assertion_jti, nova_os_receipt_jti)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, ("request-bound", "access-subject-a", "bootstrap-bound", "b" * 64,
              "tenant-a", "https://project.example.test/auth/v1",
              "supabase-user-a", "nova-tenant-a", "owner-proof-a"))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                INSERT INTO tenant_provisioning_requests
                  (id, actor_subject, idempotency_key, request_sha256, tenant_id,
                   supabase_issuer, supabase_subject, nova_os_tenant_id, nova_os_assertion_jti, nova_os_receipt_jti)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, ("request-second", "access-subject-b", "bootstrap-second", "d" * 64,
                  "tenant-a", "https://project.example.test/auth/v1",
                  "supabase-user-b", "nova-tenant-a", "owner-proof-b"))

    def test_owner_assertion_jti_is_unique_across_provisioning_records(self):
        self.db.execute("""
            INSERT INTO tenant_provisioning_requests
              (id, actor_subject, idempotency_key, request_sha256, tenant_id,
               supabase_issuer, supabase_subject, nova_os_tenant_id, nova_os_assertion_jti, nova_os_receipt_jti)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, ("request-one", "access-a", "key-one", "e" * 64, "tenant-a",
              "https://project.example.test/auth/v1", "user-a", "nova-a", "proof-shared", "receipt-a"))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                INSERT INTO tenant_provisioning_requests
                  (id, actor_subject, idempotency_key, request_sha256, tenant_id,
                   supabase_issuer, supabase_subject, nova_os_tenant_id, nova_os_assertion_jti, nova_os_receipt_jti)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, ("request-two", "access-b", "key-two", "f" * 64, "tenant-a",
                  "https://project.example.test/auth/v1", "user-b", "nova-b", "proof-shared", "receipt-b"))

    def test_request_cannot_reference_unknown_tenant(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert_request(tenant="missing-tenant")


if __name__ == "__main__":
    unittest.main()

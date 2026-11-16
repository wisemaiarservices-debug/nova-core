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
        self.db.executescript((MIGRATIONS / "0034_nova_os_owner_authorization_permit.sql").read_text())
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

    def insert_bound_request(self, request_id, actor, key, digest, tenant,
                             supabase_issuer, supabase_subject, nova_tenant,
                             assertion_jti, receipt_jti, permit_jti):
        self.db.execute("""
            INSERT INTO tenant_provisioning_requests
              (id, actor_subject, idempotency_key, request_sha256, tenant_id,
               supabase_issuer, supabase_subject, nova_os_tenant_id,
               nova_os_assertion_jti, nova_os_receipt_jti, access_issuer,
               nova_os_authorization_permit_jti, nova_os_authorization_permit_issuer,
               nova_os_authorization_permit_audience, nova_os_authorization_permit_key_id,
               nova_os_authorization_correlation_id, nova_os_authorization_permit_issued_at,
               nova_os_authorization_permit_expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (request_id, actor, key, digest, tenant, supabase_issuer, supabase_subject,
              nova_tenant, assertion_jti, receipt_jti, "https://access.example.test",
              permit_jti, "https://nova-os.example.test/authorization",
              "nova-core-owner-authorization", "nova-os-test-key",
              "nova-provision:" + digest, 100, 220))

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

    def test_request_binds_verified_supabase_identity_and_authorization_permit(self):
        digest = "b" * 64
        self.insert_bound_request(
            "request-bound", "access-subject-a", "bootstrap-bound", digest, "tenant-a",
            "https://project.example.test/auth/v1", "supabase-user-a", "nova-tenant-a",
            "owner-proof-a", "receipt-one", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        )
        row = self.db.execute("""
            SELECT supabase_issuer, supabase_subject, nova_os_tenant_id,
                   nova_os_assertion_jti, nova_os_receipt_jti, access_issuer,
                   nova_os_authorization_permit_jti, nova_os_authorization_permit_issuer,
                   nova_os_authorization_permit_audience, nova_os_authorization_permit_key_id,
                   nova_os_authorization_correlation_id, nova_os_authorization_permit_issued_at,
                   nova_os_authorization_permit_expires_at
            FROM tenant_provisioning_requests WHERE id='request-bound'
        """).fetchone()
        self.assertEqual(row, (
            "https://project.example.test/auth/v1", "supabase-user-a", "nova-tenant-a",
            "owner-proof-a", "receipt-one", "https://access.example.test",
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "https://nova-os.example.test/authorization",
            "nova-core-owner-authorization", "nova-os-test-key", "nova-provision:" + digest, 100, 220,
        ))

    def test_new_nova_os_binding_requires_complete_verified_permit_claims(self):
        with self.assertRaisesRegex(sqlite3.IntegrityError, "authorization permit"):
            self.db.execute("""
                INSERT INTO tenant_provisioning_requests
                  (id, actor_subject, idempotency_key, request_sha256, tenant_id,
                   supabase_issuer, supabase_subject, nova_os_tenant_id,
                   nova_os_assertion_jti, nova_os_receipt_jti)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, ("request-no-permit", "access-a", "key-no-permit", "c" * 64, "tenant-a",
                  "https://project.example.test/auth/v1", "user-a", "nova-a", "proof-a", "receipt-a"))

    def test_permit_binding_is_immutable(self):
        self.insert_bound_request(
            "request-immutable", "access-immutable", "key-immutable", "d" * 64, "tenant-a",
            "https://project.example.test/auth/v1", "supabase-immutable", "nova-immutable",
            "proof-immutable", "receipt-immutable", "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        )
        with self.assertRaisesRegex(sqlite3.IntegrityError, "permit binding is immutable"):
            self.db.execute("""
                UPDATE tenant_provisioning_requests
                SET nova_os_authorization_permit_jti = ?
                WHERE id = 'request-immutable'
            """, ("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",))

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
        self.insert_bound_request(
            "request-bound", "access-a", "bootstrap-bound", "b" * 64, "tenant-a",
            "https://project.example.test/auth/v1", "supabase-user-a", "nova-tenant-a",
            "owner-proof-a", "receipt-one", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        )
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert_bound_request(
                "request-second", "access-b", "bootstrap-second", "d" * 64, "tenant-a",
                "https://project.example.test/auth/v1", "supabase-user-b", "nova-tenant-a",
                "owner-proof-b", "receipt-two", "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            )

    def test_owner_assertion_jti_is_unique_across_provisioning_records(self):
        self.insert_bound_request(
            "request-one", "access-a", "key-one", "e" * 64, "tenant-a",
            "https://project.example.test/auth/v1", "user-a", "nova-a",
            "proof-shared", "receipt-a", "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        )
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert_bound_request(
                "request-two", "access-b", "key-two", "f" * 64, "tenant-a",
                "https://project.example.test/auth/v1", "user-b", "nova-b",
                "proof-shared", "receipt-b", "ffffffff-ffff-4fff-8fff-ffffffffffff",
            )

    def test_request_cannot_reference_unknown_tenant(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert_request(tenant="missing-tenant")


if __name__ == "__main__":
    unittest.main()

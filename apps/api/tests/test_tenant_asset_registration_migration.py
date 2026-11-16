from pathlib import Path
import sqlite3
import unittest


ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "migrations" / "0027_tenant_asset_registration.sql"


class TenantAssetRegistrationMigrationTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.executescript("""
            CREATE TABLE tenants (id TEXT PRIMARY KEY, status TEXT NOT NULL);
            CREATE TABLE sites (
              id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL,
              UNIQUE (id, tenant_id)
            );
            CREATE TABLE assets (
              id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, site_id TEXT NOT NULL,
              status TEXT NOT NULL, name TEXT NOT NULL, asset_type TEXT NOT NULL,
              external_ref TEXT,
              UNIQUE (id, tenant_id, site_id)
            );
            CREATE TABLE tenant_memberships (
              id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, subject TEXT NOT NULL,
              role TEXT NOT NULL, status TEXT NOT NULL
            );
            CREATE TABLE tenant_resource_grants (
              id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, subject TEXT NOT NULL,
              resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, action TEXT NOT NULL
            );
            INSERT INTO tenants VALUES ('tenant-a', 'active');
            INSERT INTO sites VALUES ('site-a', 'tenant-a', 'active');
            INSERT INTO tenant_memberships VALUES
              ('membership-a', 'tenant-a', 'owner-sub', 'tenant_owner', 'active');
            INSERT INTO assets VALUES
              ('asset-a', 'tenant-a', 'site-a', 'unconfigured', 'Pump 01', 'pump', NULL);
        """)
        self.db.executescript(MIGRATION.read_text())

    def tearDown(self):
        self.db.close()

    def test_asset_event_and_idempotency_record_require_exact_active_owner_scope(self):
        self.db.execute("""
          INSERT INTO tenant_asset_events
            (id, tenant_id, site_id, asset_id, actor_subject, event_type, request_id)
          VALUES ('event-a', 'tenant-a', 'site-a', 'asset-a', 'owner-sub', 'created', 'request-a')
        """)
        self.db.execute("""
          INSERT INTO tenant_asset_creation_requests
            (id, tenant_id, site_id, actor_subject, idempotency_key, request_sha256,
             asset_id, request_id)
          VALUES ('request-row-a', 'tenant-a', 'site-a', 'owner-sub', 'key-a',
                  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                  'asset-a', 'request-a')
        """)
        self.assertEqual(self.db.execute(
            "SELECT COUNT(*) FROM tenant_asset_events"
        ).fetchone()[0], 1)
        self.assertEqual(self.db.execute(
            "SELECT COUNT(*) FROM tenant_asset_creation_requests"
        ).fetchone()[0], 1)

    def test_asset_events_and_idempotency_records_are_immutable(self):
        self.db.execute("""
          INSERT INTO tenant_asset_events
            (id, tenant_id, site_id, asset_id, actor_subject, event_type, request_id)
          VALUES ('event-a', 'tenant-a', 'site-a', 'asset-a', 'owner-sub', 'created', 'request-a')
        """)
        with self.assertRaisesRegex(sqlite3.IntegrityError, "append-only"):
            self.db.execute("UPDATE tenant_asset_events SET event_type='created' WHERE id='event-a'")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "append-only"):
            self.db.execute("DELETE FROM tenant_asset_events WHERE id='event-a'")

    def test_non_owner_and_inactive_tenant_cannot_create_asset_events(self):
        self.db.execute("UPDATE tenant_memberships SET role='tenant_admin' WHERE subject='owner-sub'")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "active owner"):
            self.db.execute("""
              INSERT INTO tenant_asset_events
                (id, tenant_id, site_id, asset_id, actor_subject, event_type, request_id)
              VALUES ('event-b', 'tenant-a', 'site-a', 'asset-a', 'owner-sub', 'created', 'request-b')
            """)
        self.db.execute("UPDATE tenant_memberships SET role='tenant_owner' WHERE subject='owner-sub'")
        self.db.execute("UPDATE tenants SET status='suspended' WHERE id='tenant-a'")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "active owner"):
            self.db.execute("""
              INSERT INTO tenant_asset_events
                (id, tenant_id, site_id, asset_id, actor_subject, event_type, request_id)
              VALUES ('event-c', 'tenant-a', 'site-a', 'asset-a', 'owner-sub', 'created', 'request-c')
            """)

    def test_idempotency_key_is_unique_per_tenant_actor_and_site_scope(self):
        self.db.execute("""
          INSERT INTO tenant_asset_events
            (id, tenant_id, site_id, asset_id, actor_subject, event_type, request_id)
          VALUES ('event-a', 'tenant-a', 'site-a', 'asset-a', 'owner-sub', 'created', 'request-a')
        """)
        self.db.execute("""
          INSERT INTO tenant_asset_events
            (id, tenant_id, site_id, asset_id, actor_subject, event_type, request_id)
          VALUES ('event-b', 'tenant-a', 'site-a', 'asset-a', 'owner-sub', 'created', 'request-b')
        """)
        values = ("request-row-a", "tenant-a", "site-a", "owner-sub", "key-a",
                  "a" * 64, "asset-a", "request-a")
        self.db.execute("""
          INSERT INTO tenant_asset_creation_requests
            (id, tenant_id, site_id, actor_subject, idempotency_key, request_sha256, asset_id, request_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, values)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
              INSERT INTO tenant_asset_creation_requests
                (id, tenant_id, site_id, actor_subject, idempotency_key, request_sha256, asset_id, request_id)
              VALUES ('request-row-b', 'tenant-a', 'site-a', 'owner-sub', 'key-a',
                      ?, 'asset-a', 'request-b')
            """, ("b" * 64,))

    def test_migration_declares_composite_tenant_site_asset_foreign_keys(self):
        sql = MIGRATION.read_text()
        self.assertIn("FOREIGN KEY (asset_id, tenant_id, site_id)", sql)
        self.assertIn("UNIQUE (tenant_id, actor_subject, idempotency_key)", sql)
        self.assertIn("tenant_asset_creation_request_insert_guard", sql)


if __name__ == "__main__":
    unittest.main()

from pathlib import Path
import sqlite3
import unittest


ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "migrations"


class TenantResourceGrantEventsMigrationTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.executescript("""
            CREATE TABLE tenants (id TEXT PRIMARY KEY, status TEXT NOT NULL);
            CREATE TABLE tenant_resource_grants (
              id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, subject TEXT NOT NULL,
              resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, action TEXT NOT NULL,
              FOREIGN KEY (tenant_id) REFERENCES tenants(id)
            );
            INSERT INTO tenants VALUES ('tenant-a', 'active');
            INSERT INTO tenant_resource_grants VALUES
              ('grant-asset', 'tenant-a', 'member-sub', 'asset', 'asset-a', 'read'),
              ('grant-source', 'tenant-a', 'member-sub', 'source', 'source-a', 'ingest'),
              ('grant-observation', 'tenant-a', 'member-sub', 'observation', 'obs-a', 'read');
        """)
        self.db.executescript(
            (MIGRATIONS / "0020_tenant_resource_grant_events.sql").read_text()
        )

    def tearDown(self):
        self.db.close()

    def insert_event(self, *, event_id="event-a", grant_id="grant-asset",
                     resource_type="asset", resource_id="asset-a",
                     event_type="granted", request_id="request-a", grant_action="read"):
        self.db.execute("""
            INSERT INTO tenant_resource_grant_events
              (id, tenant_id, grant_id, subject, resource_type, resource_id,
               grant_action, event_type, actor_subject, reason, request_id)
            VALUES (?, 'tenant-a', ?, 'member-sub', ?, ?, ?, ?,
                    'owner-sub', 'approved exact resource access', ?)
        """, (event_id, grant_id, resource_type, resource_id, grant_action, event_type, request_id))

    def test_granted_events_cover_exact_asset_source_and_observation_scopes(self):
        self.insert_event()
        self.insert_event(event_id="event-source", grant_id="grant-source",
                          resource_type="source", resource_id="source-a",
                          event_type="granted", request_id="request-source", grant_action="ingest")
        self.insert_event(event_id="event-observation", grant_id="grant-observation",
                          resource_type="observation", resource_id="obs-a",
                          event_type="granted", request_id="request-observation")
        count = self.db.execute(
            "SELECT COUNT(*) FROM tenant_resource_grant_events"
        ).fetchone()[0]
        self.assertEqual(count, 3)

    def test_revocation_event_requires_exact_grant_to_be_absent(self):
        self.db.execute("DELETE FROM tenant_resource_grants WHERE id='grant-asset'")
        self.insert_event(event_type="revoked")
        self.assertEqual(self.db.execute(
            "SELECT event_type FROM tenant_resource_grant_events"
        ).fetchone()[0], "revoked")

    def test_event_rejects_wrong_tenant_subject_type_or_resource(self):
        for values in [
            ("other-sub", "asset", "asset-a"),
            ("member-sub", "source", "asset-a"),
            ("member-sub", "asset", "different-asset"),
        ]:
            with self.subTest(values=values):
                with self.assertRaisesRegex(sqlite3.IntegrityError, "does not match grant state"):
                    self.db.execute("""
                        INSERT INTO tenant_resource_grant_events
                          (id, tenant_id, grant_id, subject, resource_type, resource_id,
                           grant_action, event_type, actor_subject, reason, request_id)
                        VALUES (?, 'tenant-a', 'grant-asset', ?, ?, ?, 'read', 'granted',
                                'owner-sub', 'mismatched event', ?)
                    """, ("bad-" + values[0] + values[1], *values, "req-" + values[0] + values[1]))

    def test_event_rows_are_append_only_and_request_ids_unique(self):
        self.insert_event()
        with self.assertRaisesRegex(sqlite3.IntegrityError, "append-only"):
            self.db.execute(
                "UPDATE tenant_resource_grant_events SET reason='tampered' WHERE id='event-a'"
            )
        with self.assertRaisesRegex(sqlite3.IntegrityError, "append-only"):
            self.db.execute("DELETE FROM tenant_resource_grant_events WHERE id='event-a'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert_event(event_id="event-b", request_id="request-a")

    def test_unsupported_scope_and_manage_members_action_are_rejected(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                INSERT INTO tenant_resource_grant_events
                  (id, tenant_id, grant_id, subject, resource_type, resource_id,
                   grant_action, event_type, actor_subject, reason, request_id)
                VALUES ('bad-type', 'tenant-a', 'grant-asset', 'member-sub', 'tenant',
                        'tenant-a', 'read', 'granted', 'owner-sub', 'bad type', 'bad-type')
            """)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                INSERT INTO tenant_resource_grant_events
                  (id, tenant_id, grant_id, subject, resource_type, resource_id,
                   grant_action, event_type, actor_subject, reason, request_id)
                VALUES ('bad-action', 'tenant-a', 'grant-asset', 'member-sub', 'asset',
                        'asset-a', 'manage_members', 'granted', 'owner-sub', 'bad action', 'bad-action')
            """)


if __name__ == "__main__":
    unittest.main()

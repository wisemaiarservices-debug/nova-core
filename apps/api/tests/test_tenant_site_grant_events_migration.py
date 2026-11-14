from pathlib import Path
import sqlite3
import unittest


ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "migrations"


class TenantSiteGrantEventsMigrationTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.executescript("""
            CREATE TABLE tenants (id TEXT PRIMARY KEY, status TEXT NOT NULL);
            CREATE TABLE tenant_resource_grants (
              id TEXT PRIMARY KEY,
              tenant_id TEXT NOT NULL,
              subject TEXT NOT NULL,
              resource_type TEXT NOT NULL,
              resource_id TEXT NOT NULL,
              action TEXT NOT NULL,
              FOREIGN KEY (tenant_id) REFERENCES tenants(id)
            );
            INSERT INTO tenants(id, status) VALUES ('tenant-a', 'active');
            INSERT INTO tenant_resource_grants
              (id, tenant_id, subject, resource_type, resource_id, action)
            VALUES ('grant-a', 'tenant-a', 'member-sub', 'site', 'site-a', 'read');
        """)
        self.db.executescript(
            (MIGRATIONS / "0019_tenant_site_grant_events.sql").read_text()
        )

    def tearDown(self):
        self.db.close()

    def event(self, event_id="event-a", event_type="granted", grant_id="grant-a",
              request_id="request-a"):
        self.db.execute("""
            INSERT INTO tenant_site_grant_events
              (id, tenant_id, grant_id, subject, site_id, grant_action,
               event_type, actor_subject, reason, request_id)
            VALUES (?, 'tenant-a', ?, 'member-sub', 'site-a', 'read',
                    ?, 'owner-sub', 'approved site access', ?)
        """, (event_id, grant_id, event_type, request_id))

    def test_granted_event_requires_the_exact_grant_to_exist(self):
        self.event()
        row = self.db.execute(
            "SELECT event_type, grant_id FROM tenant_site_grant_events"
        ).fetchone()
        self.assertEqual(row, ("granted", "grant-a"))

    def test_revoked_event_requires_the_exact_grant_to_be_absent(self):
        self.db.execute("DELETE FROM tenant_resource_grants WHERE id='grant-a'")
        self.event(event_type="revoked")
        row = self.db.execute(
            "SELECT event_type FROM tenant_site_grant_events"
        ).fetchone()[0]
        self.assertEqual(row, "revoked")

    def test_event_cannot_claim_a_grant_for_another_subject_or_scope(self):
        with self.assertRaisesRegex(sqlite3.IntegrityError, "does not match grant state"):
            self.db.execute("""
                INSERT INTO tenant_site_grant_events
                  (id, tenant_id, grant_id, subject, site_id, grant_action,
                   event_type, actor_subject, reason, request_id)
                VALUES ('event-b', 'tenant-a', 'grant-a', 'other-sub',
                  'site-a', 'read', 'granted', 'owner-sub', 'forged scope', 'request-b')
            """)

    def test_event_rows_are_append_only_and_request_ids_unique(self):
        self.event()
        with self.assertRaisesRegex(sqlite3.IntegrityError, "append-only"):
            self.db.execute(
                "UPDATE tenant_site_grant_events SET reason='changed' WHERE id='event-a'"
            )
        with self.assertRaisesRegex(sqlite3.IntegrityError, "append-only"):
            self.db.execute("DELETE FROM tenant_site_grant_events WHERE id='event-a'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.event(event_id="event-b", request_id="request-a")


if __name__ == "__main__":
    unittest.main()

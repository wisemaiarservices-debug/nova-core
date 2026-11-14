from pathlib import Path
import sqlite3
import unittest


ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "migrations"


class TenantLifecycleEventsMigrationTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.executescript("""
            CREATE TABLE tenants (
              id TEXT PRIMARY KEY,
              status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'archived'))
            );
            CREATE TABLE tenant_memberships (
              id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, subject TEXT NOT NULL,
              role TEXT NOT NULL, status TEXT NOT NULL
            );
            INSERT INTO tenants(id, status) VALUES ('tenant-a', 'active'), ('tenant-b', 'suspended');
            INSERT INTO tenant_memberships(id, tenant_id, subject, role, status)
              VALUES ('owner-a', 'tenant-a', 'owner-sub', 'tenant_owner', 'active'),
                     ('owner-b', 'tenant-b', 'owner-sub', 'tenant_owner', 'active');
        """)
        self.db.executescript((MIGRATIONS / "0021_tenant_lifecycle_events.sql").read_text())

    def tearDown(self):
        self.db.close()

    def event(self, event_id="event-1", tenant="tenant-a", actor="owner-sub",
              event_type="suspended", previous="active", new="suspended", request="request-1"):
        self.db.execute("""
            INSERT INTO tenant_lifecycle_events
              (id, tenant_id, actor_subject, event_type, previous_status, new_status, reason, request_id)
            VALUES (?, ?, ?, ?, ?, ?, 'approved operational reason', ?)
        """, (event_id, tenant, actor, event_type, previous, new, request))

    def test_matching_event_allows_suspension_and_reactivation(self):
        self.event()
        self.db.execute("UPDATE tenants SET status='suspended', last_lifecycle_event_id='event-1' WHERE id='tenant-a'")
        self.event(event_id="event-2", event_type="reactivated", previous="suspended",
                   new="active", request="request-2")
        self.db.execute("UPDATE tenants SET status='active', last_lifecycle_event_id='event-2' WHERE id='tenant-a'")
        self.assertEqual(self.db.execute(
            "SELECT status FROM tenants WHERE id='tenant-a'").fetchone()[0], "active")

    def test_status_change_without_event_is_rejected(self):
        with self.assertRaisesRegex(sqlite3.IntegrityError, "matching immutable event"):
            self.db.execute("UPDATE tenants SET status='suspended' WHERE id='tenant-a'")

    def test_event_must_match_current_tenant_prestate(self):
        with self.assertRaisesRegex(sqlite3.IntegrityError, "pre-state"):
            self.event(previous="suspended")

    def test_archival_is_terminal(self):
        self.event(event_type="archived", previous="active", new="archived")
        self.db.execute("UPDATE tenants SET status='archived', last_lifecycle_event_id='event-1' WHERE id='tenant-a'")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "terminal"):
            self.db.execute("UPDATE tenants SET status='active' WHERE id='tenant-a'")

    def test_suspended_tenant_can_be_archived(self):
        self.event(event_id="event-b", tenant="tenant-b", event_type="archived",
                   previous="suspended", new="archived", request="request-b")
        self.db.execute("UPDATE tenants SET status='archived', last_lifecycle_event_id='event-b' WHERE id='tenant-b'")
        self.assertEqual(self.db.execute(
            "SELECT status FROM tenants WHERE id='tenant-b'").fetchone()[0], "archived")

    def test_invalid_transition_shapes_are_rejected(self):
        for values in [
            ("suspended", "suspended", "active"),
            ("reactivated", "active", "suspended"),
            ("archived", "active", "suspended"),
        ]:
            with self.subTest(values=values), self.assertRaises(sqlite3.IntegrityError):
                self.event(event_id="bad-" + values[0], event_type=values[0],
                           previous=values[1], new=values[2], request="bad-" + values[0])

    def test_consumed_lifecycle_event_cannot_be_replayed(self):
        self.event()
        self.db.execute("UPDATE tenants SET status='suspended', last_lifecycle_event_id='event-1' WHERE id='tenant-a'")
        self.event(event_id="event-2", event_type="reactivated", previous="suspended",
                   new="active", request="request-2")
        self.db.execute("UPDATE tenants SET status='active', last_lifecycle_event_id='event-2' WHERE id='tenant-a'")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "UNIQUE constraint failed"):
            self.db.execute("UPDATE tenants SET status='suspended', last_lifecycle_event_id='event-1' WHERE id='tenant-a'")

    def test_non_owner_cannot_write_lifecycle_event(self):
        with self.assertRaisesRegex(sqlite3.IntegrityError, "pre-state"):
            self.event(actor="viewer-sub")

    def test_event_pointer_cannot_change_without_status(self):
        with self.assertRaisesRegex(sqlite3.IntegrityError, "pointer requires a status transition"):
            self.db.execute("UPDATE tenants SET last_lifecycle_event_id='fake' WHERE id='tenant-a'")

    def test_lifecycle_events_are_append_only(self):
        self.event()
        with self.assertRaisesRegex(sqlite3.IntegrityError, "append-only"):
            self.db.execute("UPDATE tenant_lifecycle_events SET reason='rewritten' WHERE id='event-1'")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "append-only"):
            self.db.execute("DELETE FROM tenant_lifecycle_events WHERE id='event-1'")

    def test_request_ids_are_unique(self):
        self.event()
        with self.assertRaises(sqlite3.IntegrityError):
            self.event(event_id="event-2")


if __name__ == "__main__":
    unittest.main()

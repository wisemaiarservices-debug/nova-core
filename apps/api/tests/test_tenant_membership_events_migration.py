from pathlib import Path
import sqlite3
import unittest


ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "migrations"


class TenantMembershipEventsMigrationTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.executescript("""
            CREATE TABLE tenants (
              id TEXT PRIMARY KEY,
              status TEXT NOT NULL
            );
            CREATE TABLE tenant_memberships (
              id TEXT PRIMARY KEY,
              tenant_id TEXT NOT NULL,
              subject TEXT NOT NULL,
              role TEXT NOT NULL,
              status TEXT NOT NULL,
              UNIQUE(id, tenant_id),
              FOREIGN KEY(tenant_id) REFERENCES tenants(id)
            );
            INSERT INTO tenants(id, status) VALUES ('tenant-a', 'active');
            INSERT INTO tenant_memberships(id, tenant_id, subject, role, status)
              VALUES ('membership-a', 'tenant-a', 'owner-sub', 'tenant_owner', 'active');
        """)
        self.db.executescript((MIGRATIONS / "0016_tenant_membership_events.sql").read_text())

    def tearDown(self):
        self.db.close()

    def event(self, **overrides):
        values = {
            "id": "event-1",
            "tenant_id": "tenant-a",
            "membership_id": "membership-a",
            "subject": "owner-sub",
            "actor_subject": "owner-sub",
            "event_type": "role_changed",
            "previous_role": "tenant_owner",
            "new_role": "tenant_admin",
            "previous_status": "active",
            "new_status": "active",
            "reason": "approved role change",
            "request_id": "request-1",
        }
        values.update(overrides)
        columns = ", ".join(values)
        placeholders = ", ".join("?" for _ in values)
        self.db.execute(
            f"INSERT INTO tenant_membership_events ({columns}) VALUES ({placeholders})",
            tuple(values.values()),
        )

    def test_matching_event_allows_role_change(self):
        self.db.execute("""
            INSERT INTO tenant_memberships(id, tenant_id, subject, role, status)
            VALUES ('membership-b', 'tenant-a', 'owner-two', 'tenant_owner', 'active')
        """)
        self.event()
        self.db.execute(
            "UPDATE tenant_memberships SET role='tenant_admin' WHERE id='membership-a'"
        )
        role = self.db.execute(
            "SELECT role FROM tenant_memberships WHERE id='membership-a'"
        ).fetchone()[0]
        self.assertEqual(role, "tenant_admin")

    def test_role_change_without_event_is_rejected(self):
        with self.assertRaisesRegex(sqlite3.IntegrityError, "matching immutable event"):
            self.db.execute(
                "UPDATE tenant_memberships SET role='tenant_admin' WHERE id='membership-a'"
            )

    def test_event_must_match_membership_prestate(self):
        with self.assertRaisesRegex(sqlite3.IntegrityError, "pre-state"):
            self.event(previous_role="tenant_admin")

    def test_last_active_owner_cannot_be_demoted(self):
        self.event()
        with self.assertRaisesRegex(sqlite3.IntegrityError, "last active tenant owner"):
            self.db.execute(
                "UPDATE tenant_memberships SET role='tenant_admin' WHERE id='membership-a'"
            )

    def test_owner_can_be_demoted_when_another_active_owner_exists(self):
        self.db.execute("""
            INSERT INTO tenant_memberships(id, tenant_id, subject, role, status)
            VALUES ('membership-b', 'tenant-a', 'owner-two', 'tenant_owner', 'active')
        """)
        self.event()
        self.db.execute(
            "UPDATE tenant_memberships SET role='tenant_admin' WHERE id='membership-a'"
        )
        self.assertEqual(self.db.execute(
            "SELECT role FROM tenant_memberships WHERE id='membership-a'"
        ).fetchone()[0], "tenant_admin")

    def test_membership_events_are_append_only(self):
        self.event()
        with self.assertRaisesRegex(sqlite3.IntegrityError, "append-only"):
            self.db.execute(
                "UPDATE tenant_membership_events SET reason='rewritten' WHERE id='event-1'"
            )
        with self.assertRaisesRegex(sqlite3.IntegrityError, "append-only"):
            self.db.execute(
                "DELETE FROM tenant_membership_events WHERE id='event-1'"
            )

    def test_event_request_id_is_unique(self):
        self.event()
        with self.assertRaises(sqlite3.IntegrityError):
            self.event(id="event-2")

    def test_invalid_transition_shape_is_rejected(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.event(event_type="suspended", new_status="active")


if __name__ == "__main__":
    unittest.main()

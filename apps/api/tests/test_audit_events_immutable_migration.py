from pathlib import Path
import sqlite3
import unittest


MIGRATION = Path(__file__).resolve().parents[1] / "migrations" / "0066_audit_events_immutable.sql"


class AuditEventsImmutableMigrationTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.executescript("""
          CREATE TABLE tenants (id TEXT PRIMARY KEY);
          INSERT INTO tenants VALUES ('tenant-a');
          INSERT INTO tenants VALUES ('tenant-b');
          CREATE TABLE audit_events (
            id TEXT PRIMARY KEY,
            tenant_id TEXT,
            actor_type TEXT NOT NULL,
            actor_id TEXT,
            action TEXT NOT NULL,
            entity_type TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            occurred_at TEXT NOT NULL,
            request_id TEXT,
            details_json TEXT NOT NULL
          );
          -- Preserve the tenant-existence check introduced in migration 0002.
          CREATE TRIGGER audit_events_tenant_update_guard
          BEFORE UPDATE OF tenant_id ON audit_events
          WHEN NEW.tenant_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM tenants WHERE id = NEW.tenant_id)
          BEGIN
            SELECT RAISE(ABORT, 'audit event tenant does not exist');
          END;
          INSERT INTO audit_events VALUES
            ('audit-a', 'tenant-a', 'operator', 'operator-a', 'site.updated',
             'site', 'site-a', '2026-11-25T00:00:00Z', 'request-a', '{}');
          INSERT INTO audit_events VALUES
            ('audit-legacy', NULL, 'system', NULL, 'legacy.imported',
             'legacy', 'legacy-a', '2026-11-24T00:00:00Z', NULL, '{}');
        """)
        self.db.executescript(MIGRATION.read_text(encoding="utf-8"))

    def tearDown(self):
        self.db.close()

    def test_new_audit_event_inserts_remain_allowed(self):
        self.db.execute(
            "INSERT INTO audit_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("audit-new", "tenant-a", "service", "service-a", "observation.accepted",
             "observation", "obs-a", "2026-11-25T00:01:00Z", "request-new", "{}"),
        )
        self.assertEqual(
            self.db.execute("SELECT COUNT(*) FROM audit_events WHERE id = 'audit-new'").fetchone()[0],
            1,
        )

    def test_audit_payload_cannot_be_updated(self):
        with self.assertRaisesRegex(sqlite3.IntegrityError, "audit events are immutable"):
            self.db.execute(
                "UPDATE audit_events SET details_json = ? WHERE id = ?",
                ('{"changed":true}', "audit-a"),
            )

    def test_tenant_scoped_event_cannot_be_moved_between_tenants(self):
        with self.assertRaisesRegex(sqlite3.IntegrityError, "audit events are immutable"):
            self.db.execute(
                "UPDATE audit_events SET tenant_id = ? WHERE id = ?",
                ("tenant-b", "audit-a"),
            )

    def test_audit_event_cannot_be_deleted(self):
        with self.assertRaisesRegex(sqlite3.IntegrityError, "audit events cannot be deleted"):
            self.db.execute("DELETE FROM audit_events WHERE id = ?", ("audit-a",))

    def test_legacy_event_can_receive_one_time_tenant_assignment(self):
        self.db.execute(
            "UPDATE audit_events SET tenant_id = ? WHERE id = ?",
            ("tenant-a", "audit-legacy"),
        )
        self.assertEqual(
            self.db.execute(
                "SELECT tenant_id FROM audit_events WHERE id = 'audit-legacy'"
            ).fetchone()[0],
            "tenant-a",
        )
        with self.assertRaisesRegex(sqlite3.IntegrityError, "audit events are immutable"):
            self.db.execute(
                "UPDATE audit_events SET tenant_id = ? WHERE id = ?",
                ("tenant-b", "audit-legacy"),
            )

    def test_legacy_tenant_assignment_rejects_unknown_tenant(self):
        with self.assertRaisesRegex(sqlite3.IntegrityError, "audit event tenant does not exist"):
            self.db.execute(
                "UPDATE audit_events SET tenant_id = ? WHERE id = ?",
                ("tenant-missing", "audit-legacy"),
            )

    def test_legacy_tenant_assignment_cannot_change_audit_payload(self):
        with self.assertRaisesRegex(sqlite3.IntegrityError, "audit events are immutable"):
            self.db.execute(
                "UPDATE audit_events SET tenant_id = ?, details_json = ? WHERE id = ?",
                ("tenant-a", '{"changed":true}', "audit-legacy"),
            )


if __name__ == "__main__":
    unittest.main()

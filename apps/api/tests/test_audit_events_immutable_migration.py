from pathlib import Path
import sqlite3
import unittest


ROOT = Path(__file__).resolve().parents[1]
INITIAL_MIGRATION = ROOT / "migrations" / "0001_initial.sql"
TENANT_MIGRATION = ROOT / "migrations" / "0002_tenant_isolation.sql"
IMMUTABILITY_MIGRATION = ROOT / "migrations" / "0066_audit_events_immutable.sql"


class AuditEventsImmutableMigrationTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        # Apply the real schema and tenant-isolation migrations so this test
        # exercises the actual tenant guard alongside the immutability guard.
        self.db.executescript(INITIAL_MIGRATION.read_text(encoding="utf-8"))
        self.db.executescript(TENANT_MIGRATION.read_text(encoding="utf-8"))
        self.db.executemany(
            "INSERT INTO tenants (id, display_name) VALUES (?, ?)",
            [("tenant-a", "Tenant A"), ("tenant-b", "Tenant B")],
        )
        self.db.execute(
            """
            INSERT INTO audit_events (
              id, tenant_id, actor_type, actor_id, action, entity_type,
              entity_id, occurred_at, request_id, details_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            ("audit-a", "tenant-a", "operator", "operator-a", "site.updated",
             "site", "site-a", "2026-11-25T00:00:00Z", "request-a", "{}"),
        )
        self.db.execute(
            """
            INSERT INTO audit_events (
              id, tenant_id, actor_type, actor_id, action, entity_type,
              entity_id, occurred_at, request_id, details_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            ("audit-legacy", None, "system", None, "legacy.imported",
             "legacy", "legacy-a", "2026-11-24T00:00:00Z", None, "{}"),
        )
        self.db.executescript(IMMUTABILITY_MIGRATION.read_text(encoding="utf-8"))

    def tearDown(self):
        self.db.close()

    def test_new_audit_event_inserts_remain_allowed(self):
        self.db.execute(
            """
            INSERT INTO audit_events (
              id, actor_type, actor_id, action, entity_type, entity_id,
              occurred_at, request_id, details_json, tenant_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            ("audit-new", "service", "service-a", "observation.accepted",
             "observation", "obs-a", "2026-11-25T00:01:00Z", "request-new", "{}", "tenant-a"),
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

    def test_replace_cannot_overwrite_an_existing_audit_event(self):
        with self.assertRaisesRegex(sqlite3.IntegrityError, "audit events are immutable"):
            self.db.execute(
                """
                INSERT OR REPLACE INTO audit_events (
                  id, actor_type, actor_id, action, entity_type, entity_id,
                  occurred_at, request_id, details_json, tenant_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                ("audit-a", "attacker", "attacker-a", "audit.rewritten",
                 "audit", "audit-a", "2026-11-25T00:02:00Z", "request-rewrite",
                 '{"rewritten":true}', "tenant-b"),
            )
        self.assertEqual(
            self.db.execute(
                "SELECT tenant_id, action, details_json FROM audit_events WHERE id = 'audit-a'"
            ).fetchone(),
            ("tenant-a", "site.updated", "{}"),
        )

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

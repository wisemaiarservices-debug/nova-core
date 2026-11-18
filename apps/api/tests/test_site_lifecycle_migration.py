from pathlib import Path
import sqlite3
import unittest


MIGRATION = Path(__file__).resolve().parents[1] / "migrations" / "0040_site_lifecycle_governance.sql"


class SiteLifecycleMigrationTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.executescript("""
          CREATE TABLE tenants(id TEXT PRIMARY KEY,status TEXT NOT NULL);
          CREATE TABLE sites(
            id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,status TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT 'old'
          );
          CREATE TABLE tenant_memberships(
            tenant_id TEXT NOT NULL,subject TEXT NOT NULL,role TEXT NOT NULL,status TEXT NOT NULL
          );
          CREATE TABLE tenant_resource_grants(
            tenant_id TEXT NOT NULL,subject TEXT NOT NULL,resource_type TEXT NOT NULL,
            resource_id TEXT NOT NULL,action TEXT NOT NULL
          );
          INSERT INTO tenants VALUES('tenant-a','active');
          INSERT INTO sites(id,tenant_id,status) VALUES
            ('site-active','tenant-a','active'),
            ('site-inactive','tenant-a','inactive'),
            ('site-archived','tenant-a','archived'),
            ('site-unconfigured','tenant-a','unconfigured');
          INSERT INTO tenant_memberships VALUES
            ('tenant-a','owner','tenant_owner','active'),
            ('tenant-a','admin','tenant_admin','active'),
            ('tenant-a','operator','operator','active'),
            ('tenant-a','revoked-admin','tenant_admin','revoked');
          INSERT INTO tenant_resource_grants VALUES
            ('tenant-a','owner','site','site-active','read'),
            ('tenant-a','admin','site','site-active','read'),
            ('tenant-a','operator','site','site-active','read'),
            ('tenant-a','revoked-admin','site','site-active','read'),
            ('tenant-a','owner','site','site-inactive','read'),
            ('tenant-a','admin','site','site-inactive','read');
        """)
        self.db.executescript(MIGRATION.read_text(encoding="utf-8"))

    def tearDown(self):
        self.db.close()

    def event(self, event_id, site, actor, kind, previous, new, key=None):
        return self.db.execute(
            """INSERT INTO tenant_site_lifecycle_events
               (id,tenant_id,site_id,actor_subject,event_type,previous_status,
                new_status,reason,idempotency_key,request_id,occurred_at)
               VALUES(?, 'tenant-a', ?, ?, ?, ?, ?, 'approved operational reason',
                      ?, ?, '2026-11-18T12:00:00.000Z')""",
            (event_id, site, actor, kind, previous, new, key or event_id, "req-" + event_id),
        )

    def test_deactivation_is_atomic_and_audited(self):
        self.event("deactivate-1", "site-active", "owner", "deactivated", "active", "inactive")
        self.assertEqual(self.db.execute("SELECT status FROM sites WHERE id='site-active'").fetchone()[0], "inactive")
        self.assertEqual(self.db.execute("SELECT count(*) FROM tenant_site_lifecycle_applications").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT event_type FROM tenant_site_lifecycle_events").fetchone()[0], "deactivated")

    def test_reactivation_is_explicit_and_separate_event(self):
        self.event("deactivate-1", "site-active", "owner", "deactivated", "active", "inactive")
        self.event("reactivate-1", "site-active", "admin", "reactivated", "inactive", "active")
        self.assertEqual(self.db.execute("SELECT status FROM sites WHERE id='site-active'").fetchone()[0], "active")
        self.assertEqual(self.db.execute("SELECT count(*) FROM tenant_site_lifecycle_applications").fetchone()[0], 2)

    def test_direct_status_update_without_unused_event_is_rejected(self):
        with self.assertRaisesRegex(sqlite3.IntegrityError, "requires an unused governed lifecycle event"):
            self.db.execute("UPDATE sites SET status='inactive' WHERE id='site-active'")

    def test_role_membership_and_grant_are_required(self):
        for actor in ("operator", "revoked-admin"):
            with self.subTest(actor=actor), self.assertRaises(sqlite3.IntegrityError):
                self.event("bad-" + actor, "site-active", actor, "deactivated", "active", "inactive")
        with self.assertRaises(sqlite3.IntegrityError):
            self.event("bad-site", "site-unconfigured", "owner", "deactivated", "active", "inactive")

    def test_archived_and_unconfigured_sites_cannot_transition(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.event("archive", "site-archived", "owner", "deactivated", "active", "inactive")
        with self.assertRaises(sqlite3.IntegrityError):
            self.event("unconfigured", "site-unconfigured", "owner", "deactivated", "active", "inactive")

    def test_wrong_previous_state_and_cross_tenant_are_rejected(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.event("wrong-state", "site-active", "owner", "reactivated", "inactive", "active")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                """INSERT INTO tenant_site_lifecycle_events
                   (id,tenant_id,site_id,actor_subject,event_type,previous_status,new_status,
                    reason,idempotency_key,request_id,occurred_at)
                   VALUES('cross','tenant-other','site-active','owner','deactivated',
                          'active','inactive','reason','key','req-cross','2026-11-18T12:00:00Z')"""
            )

    def test_event_and_application_are_immutable(self):
        self.event("deactivate-1", "site-active", "owner", "deactivated", "active", "inactive")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "events are append-only"):
            self.db.execute("UPDATE tenant_site_lifecycle_events SET reason='changed'")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "applications are append-only"):
            self.db.execute("DELETE FROM tenant_site_lifecycle_applications")

    def test_replay_and_idempotency_collision_are_rejected(self):
        self.event("deactivate-1", "site-active", "owner", "deactivated", "active", "inactive", "same-key")
        with self.assertRaises(sqlite3.IntegrityError):
            self.event("deactivate-2", "site-inactive", "owner", "reactivated", "inactive", "active", "same-key")

    def test_event_and_status_change_roll_back_together(self):
        self.db.execute("CREATE TRIGGER force_application_failure BEFORE INSERT ON tenant_site_lifecycle_applications BEGIN SELECT RAISE(ABORT,'forced application failure'); END")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "forced application failure"):
            self.event("deactivate-rollback", "site-active", "owner", "deactivated", "active", "inactive")
        self.assertEqual(self.db.execute("SELECT status FROM sites WHERE id='site-active'").fetchone()[0], "active")
        self.assertEqual(self.db.execute("SELECT count(*) FROM tenant_site_lifecycle_events").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()

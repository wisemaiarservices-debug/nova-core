from pathlib import Path
import sqlite3
import unittest


ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = [
    ROOT / "migrations" / "0040_site_lifecycle_governance.sql",
    ROOT / "migrations" / "0042_site_lifecycle_command_recovery.sql",
    ROOT / "migrations" / "0043_site_lifecycle_command_resolver.sql",
]


class SiteLifecycleCommandMigrationTests(unittest.TestCase):
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
            ('site-inactive','tenant-a','inactive');
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
            ('tenant-a','owner','site','site-inactive','read');
        """)
        for migration in MIGRATIONS:
            self.db.executescript(migration.read_text(encoding="utf-8"))

    def tearDown(self):
        self.db.close()

    def command(self, command_id="command-1", actor="owner", site="site-active",
                action="deactivate", expected="active", reason="approved operational reason",
                digest="a" * 64):
        self.db.execute(
            """INSERT INTO tenant_site_lifecycle_commands
               (id,tenant_id,site_id,actor_subject,action,expected_status,reason,
                request_digest,status,created_at,updated_at)
               VALUES(?, 'tenant-a', ?, ?, ?, ?, ?, ?, 'pending',
                      '2026-11-19T12:00:00.000Z','2026-11-19T12:00:00.000Z')""",
            (command_id, site, actor, action, expected, reason, digest),
        )

    def apply(self, command_id="command-1", event_id="event-1", actor="owner",
              site="site-active", event_type="deactivated", previous="active",
              new="inactive", reason="approved operational reason", digest="a" * 64):
        return self.db.execute(
            """INSERT INTO tenant_site_lifecycle_events
               (id,tenant_id,site_id,actor_subject,event_type,previous_status,new_status,
                reason,idempotency_key,request_digest,request_id,occurred_at,command_id)
               VALUES(?, 'tenant-a', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (event_id, site, actor, event_type, previous, new, reason,
             "key-" + command_id, digest, "req-" + event_id,
             "2026-11-19T12:01:00.000Z", command_id),
        )

    def test_prepare_is_durable_and_has_append_only_prepared_event(self):
        self.command()
        row = self.db.execute(
            "SELECT status,event_id FROM tenant_site_lifecycle_commands WHERE id='command-1'"
        ).fetchone()
        self.assertEqual(row, ("pending", None))
        events = self.db.execute(
            "SELECT event_type FROM tenant_site_lifecycle_command_events WHERE command_id='command-1'"
        ).fetchall()
        self.assertEqual(events, [("prepared",)])

    def test_only_one_pending_command_per_site_even_across_actors(self):
        self.command()
        with self.assertRaisesRegex(sqlite3.IntegrityError, "UNIQUE constraint failed"):
            self.command(command_id="command-2", actor="admin")

    def test_command_requires_active_tenant_admin_membership_and_exact_site_grant(self):
        for actor in ("operator", "revoked-admin"):
            with self.subTest(actor=actor), self.assertRaises(sqlite3.IntegrityError):
                self.command(command_id="bad-" + actor, actor=actor)
        with self.assertRaises(sqlite3.IntegrityError):
            self.command(command_id="bad-site", site="site-inactive")
        self.db.execute("UPDATE tenants SET status='inactive' WHERE id='tenant-a'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.command(command_id="inactive-tenant")

    def test_exact_pending_command_is_consumed_atomically_by_lifecycle_event(self):
        self.command()
        self.apply()
        self.assertEqual(
            self.db.execute("SELECT status,event_id FROM tenant_site_lifecycle_commands WHERE id='command-1'").fetchone(),
            ("applied", "event-1"),
        )
        self.assertEqual(
            self.db.execute("SELECT status FROM sites WHERE id='site-active'").fetchone()[0],
            "inactive",
        )
        self.assertEqual(
            self.db.execute("SELECT event_type FROM tenant_site_lifecycle_command_events WHERE command_id='command-1' ORDER BY rowid").fetchall(),
            [("prepared",), ("applied",)],
        )
        self.assertEqual(
            self.db.execute("SELECT count(*) FROM tenant_site_lifecycle_applications").fetchone()[0],
            1,
        )

    def test_event_cannot_consume_wrong_digest_actor_reason_or_transition(self):
        self.command()
        for args in (
            {"digest": "b" * 64},
            {"actor": "admin"},
            {"reason": "different reason"},
            {"event_type": "reactivated", "previous": "inactive", "new": "active"},
        ):
            with self.subTest(args=args), self.assertRaisesRegex(sqlite3.IntegrityError, "exact pending command"):
                self.apply(**args)
        self.assertEqual(
            self.db.execute("SELECT status FROM tenant_site_lifecycle_commands WHERE id='command-1'").fetchone()[0],
            "pending",
        )

    def test_pending_command_can_be_terminally_rejected_and_is_audited(self):
        self.command()
        self.db.execute(
            """UPDATE tenant_site_lifecycle_commands
               SET status='rejected',rejection_code='site_status_changed',
                   updated_at='2026-11-19T12:02:00.000Z'
               WHERE id='command-1'"""
        )
        self.assertEqual(
            self.db.execute("SELECT status,rejection_code FROM tenant_site_lifecycle_commands WHERE id='command-1'").fetchone(),
            ("rejected", "site_status_changed"),
        )
        self.assertEqual(
            self.db.execute("SELECT event_type,rejection_code FROM tenant_site_lifecycle_command_events WHERE command_id='command-1' ORDER BY rowid DESC LIMIT 1").fetchone(),
            ("rejected", "site_status_changed"),
        )


    def test_abandoned_command_rejection_preserves_original_actor_and_records_resolver(self):
        self.command(actor="owner")
        self.db.execute(
            "UPDATE tenant_memberships SET status='revoked' WHERE tenant_id='tenant-a' AND subject='owner'"
        )
        self.db.execute(
            """UPDATE tenant_site_lifecycle_commands
               SET status='rejected',rejection_code='original_actor_revoked',
                   resolved_by_subject='admin',updated_at='2026-11-19T12:02:00.000Z'
               WHERE id='command-1'"""
        )
        command = self.db.execute(
            "SELECT actor_subject,resolved_by_subject,status FROM tenant_site_lifecycle_commands WHERE id='command-1'"
        ).fetchone()
        self.assertEqual(command, ("owner", "admin", "rejected"))
        event = self.db.execute(
            """SELECT actor_subject,performed_by_subject,event_type,rejection_code
               FROM tenant_site_lifecycle_command_events
               WHERE command_id='command-1' AND event_type='rejected'"""
        ).fetchone()
        self.assertEqual(event, ("owner", "admin", "rejected", "original_actor_revoked"))
        self.assertEqual(
            self.db.execute("SELECT status FROM sites WHERE id='site-active'").fetchone()[0],
            "active",
        )

    def test_admin_cannot_reject_a_still_valid_pending_command(self):
        self.command(actor="owner")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "not eligible for resolution"):
            self.db.execute(
                """UPDATE tenant_site_lifecycle_commands
                   SET status='rejected',rejection_code='operator_requested',
                       resolved_by_subject='admin',updated_at='2026-11-19T12:02:00.000Z'
                   WHERE id='command-1'"""
            )
        self.assertEqual(
            self.db.execute("SELECT status FROM tenant_site_lifecycle_commands WHERE id='command-1'").fetchone()[0],
            "pending",
        )

    def test_only_active_admin_with_exact_site_grant_can_resolve_abandoned_command(self):
        self.command(actor="owner")
        self.db.execute(
            "UPDATE tenant_memberships SET status='revoked' WHERE tenant_id='tenant-a' AND subject='owner'"
        )
        for resolver in ("operator", "revoked-admin", "missing-grant"):
            if resolver == "missing-grant":
                self.db.execute(
                    "DELETE FROM tenant_resource_grants WHERE tenant_id='tenant-a' AND subject='admin' AND resource_type='site' AND resource_id='site-active'"
                )
                resolver_subject = "admin"
            else:
                resolver_subject = resolver
            with self.subTest(resolver=resolver), self.assertRaisesRegex(
                sqlite3.IntegrityError, "not eligible for resolution"
            ):
                self.db.execute(
                    """UPDATE tenant_site_lifecycle_commands
                       SET status='rejected',rejection_code='original_actor_revoked',
                           resolved_by_subject=?,updated_at='2026-11-19T12:02:00.000Z'
                       WHERE id='command-1'""",
                    (resolver_subject,),
                )
            if resolver == "missing-grant":
                self.db.execute(
                    "INSERT INTO tenant_resource_grants VALUES('tenant-a','admin','site','site-active','read')"
                )

    def test_site_state_change_allows_audited_rejection_without_changing_site_again(self):
        self.command(actor="owner")
        self.db.execute(
            """INSERT INTO tenant_site_lifecycle_events
               (id,tenant_id,site_id,actor_subject,event_type,previous_status,new_status,
                reason,idempotency_key,request_digest,request_id,occurred_at)
               VALUES('legacy-event','tenant-a','site-active','admin','deactivated',
                'active','inactive','separate governed transition','legacy-key',?,
                'legacy-request','2026-11-19T12:01:00.000Z')""",
            ("c" * 64,),
        )
        self.db.execute(
            """UPDATE tenant_site_lifecycle_commands
               SET status='rejected',rejection_code='site_status_changed',
                   resolved_by_subject='admin',updated_at='2026-11-19T12:02:00.000Z'
               WHERE id='command-1'"""
        )
        self.assertEqual(
            self.db.execute("SELECT status FROM sites WHERE id='site-active'").fetchone()[0],
            "inactive",
        )
        self.assertEqual(
            self.db.execute(
                "SELECT performed_by_subject FROM tenant_site_lifecycle_command_events WHERE command_id='command-1' AND event_type='rejected'"
            ).fetchone()[0],
            "admin",
        )

    def test_terminal_commands_and_command_history_are_immutable(self):
        self.command()
        self.apply()
        with self.assertRaisesRegex(sqlite3.IntegrityError, "pending-to-terminal"):
            self.db.execute(
                "UPDATE tenant_site_lifecycle_commands SET reason='changed' WHERE id='command-1'"
            )
        with self.assertRaisesRegex(sqlite3.IntegrityError, "command events are append-only"):
            self.db.execute(
                "UPDATE tenant_site_lifecycle_command_events SET event_type='prepared'"
            )
        with self.assertRaisesRegex(sqlite3.IntegrityError, "command events are append-only"):
            self.db.execute("DELETE FROM tenant_site_lifecycle_command_events")

    def test_event_and_command_roll_back_together_when_site_application_fails(self):
        self.command()
        self.db.execute("""CREATE TRIGGER force_application_failure
          BEFORE INSERT ON tenant_site_lifecycle_applications
          BEGIN SELECT RAISE(ABORT,'forced application failure'); END""")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "forced application failure"):
            self.apply()
        self.assertEqual(
            self.db.execute("SELECT status,event_id FROM tenant_site_lifecycle_commands WHERE id='command-1'").fetchone(),
            ("pending", None),
        )
        self.assertEqual(
            self.db.execute("SELECT status FROM sites WHERE id='site-active'").fetchone()[0],
            "active",
        )
        self.assertEqual(
            self.db.execute("SELECT count(*) FROM tenant_site_lifecycle_events").fetchone()[0],
            0,
        )
        self.assertEqual(
            self.db.execute("SELECT event_type FROM tenant_site_lifecycle_command_events WHERE command_id='command-1'").fetchall(),
            [("prepared",)],
        )

    def test_existing_event_path_remains_compatible_until_runtime_cutover(self):
        self.db.execute(
            """INSERT INTO tenant_site_lifecycle_events
               (id,tenant_id,site_id,actor_subject,event_type,previous_status,new_status,
                reason,idempotency_key,request_digest,request_id,occurred_at)
               VALUES('legacy-event','tenant-a','site-active','owner','deactivated',
                'active','inactive','legacy approved reason','legacy-key',?,
                'legacy-request','2026-11-19T12:00:00.000Z')""",
            ("c" * 64,),
        )
        self.assertEqual(
            self.db.execute("SELECT status FROM sites WHERE id='site-active'").fetchone()[0],
            "inactive",
        )
        self.assertIsNone(
            self.db.execute("SELECT command_id FROM tenant_site_lifecycle_events WHERE id='legacy-event'").fetchone()[0]
        )


if __name__ == "__main__":
    unittest.main()

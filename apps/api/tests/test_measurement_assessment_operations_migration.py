from pathlib import Path
import sqlite3
import unittest


MIGRATION = Path(__file__).resolve().parents[1] / "migrations" / "0036_measurement_assessment_operations.sql"


class MeasurementAssessmentOperationsMigrationTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.executescript("""
          CREATE TABLE tenants (id TEXT PRIMARY KEY, status TEXT NOT NULL);
          CREATE TABLE sites (
            id TEXT NOT NULL, tenant_id TEXT NOT NULL,
            PRIMARY KEY(id, tenant_id), UNIQUE(id, tenant_id)
          );
          CREATE TABLE observations (
            id TEXT NOT NULL, tenant_id TEXT NOT NULL, site_id TEXT NOT NULL,
            PRIMARY KEY(id, tenant_id, site_id), UNIQUE(id, tenant_id, site_id),
            FOREIGN KEY(site_id, tenant_id) REFERENCES sites(id, tenant_id)
          );
          CREATE TABLE measurement_quality_assessments (
            id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, site_id TEXT NOT NULL,
            observation_id TEXT NOT NULL, status TEXT NOT NULL, request_id TEXT NOT NULL,
            UNIQUE(tenant_id, request_id),
            FOREIGN KEY(observation_id, tenant_id, site_id)
              REFERENCES observations(id, tenant_id, site_id)
          );
          INSERT INTO tenants VALUES ('tenant-a', 'active');
          INSERT INTO sites VALUES ('site-a', 'tenant-a');
          INSERT INTO observations VALUES ('obs-a', 'tenant-a', 'site-a');
          INSERT INTO observations VALUES ('obs-b', 'tenant-a', 'site-a');
        """)
        self.db.executescript(MIGRATION.read_text(encoding="utf-8"))

    def tearDown(self):
        self.db.close()

    def reserve(self, operation_id="op-a", actor="actor-a", observation="obs-a",
                tenant="tenant-a", site="site-a", predecessor=None):
        self.db.execute(
            """INSERT INTO measurement_assessment_operations
               (operation_id, tenant_id, site_id, observation_id, actor_subject,
                request_digest, state, predecessor_operation_id)
               VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?)""",
            (operation_id, tenant, site, observation, actor, "a" * 64, predecessor),
        )
        self.event(operation_id, actor, observation, None, "reserved", "reserved")

    def event(self, operation_id, actor, observation, previous, current, kind):
        self.db.execute(
            """INSERT INTO measurement_assessment_operation_events
               (event_id, operation_id, tenant_id, site_id, observation_id,
                actor_subject, from_state, to_state, event_type, request_id)
               VALUES (?, ?, 'tenant-a', 'site-a', ?, ?, ?, ?, ?, ?)""",
            ("event-" + operation_id + "-" + kind, operation_id, observation,
             actor, previous, current, kind, "request-" + kind),
        )

    def complete(self, operation_id="op-a", actor="actor-a", observation="obs-a"):
        self.db.execute(
            """UPDATE measurement_assessment_operations
               SET state='running', lease_version=1, attempt_count=1, lease_expires_at='2026-11-18T12:01:00Z'
               WHERE operation_id=?""",
            (operation_id,),
        )
        self.event(operation_id, actor, observation, "reserved", "running", "claimed")
        self.db.execute(
            """INSERT INTO measurement_quality_assessments
               (id, tenant_id, site_id, observation_id, status, request_id)
               VALUES (?, 'tenant-a', 'site-a', ?, 'passed', ?)""",
            ("assessment-" + operation_id, observation, operation_id),
        )
        self.db.execute(
            """UPDATE measurement_assessment_operations
               SET state='completed', assessment_id=?, completed_at='2026-11-18T12:00:00Z',
                   updated_at='2026-11-18T12:00:00Z'
               WHERE operation_id=?""",
            ("assessment-" + operation_id, operation_id),
        )
        self.event(operation_id, actor, observation, "running", "completed", "completed")

    def test_reservation_and_append_only_initial_event(self):
        self.reserve()
        row = self.db.execute(
            "SELECT state, actor_subject, request_digest FROM measurement_assessment_operations WHERE operation_id='op-a'"
        ).fetchone()
        self.assertEqual(row, ("reserved", "actor-a", "a" * 64))
        with self.assertRaisesRegex(sqlite3.IntegrityError, "events cannot be deleted"):
            self.db.execute("DELETE FROM measurement_assessment_operation_events")

    def test_only_one_unresolved_operation_per_actor_observation(self):
        self.reserve()
        with self.assertRaises(sqlite3.IntegrityError):
            self.reserve(operation_id="op-duplicate")
        self.reserve(operation_id="op-other-actor", actor="actor-b")
        self.reserve(operation_id="op-other-observation", observation="obs-b")

    def test_tenant_site_observation_scope_is_enforced(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.reserve(site="site-other")
        with self.assertRaises(sqlite3.IntegrityError):
            self.reserve(tenant="tenant-other")

    def test_identity_and_scope_are_immutable(self):
        self.reserve()
        with self.assertRaisesRegex(sqlite3.IntegrityError, "identity and scope are immutable"):
            self.db.execute(
                "UPDATE measurement_assessment_operations SET actor_subject='actor-b' WHERE operation_id='op-a'"
            )

    def test_state_transition_and_event_ledger(self):
        self.reserve()
        self.db.execute(
            "UPDATE measurement_assessment_operations SET state='running', lease_version=1, attempt_count=1, lease_expires_at='2026-11-18T12:01:00Z' WHERE operation_id='op-a'"
        )
        self.event("op-a", "actor-a", "obs-a", "reserved", "running", "claimed")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "transition is invalid"):
            self.db.execute(
                "UPDATE measurement_assessment_operations SET state='reserved' WHERE operation_id='op-a'"
            )

    def test_completed_operation_links_exact_immutable_assessment(self):
        self.reserve()
        self.complete()
        row = self.db.execute(
            "SELECT state, assessment_id FROM measurement_assessment_operations WHERE operation_id='op-a'"
        ).fetchone()
        self.assertEqual(row, ("completed", "assessment-op-a"))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                "UPDATE measurement_assessment_operations SET state='running' WHERE operation_id='op-a'"
            )
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("DELETE FROM measurement_assessment_operations WHERE operation_id='op-a'")

    def test_assessment_foreign_key_requires_exact_scope(self):
        self.reserve()
        self.db.execute(
            """INSERT INTO measurement_quality_assessments
               (id, tenant_id, site_id, observation_id, status, request_id)
               VALUES ('assessment-wrong', 'tenant-a', 'site-a', 'obs-b', 'passed', 'legacy-key')"""
        )
        self.db.execute(
            """UPDATE measurement_assessment_operations
               SET state='running', lease_version=1, attempt_count=1, lease_expires_at='2026-11-18T12:01:00Z'
               WHERE operation_id='op-a'"""
        )
        self.event("op-a", "actor-a", "obs-a", "reserved", "running", "claimed")
        # A scope-mismatched assessment cannot be attached to this operation.
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                """UPDATE measurement_assessment_operations
                   SET state='completed', assessment_id='assessment-wrong',
                       completed_at='2026-11-18T12:00:00Z'
                   WHERE operation_id='op-a'"""
            )

    def test_only_one_explicit_successor_per_completed_predecessor(self):
        self.reserve()
        self.complete()
        self.reserve(operation_id="op-successor", predecessor="op-a")
        with self.assertRaises(sqlite3.IntegrityError):
            self.reserve(operation_id="op-successor-duplicate", predecessor="op-a")

    def test_successor_requires_same_actor_and_completed_predecessor(self):
        self.reserve()
        with self.assertRaisesRegex(sqlite3.IntegrityError, "successor requires a completed operation"):
            self.reserve(operation_id="op-too-early", predecessor="op-a")
        self.complete()
        with self.assertRaisesRegex(sqlite3.IntegrityError, "successor requires a completed operation"):
            self.reserve(operation_id="op-wrong-actor", actor="actor-b", predecessor="op-a")

    def test_operation_event_must_match_current_state_and_actor(self):
        self.reserve()
        with self.assertRaisesRegex(sqlite3.IntegrityError, "event does not match"):
            self.event("op-a", "actor-b", "obs-a", "reserved", "running", "claimed")


    def test_running_operation_requires_bounded_lease_and_terminal_clears_it(self):
        self.reserve()
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                "UPDATE measurement_assessment_operations SET state='running' WHERE operation_id='op-a'"
            )
        self.db.execute(
            """UPDATE measurement_assessment_operations
               SET state='running', lease_version=1, attempt_count=1,
                   lease_expires_at='2026-11-18T12:01:00Z'
               WHERE operation_id='op-a'"""
        )
        self.event("op-a", "actor-a", "obs-a", "reserved", "running", "claimed")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                """UPDATE measurement_assessment_operations
                   SET state='failed', lease_expires_at='2026-11-18T12:01:00Z'
                   WHERE operation_id='op-a'"""
            )

    def test_event_type_must_match_transition(self):
        self.reserve()
        with self.assertRaisesRegex(sqlite3.IntegrityError, "event does not match"):
            self.event("op-a", "actor-a", "obs-a", None, "reserved", "claimed")


    def test_claim_event_cannot_omit_required_prior_state(self):
        self.db.execute(
            """INSERT INTO measurement_assessment_operations
               (operation_id, tenant_id, site_id, observation_id, actor_subject,
                request_digest, state)
               VALUES ('op-no-event', 'tenant-a', 'site-a', 'obs-a', 'actor-a', ?, 'reserved')""",
            ("a" * 64,),
        )
        self.db.execute(
            """UPDATE measurement_assessment_operations
               SET state='running', lease_version=1, attempt_count=1,
                   lease_expires_at='2026-11-18T12:01:00Z'
               WHERE operation_id='op-no-event'"""
        )
        with self.assertRaisesRegex(sqlite3.IntegrityError, "event does not match"):
            self.db.execute(
                """INSERT INTO measurement_assessment_operation_events
                   (event_id, operation_id, tenant_id, site_id, observation_id,
                    actor_subject, from_state, to_state, event_type, request_id)
                   VALUES ('bad-event', 'op-no-event', 'tenant-a', 'site-a', 'obs-a',
                           'actor-a', NULL, 'running', 'claimed', 'req-bad')"""
            )

    def test_operation_digest_must_be_lowercase_sha256_hex(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                """INSERT INTO measurement_assessment_operations
                   (operation_id, tenant_id, site_id, observation_id, actor_subject,
                    request_digest, state)
                   VALUES ('bad-digest', 'tenant-a', 'site-a', 'obs-a', 'actor-a', 'NOT-A-DIGEST', 'reserved')"""
            )


if __name__ == "__main__":
    unittest.main()

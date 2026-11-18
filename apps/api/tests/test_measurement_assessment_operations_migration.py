from pathlib import Path
import sqlite3
import unittest


MIGRATIONS = [Path(__file__).resolve().parents[1] / "migrations" / name for name in ("0036_measurement_assessment_operations.sql", "0037_measurement_assessment_operation_lease_fencing.sql", "0038_measurement_assessment_operation_terminal_audit.sql")]


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
        for migration in MIGRATIONS:
            self.db.executescript(migration.read_text(encoding="utf-8"))

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
               SET state='running', lease_version=1, attempt_count=1, lease_expires_at='2026-11-18T12:01:00Z', lease_request_id='request-claimed'
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
                   lease_expires_at=NULL, lease_request_id=NULL, terminal_request_id='request-completed', updated_at='2026-11-18T12:00:00Z'
               WHERE operation_id=?""",
            ("assessment-" + operation_id, operation_id),
        )

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
            "UPDATE measurement_assessment_operations SET state='running', lease_version=1, attempt_count=1, lease_expires_at='2026-11-18T12:01:00Z', lease_request_id='request-claimed' WHERE operation_id='op-a'"
        )
        self.event("op-a", "actor-a", "obs-a", "reserved", "running", "claimed")
        with self.assertRaises(sqlite3.IntegrityError):
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
               SET state='running', lease_version=1, attempt_count=1, lease_expires_at='2026-11-18T12:01:00Z', lease_request_id='request-claimed'
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
            self.event("op-a", "actor-b", "obs-a", "reserved", "not_assessed", "not_assessed")


    def test_running_operation_requires_bounded_lease_and_terminal_clears_it(self):
        self.reserve()
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                "UPDATE measurement_assessment_operations SET state='running' WHERE operation_id='op-a'"
            )
        self.db.execute(
            """UPDATE measurement_assessment_operations
               SET state='running', lease_version=1, attempt_count=1,
                   lease_expires_at='2026-11-18T12:01:00Z', lease_request_id='request-claimed'
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
            self.event("op-a", "actor-a", "obs-a", "reserved", "completed", "completed")


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
                   lease_expires_at='2026-11-18T12:01:00Z', lease_request_id='request-claimed'
               WHERE operation_id='op-no-event'"""
        )
        with self.assertRaisesRegex(sqlite3.IntegrityError, "event does not match"):
            self.db.execute(
                """INSERT INTO measurement_assessment_operation_events
                   (event_id, operation_id, tenant_id, site_id, observation_id,
                    actor_subject, from_state, to_state, event_type, request_id)
                   VALUES ('bad-event', 'op-no-event', 'tenant-a', 'site-a', 'obs-a',
                           'actor-a', NULL, 'running', 'claimed', 'request-claimed')"""
            )

    def test_operation_digest_must_be_lowercase_sha256_hex(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                """INSERT INTO measurement_assessment_operations
                   (operation_id, tenant_id, site_id, observation_id, actor_subject,
                    request_digest, state)
                   VALUES ('bad-digest', 'tenant-a', 'site-a', 'obs-a', 'actor-a', 'NOT-A-DIGEST', 'reserved')"""
            )

    def test_lease_events_are_fenced_to_the_winning_transport_request(self):
        self.reserve()
        self.db.execute(
            """UPDATE measurement_assessment_operations
               SET state='running', lease_version=1, attempt_count=1,
                   lease_expires_at='2026-11-18T12:01:00Z',
                   lease_request_id='winner-request'
               WHERE operation_id='op-a'"""
        )
        with self.assertRaisesRegex(sqlite3.IntegrityError, "lease event does not match the current fence"):
            self.db.execute(
                """INSERT INTO measurement_assessment_operation_events
                   (event_id, operation_id, tenant_id, site_id, observation_id,
                    actor_subject, from_state, to_state, event_type, request_id)
                   VALUES ('loser-event', 'op-a', 'tenant-a', 'site-a', 'obs-a',
                           'actor-a', 'reserved', 'running', 'claimed', 'loser-request')"""
            )
        self.db.execute(
            """INSERT INTO measurement_assessment_operation_events
               (event_id, operation_id, tenant_id, site_id, observation_id,
                actor_subject, from_state, to_state, event_type, request_id)
               VALUES ('winner-event', 'op-a', 'tenant-a', 'site-a', 'obs-a',
                       'actor-a', 'reserved', 'running', 'claimed', 'winner-request')"""
        )

    def test_lease_fence_changes_only_with_one_version_increment(self):
        self.reserve()
        self.db.execute(
            """UPDATE measurement_assessment_operations
               SET state='running', lease_version=1, attempt_count=1,
                   lease_expires_at='2026-11-18T12:01:00Z',
                   lease_request_id='request-claimed'
               WHERE operation_id='op-a'"""
        )
        self.event("op-a", "actor-a", "obs-a", "reserved", "running", "claimed")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "lease fencing is invalid"):
            self.db.execute(
                """UPDATE measurement_assessment_operations
                   SET lease_request_id='request-without-version-change'
                   WHERE operation_id='op-a'"""
            )
        self.db.execute(
            """UPDATE measurement_assessment_operations
               SET lease_version=2, attempt_count=2,
                   lease_expires_at='2026-11-18T12:02:00Z',
                   lease_request_id='request-lease_renewed'
               WHERE operation_id='op-a'"""
        )
        self.db.execute(
            """INSERT INTO measurement_assessment_operation_events
               (event_id, operation_id, tenant_id, site_id, observation_id,
                actor_subject, from_state, to_state, event_type, request_id)
               VALUES ('renew-event', 'op-a', 'tenant-a', 'site-a', 'obs-a',
                       'actor-a', 'running', 'running', 'lease_renewed', 'request-lease_renewed')"""
        )

    def test_running_operation_cannot_be_inserted_without_reservation(self):
        with self.assertRaisesRegex(sqlite3.IntegrityError, "must be reserved before it is claimed"):
            self.db.execute(
                """INSERT INTO measurement_assessment_operations
                   (operation_id, tenant_id, site_id, observation_id, actor_subject,
                    request_digest, state, lease_version, lease_expires_at, lease_request_id)
                   VALUES ('op-direct', 'tenant-a', 'site-a', 'obs-a', 'actor-a', ?, 'running',
                           1, '2026-11-18T12:01:00Z', 'direct-request')""",
                ("a" * 64,),
            )


    def test_terminal_transition_appends_its_event_atomically(self):
        self.reserve()
        self.complete()
        events = self.db.execute(
            "SELECT from_state, to_state, event_type, request_id FROM measurement_assessment_operation_events WHERE operation_id='op-a' ORDER BY rowid"
        ).fetchall()
        self.assertEqual(events, [
            (None, "reserved", "reserved", "request-reserved"),
            ("reserved", "running", "claimed", "request-claimed"),
            ("running", "completed", "completed", "request-completed"),
        ])

    def test_terminal_transition_without_request_id_or_exact_assessment_is_rejected(self):
        self.reserve()
        self.db.execute(
            """UPDATE measurement_assessment_operations
               SET state='running', lease_version=1, attempt_count=1,
                   lease_expires_at='2026-11-18T12:01:00Z', lease_request_id='request-claimed'
               WHERE operation_id='op-a'"""
        )
        self.event("op-a", "actor-a", "obs-a", "reserved", "running", "claimed")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "terminalization requires exact linked assessment"):
            self.db.execute(
                """UPDATE measurement_assessment_operations
                   SET state='completed', assessment_id=NULL, completed_at='2026-11-18T12:00:00Z',
                       lease_expires_at=NULL, lease_request_id=NULL, updated_at='2026-11-18T12:00:00Z'
                   WHERE operation_id='op-a'"""
            )

    def test_terminal_event_trigger_failure_rolls_back_operation_update(self):
        self.reserve()
        self.db.execute(
            """UPDATE measurement_assessment_operations
               SET state='running', lease_version=1, attempt_count=1,
                   lease_expires_at='2026-11-18T12:01:00Z', lease_request_id='request-claimed'
               WHERE operation_id='op-a'"""
        )
        self.event("op-a", "actor-a", "obs-a", "reserved", "running", "claimed")
        self.db.execute(
            """INSERT INTO measurement_quality_assessments
               (id, tenant_id, site_id, observation_id, status, request_id)
               VALUES ('assessment-op-a', 'tenant-a', 'site-a', 'obs-a', 'passed', 'op-a')"""
        )
        self.db.execute("""
          CREATE TRIGGER reject_terminal_event
          BEFORE INSERT ON measurement_assessment_operation_events
          WHEN NEW.event_type='completed'
          BEGIN SELECT RAISE(ABORT,'forced terminal audit failure'); END
        """)
        with self.assertRaisesRegex(sqlite3.IntegrityError, "forced terminal audit failure"):
            self.db.execute(
                """UPDATE measurement_assessment_operations
                   SET state='completed', assessment_id='assessment-op-a',
                       completed_at='2026-11-18T12:00:00Z', lease_expires_at=NULL,
                       lease_request_id=NULL, terminal_request_id='request-completed',
                       updated_at='2026-11-18T12:00:00Z'
                   WHERE operation_id='op-a'"""
            )
        state = self.db.execute(
            "SELECT state, assessment_id FROM measurement_assessment_operations WHERE operation_id='op-a'"
        ).fetchone()
        self.assertEqual(state, ("running", None))
        self.assertEqual(self.db.execute(
            "SELECT COUNT(*) FROM measurement_assessment_operation_events WHERE operation_id='op-a'"
        ).fetchone()[0], 2)

    def test_not_assessed_can_terminalize_from_reserved_with_atomic_event(self):
        self.reserve()
        self.db.execute(
            """INSERT INTO measurement_quality_assessments
               (id, tenant_id, site_id, observation_id, status, request_id)
               VALUES ('assessment-not-assessed', 'tenant-a', 'site-a', 'obs-a', 'not_assessed', 'op-a')"""
        )
        self.db.execute(
            """UPDATE measurement_assessment_operations
               SET state='not_assessed', assessment_id='assessment-not-assessed',
                   completed_at='2026-11-18T12:00:00Z',
                   terminal_request_id='request-not-assessed', updated_at='2026-11-18T12:00:00Z'
               WHERE operation_id='op-a'"""
        )
        event = self.db.execute(
            "SELECT from_state,to_state,event_type,request_id FROM measurement_assessment_operation_events WHERE operation_id='op-a' ORDER BY rowid DESC LIMIT 1"
        ).fetchone()
        self.assertEqual(event, ("reserved", "not_assessed", "not_assessed", "request-not-assessed"))

if __name__ == "__main__":
    unittest.main()

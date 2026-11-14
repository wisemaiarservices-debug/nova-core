from pathlib import Path
import sqlite3
import unittest


ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "migrations"


class TenantMembershipInvitationsMigrationTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.executescript("""
            CREATE TABLE tenants (id TEXT PRIMARY KEY, status TEXT NOT NULL);
            INSERT INTO tenants(id, status) VALUES ('tenant-a', 'active');
        """)
        self.db.executescript((MIGRATIONS / "0018_tenant_membership_invitations.sql").read_text())

    def tearDown(self):
        self.db.close()

    def invitation(self, invitation_id="invite-1", role="operator", token="a" * 64):
        self.db.execute("""
            INSERT INTO tenant_membership_invitations
              (id, tenant_id, role, token_sha256, created_by_subject, reason, request_id, expires_at)
            VALUES (?, 'tenant-a', ?, ?, 'owner-sub', 'approved access', ?, '2026-12-01T00:00:00Z')
        """, (invitation_id, role, token, "request-" + invitation_id))

    def event(self, event_id="event-1", invitation_id="invite-1", event_type="created",
              actor="owner-sub", subject=None, reason="approved access"):
        self.db.execute("""
            INSERT INTO tenant_membership_invitation_events
              (id, tenant_id, invitation_id, event_type, actor_subject, subject, reason, request_id)
            VALUES (?, 'tenant-a', ?, ?, ?, ?, ?, ?)
        """, (event_id, invitation_id, event_type, actor, subject, reason, "request-" + event_id))

    def test_only_non_owner_human_roles_can_be_invited(self):
        for role in ("tenant_owner", "service", "unknown"):
            with self.subTest(role=role), self.assertRaises(sqlite3.IntegrityError):
                self.invitation(invitation_id="bad-" + role, role=role)

    def test_invitation_creation_requires_a_matching_creation_event(self):
        self.invitation()
        self.event()
        row = self.db.execute(
            "SELECT status, role FROM tenant_membership_invitations WHERE id='invite-1'"
        ).fetchone()
        self.assertEqual(row, ("pending", "operator"))

    def test_acceptance_binds_the_authenticated_subject_and_requires_event(self):
        self.invitation()
        self.event()
        self.db.execute("""
            UPDATE tenant_membership_invitations
            SET status='accepted', accepted_by_subject='invitee-sub', accepted_at='2026-11-14T12:00:00Z'
            WHERE id='invite-1'
        """)
        self.event(event_id="event-accepted", event_type="accepted",
                   actor="invitee-sub", subject="invitee-sub")
        row = self.db.execute(
            "SELECT status, accepted_by_subject FROM tenant_membership_invitations WHERE id='invite-1'"
        ).fetchone()
        self.assertEqual(row, ("accepted", "invitee-sub"))

    def test_invalid_or_mutated_invitation_scope_is_rejected(self):
        self.invitation()
        self.event()
        with self.assertRaisesRegex(sqlite3.IntegrityError, "invalid or immutable"):
            self.db.execute("UPDATE tenant_membership_invitations SET role='tenant_owner' WHERE id='invite-1'")

    def test_invitation_event_must_match_current_invitation_state(self):
        self.invitation()
        with self.assertRaisesRegex(sqlite3.IntegrityError, "does not match invitation state"):
            self.event(event_type="accepted", actor="invitee-sub", subject="invitee-sub")

    def test_invitation_and_event_ledgers_are_immutable(self):
        self.invitation()
        self.event()
        with self.assertRaisesRegex(sqlite3.IntegrityError, "immutable"):
            self.db.execute("DELETE FROM tenant_membership_invitations WHERE id='invite-1'")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "append-only"):
            self.db.execute("UPDATE tenant_membership_invitation_events SET reason='changed' WHERE id='event-1'")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "append-only"):
            self.db.execute("DELETE FROM tenant_membership_invitation_events WHERE id='event-1'")

    def test_invitation_token_digest_and_request_ids_are_unique(self):
        self.invitation()
        self.event()
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
                INSERT INTO tenant_membership_invitations
                  (id, tenant_id, role, token_sha256, created_by_subject, reason, request_id, expires_at)
                VALUES ('invite-2', 'tenant-a', 'viewer', ?, 'owner-sub', 'reason', 'request-invite-2',
                  '2026-12-01T00:00:00Z')
            """, ("a" * 64,))
        with self.assertRaises(sqlite3.IntegrityError):
            self.event(event_id="event-1")


if __name__ == "__main__":
    unittest.main()

from pathlib import Path
import hashlib
import sqlite3
import unittest


ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "migrations"


class TenantIdentityLinkMigrationTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.executescript("""
            CREATE TABLE tenants (
              id TEXT PRIMARY KEY, status TEXT NOT NULL
            );
            CREATE TABLE tenant_memberships (
              id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, subject TEXT NOT NULL,
              role TEXT NOT NULL, status TEXT NOT NULL
            );
            INSERT INTO tenants VALUES ('tenant-a', 'active'), ('tenant-b', 'suspended');
            INSERT INTO tenant_memberships VALUES
              ('owner-a', 'tenant-a', 'owner-a-sub', 'tenant_owner', 'active'),
              ('admin-a', 'tenant-a', 'admin-a-sub', 'tenant_admin', 'active'),
              ('owner-b', 'tenant-b', 'owner-b-sub', 'tenant_owner', 'active');
        """)
        self.db.executescript((MIGRATIONS / "0022_tenant_identity_link_challenges.sql").read_text())

    def tearDown(self):
        self.db.close()

    def challenge(self, challenge_id="challenge-1", request_id="challenge-request-1"):
        digest = hashlib.sha256(challenge_id.encode()).hexdigest()
        self.db.execute("""
          INSERT INTO tenant_identity_link_challenges
          (id, supabase_issuer, supabase_subject, cloudflare_issuer, cloudflare_subject,
           challenge_sha256, status, created_at, expires_at, request_id)
          VALUES (?, 'https://project.supabase.co/auth/v1', 'supabase-sub',
                  'https://team.cloudflareaccess.com', 'cloudflare-sub',
                  ?, 'pending', '2026-11-14T10:00:00Z', '2026-11-14T10:05:00Z', ?)
        """, (challenge_id, digest, request_id))

    def consume(self, challenge_id="challenge-1", consumed_at="2026-11-14T10:01:00Z"):
        self.db.execute("""
          UPDATE tenant_identity_link_challenges SET status='consumed',
            consumed_at=? WHERE id=?
        """, (consumed_at, challenge_id))

    def request(self, request_id="link-request-1", challenge_id="challenge-1"):
        self.db.execute("""
          INSERT INTO tenant_identity_link_requests
          (id, challenge_id, supabase_issuer, supabase_subject, cloudflare_issuer,
           cloudflare_subject, request_id)
          VALUES (?, ?, 'https://project.supabase.co/auth/v1', 'supabase-sub',
                  'https://team.cloudflareaccess.com', 'cloudflare-sub', ?)
        """, (request_id, challenge_id, request_id + "-idem"))

    def event(self, event_id, link_id="link-request-1", event_type="requested",
              previous=None, new="pending", tenant=None, actor_issuer="https://team.cloudflareaccess.com",
              actor_subject="cloudflare-sub", reason="identity link requested", request_id="event-request"):
        self.db.execute("""
          INSERT INTO tenant_identity_link_events
          (id, link_request_id, event_type, previous_status, new_status, tenant_id,
           actor_cloudflare_issuer, actor_cloudflare_subject, reason, request_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (event_id, link_id, event_type, previous, new, tenant, actor_issuer,
              actor_subject, reason, request_id))

    def decide(self, status="approved", tenant="tenant-a", actor="owner-a-sub"):
        self.event("event-" + status, event_type=status, previous="pending", new=status,
                   tenant=tenant, actor_subject=actor, reason="owner decision",
                   request_id="event-" + status + "-request")
        self.db.execute("""
          UPDATE tenant_identity_link_requests SET status=?, tenant_id=?,
            decided_by_cloudflare_issuer='https://team.cloudflareaccess.com',
            decided_by_cloudflare_subject=?, reason='owner decision',
            decided_at='2026-11-14T10:02:00Z' WHERE id='link-request-1'
        """, (status, tenant, actor))

    def create_pending_request(self):
        self.challenge()
        self.consume()
        self.request()
        self.event("event-requested")

    def test_request_requires_consumed_matching_challenge(self):
        self.challenge()
        with self.assertRaisesRegex(sqlite3.IntegrityError, "matching consumed challenge"):
            self.request()
        self.consume()
        self.request()
        with self.assertRaises(sqlite3.IntegrityError):
            self.request(request_id="duplicate-request", challenge_id="challenge-1")

    def test_challenge_identity_and_digest_are_immutable_and_single_use(self):
        self.challenge()
        self.consume()
        with self.assertRaisesRegex(sqlite3.IntegrityError, "invalid or immutable"):
            self.db.execute("UPDATE tenant_identity_link_challenges SET status='pending', consumed_at=NULL WHERE id='challenge-1'")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "invalid or immutable"):
            self.db.execute("UPDATE tenant_identity_link_challenges SET supabase_subject='attacker' WHERE id='challenge-1'")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "immutable"):
            self.db.execute("DELETE FROM tenant_identity_link_challenges WHERE id='challenge-1'")

    def test_challenge_cannot_be_consumed_before_creation_or_after_expiry(self):
        self.challenge()
        with self.assertRaisesRegex(sqlite3.IntegrityError, "invalid or immutable"):
            self.consume(consumed_at="2026-11-14T09:59:59Z")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "invalid or immutable"):
            self.consume(consumed_at="2026-11-14T10:05:00Z")
        self.consume(consumed_at="2026-11-14T10:04:59Z")
        self.assertEqual(self.db.execute(
            "SELECT status FROM tenant_identity_link_challenges WHERE id='challenge-1'"
        ).fetchone()[0], "consumed")

    def test_pending_identity_pair_cannot_be_duplicated(self):
        self.create_pending_request()
        self.challenge("challenge-2", "challenge-request-2")
        self.consume("challenge-2")
        with self.assertRaises(sqlite3.IntegrityError):
            self.request("link-request-2", "challenge-2")

    def test_only_active_tenant_owner_can_approve_or_reject(self):
        self.create_pending_request()
        with self.assertRaisesRegex(sqlite3.IntegrityError, "owner authority"):
            self.event("bad-admin", event_type="approved", previous="pending", new="approved",
                       tenant="tenant-a", actor_subject="admin-a-sub", request_id="bad-admin-request")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "owner authority"):
            self.event("bad-suspended", event_type="approved", previous="pending", new="approved",
                       tenant="tenant-b", actor_subject="owner-b-sub", request_id="bad-suspended-request")
        self.decide()
        self.assertEqual(self.db.execute("SELECT status, tenant_id FROM tenant_identity_link_requests").fetchone(),
                         ("approved", "tenant-a"))

    def test_rejection_is_an_audited_owner_decision(self):
        self.create_pending_request()
        self.decide("rejected")
        self.assertEqual(self.db.execute("SELECT status FROM tenant_identity_link_requests").fetchone()[0], "rejected")

    def test_decision_without_event_and_event_replay_are_rejected(self):
        self.create_pending_request()
        with self.assertRaisesRegex(sqlite3.IntegrityError, "matching immutable owner event"):
            self.db.execute("""
              UPDATE tenant_identity_link_requests SET status='approved', tenant_id='tenant-a',
                decided_by_cloudflare_issuer='https://team.cloudflareaccess.com',
                decided_by_cloudflare_subject='owner-a-sub', reason='owner decision',
                decided_at='2026-11-14T10:02:00Z' WHERE id='link-request-1'
            """)
        self.decide()
        with self.assertRaisesRegex(sqlite3.IntegrityError, "matching immutable owner event"):
            self.db.execute("UPDATE tenant_identity_link_requests SET status='revoked' WHERE id='link-request-1'")

    def test_link_requests_and_events_are_immutable(self):
        self.create_pending_request()
        with self.assertRaisesRegex(sqlite3.IntegrityError, "append-only"):
            self.db.execute("UPDATE tenant_identity_link_events SET reason='rewritten' WHERE id='event-requested'")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "immutable"):
            self.db.execute("DELETE FROM tenant_identity_link_requests WHERE id='link-request-1'")

    def test_approved_link_can_only_be_revoked_by_active_owner(self):
        self.create_pending_request()
        self.decide()
        self.event("event-revoked", event_type="revoked", previous="approved", new="revoked",
                   tenant="tenant-a", actor_subject="owner-a-sub", reason="owner revoked",
                   request_id="event-revoked-request")
        self.db.execute("""
          UPDATE tenant_identity_link_requests SET status='revoked',
            decided_by_cloudflare_issuer='https://team.cloudflareaccess.com',
            decided_by_cloudflare_subject='owner-a-sub', reason='owner revoked',
            decided_at='2026-11-14T10:03:00Z' WHERE id='link-request-1'
        """)
        self.assertEqual(self.db.execute("SELECT status FROM tenant_identity_link_requests").fetchone()[0], "revoked")

    def test_requests_and_events_cannot_be_deleted_or_rewritten(self):
        self.create_pending_request()
        with self.assertRaisesRegex(sqlite3.IntegrityError, "append-only"):
            self.db.execute("DELETE FROM tenant_identity_link_events WHERE id='event-requested'")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "immutable"):
            self.db.execute("UPDATE tenant_identity_link_requests SET supabase_subject='changed' WHERE id='link-request-1'")


if __name__ == "__main__":
    unittest.main()

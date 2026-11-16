from pathlib import Path
import sqlite3
import unittest


ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "migrations" / "0029_tenant_source_registry_lifecycle.sql"


class TenantSourceRegistryMigrationTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.executescript("""
          CREATE TABLE tenants (id TEXT PRIMARY KEY, status TEXT NOT NULL);
          CREATE TABLE sites (
            id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL,
            UNIQUE(id, tenant_id)
          );
          CREATE TABLE sources (
            id TEXT PRIMARY KEY, site_id TEXT, module TEXT NOT NULL, provider TEXT NOT NULL,
            source_type TEXT NOT NULL, display_name TEXT NOT NULL, endpoint_reference TEXT,
            verification_status TEXT NOT NULL DEFAULT 'unverified',
            verification_method TEXT, license_reference TEXT, metadata_json TEXT NOT NULL DEFAULT '{}',
            tenant_id TEXT NOT NULL, updated_at TEXT
          );
          CREATE TABLE tenant_memberships (
            tenant_id TEXT NOT NULL, subject TEXT NOT NULL, role TEXT NOT NULL,
            status TEXT NOT NULL, PRIMARY KEY(tenant_id, subject)
          );
          INSERT INTO tenants VALUES ('tenant-a','active');
          INSERT INTO sites VALUES ('site-a','tenant-a','active');
          INSERT INTO tenant_memberships VALUES
            ('tenant-a','owner-sub','tenant_owner','active'),
            ('tenant-a','reviewer-sub','analyst','active');
        """)
        self.db.executescript(MIGRATION.read_text())
        self.db.execute("INSERT INTO sources(id,site_id,module,provider,source_type,display_name,tenant_id,registered_by_subject) VALUES ('source-a','site-a','neoagro','gateway-vendor','sensor_gateway','Gateway A','tenant-a','owner-sub')")

    def tearDown(self):
        self.db.close()

    def test_registration_event_is_owner_scoped_and_keeps_source_unverified(self):
        self.db.execute("""
          INSERT INTO tenant_source_events
          (id,tenant_id,site_id,source_id,actor_subject,event_type,evidence_ref,request_id)
          VALUES ('event-register','tenant-a','site-a','source-a','owner-sub','registered','evidence/source-a','request-register')
        """)
        status = self.db.execute("SELECT verification_status FROM sources WHERE id='source-a'").fetchone()[0]
        self.assertEqual(status, 'unverified')

    def test_independent_assigned_reviewer_verifies_and_status_is_applied(self):
        self.db.execute("""
          INSERT INTO tenant_source_reviewers
          (tenant_id,site_id,reviewer_subject,status,assigned_by_subject,evidence_ref)
          VALUES ('tenant-a','site-a','reviewer-sub','active','owner-sub','evidence/assignment')
        """)
        self.db.execute("""
          INSERT INTO tenant_source_events
          (id,tenant_id,site_id,source_id,actor_subject,event_type,evidence_ref,request_id)
          VALUES ('event-register','tenant-a','site-a','source-a','owner-sub','registered','evidence/source-a','request-register')
        """)
        self.db.execute("""
          INSERT INTO tenant_source_events
          (id,tenant_id,site_id,source_id,actor_subject,event_type,evidence_ref,request_id)
          VALUES ('event-verify','tenant-a','site-a','source-a','reviewer-sub','verified','evidence/verification','request-verify')
        """)
        self.assertEqual(self.db.execute("SELECT verification_status FROM sources WHERE id='source-a'").fetchone()[0], 'verified')

    def test_registrant_cannot_verify_and_unassigned_reviewer_cannot_verify(self):
        self.db.execute("""
          INSERT INTO tenant_source_events
          (id,tenant_id,site_id,source_id,actor_subject,event_type,evidence_ref,request_id)
          VALUES ('event-register','tenant-a','site-a','source-a','owner-sub','registered','evidence/source-a','request-register')
        """)
        for actor in ('owner-sub','reviewer-sub'):
            with self.assertRaises(sqlite3.IntegrityError):
                self.db.execute("""
                  INSERT INTO tenant_source_events
                  (id,tenant_id,site_id,source_id,actor_subject,event_type,evidence_ref,request_id)
                  VALUES (?,?,?,?,?,'verified','evidence/verification',?)
                """, ('event-'+actor,'tenant-a','site-a','source-a',actor,'request-'+actor))

    def test_rejected_source_cannot_be_verified_again(self):
        self.db.execute("""
          INSERT INTO tenant_source_reviewers
          VALUES ('tenant-a','site-a','reviewer-sub','active','owner-sub','evidence/assignment',
                  strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        """)
        self.db.execute("""
          INSERT INTO tenant_source_events
          (id,tenant_id,site_id,source_id,actor_subject,event_type,evidence_ref,request_id)
          VALUES ('event-register','tenant-a','site-a','source-a','owner-sub','registered','evidence/source-a','request-register')
        """)
        self.db.execute("""
          INSERT INTO tenant_source_events
          (id,tenant_id,site_id,source_id,actor_subject,event_type,evidence_ref,reason,request_id)
          VALUES ('event-reject','tenant-a','site-a','source-a','reviewer-sub','rejected','evidence/review','not verified','request-reject')
        """)
        self.assertEqual(self.db.execute("SELECT verification_status FROM sources WHERE id='source-a'").fetchone()[0], 'unverified')
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
              INSERT INTO tenant_source_events
              (id,tenant_id,site_id,source_id,actor_subject,event_type,evidence_ref,request_id)
              VALUES ('event-reverify','tenant-a','site-a','source-a','reviewer-sub','verified','evidence/again','request-reverify')
            """)

    def test_source_event_ledger_is_append_only_and_identity_is_immutable(self):
        self.db.execute("""
          INSERT INTO tenant_source_events
          (id,tenant_id,site_id,source_id,actor_subject,event_type,evidence_ref,request_id)
          VALUES ('event-register','tenant-a','site-a','source-a','owner-sub','registered','evidence/source-a','request-register')
        """)
        with self.assertRaisesRegex(sqlite3.IntegrityError, 'immutable'):
            self.db.execute("UPDATE tenant_source_events SET actor_subject='other' WHERE id='event-register'")
        with self.assertRaisesRegex(sqlite3.IntegrityError, 'immutable'):
            self.db.execute("UPDATE sources SET display_name='Changed' WHERE id='source-a'")

    def test_registration_idempotency_is_site_and_actor_scoped(self):
        self.db.execute("""
          INSERT INTO tenant_source_registration_requests
          (id,tenant_id,site_id,actor_subject,idempotency_key,request_sha256,source_id,request_id)
          VALUES ('req-a','tenant-a','site-a','owner-sub','key-a',?,'source-a','request-a')
        """, ('a'*64,))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""
              INSERT INTO tenant_source_registration_requests
              (id,tenant_id,site_id,actor_subject,idempotency_key,request_sha256,source_id,request_id)
              VALUES ('req-b','tenant-a','site-a','owner-sub','key-a',?,'source-a','request-b')
            """, ('b'*64,))


if __name__ == "__main__":
    unittest.main()

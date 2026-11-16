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
          CREATE TABLE tenant_resource_grants (
            id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, subject TEXT NOT NULL,
            resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, action TEXT NOT NULL
          );
          CREATE TABLE assets (
            id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, site_id TEXT NOT NULL,
            name TEXT NOT NULL, asset_type TEXT NOT NULL, external_ref TEXT,
            status TEXT NOT NULL DEFAULT 'unconfigured', metadata_json TEXT NOT NULL DEFAULT '{}',
            UNIQUE(id, tenant_id, site_id)
          );
          INSERT INTO tenants VALUES ('tenant-a','active');
          INSERT INTO sites VALUES ('site-a','tenant-a','active');
          INSERT INTO tenant_memberships VALUES
            ('tenant-a','owner-sub','tenant_owner','active'),
            ('tenant-a','reviewer-sub','analyst','active');
        """)
        self.db.executescript((ROOT / "migrations" / "0028_tenant_asset_registration.sql").read_text())
        self.db.executescript(MIGRATION.read_text())
        self.db.executescript((ROOT / "migrations" / "0033_site_grant_mutation_guards.sql").read_text())
        self.db.executemany(
            "INSERT INTO tenant_resource_grants VALUES (?, 'tenant-a', ?, 'site', 'site-a', 'read')",
            [('grant-owner', 'owner-sub'), ('grant-reviewer', 'reviewer-sub')],
        )
        self.db.execute("INSERT INTO assets(id,tenant_id,site_id,name,asset_type,status) VALUES ('asset-a','tenant-a','site-a','Pump A','pump','unconfigured')")
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


    def test_source_lifecycle_event_rechecks_site_read_grant_at_insert(self):
        self.db.execute("DELETE FROM tenant_resource_grants WHERE subject='owner-sub'")
        with self.assertRaisesRegex(sqlite3.IntegrityError, 'site grant'):
            self.db.execute("""
              INSERT INTO tenant_source_events
              (id,tenant_id,site_id,source_id,actor_subject,event_type,evidence_ref,request_id)
              VALUES ('event-no-grant','tenant-a','site-a','source-a','owner-sub','registered','evidence/source-a','request-no-grant')
            """)

    def test_reviewer_assignment_rechecks_assigner_site_read_grant(self):
        self.db.execute("DELETE FROM tenant_resource_grants WHERE subject='owner-sub'")
        with self.assertRaisesRegex(sqlite3.IntegrityError, 'site read grant'):
            self.db.execute("""
              INSERT INTO tenant_source_reviewers
              (tenant_id,site_id,reviewer_subject,status,assigned_by_subject,evidence_ref)
              VALUES ('tenant-a','site-a','reviewer-sub','active','owner-sub','evidence/assignment')
            """)

    def test_reviewer_verification_rechecks_reviewers_site_read_grant(self):
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
        self.db.execute("DELETE FROM tenant_resource_grants WHERE subject='reviewer-sub'")
        with self.assertRaisesRegex(sqlite3.IntegrityError, 'site grant'):
            self.db.execute("""
              INSERT INTO tenant_source_events
              (id,tenant_id,site_id,source_id,actor_subject,event_type,evidence_ref,request_id)
              VALUES ('event-verify-no-grant','tenant-a','site-a','source-a','reviewer-sub','verified','evidence/verification','request-verify-no-grant')
            """)

    def test_asset_creation_event_rechecks_owner_site_read_grant(self):
        self.db.execute("DELETE FROM tenant_resource_grants WHERE subject='owner-sub'")
        with self.assertRaisesRegex(sqlite3.IntegrityError, 'site grant'):
            self.db.execute("""
              INSERT INTO tenant_asset_events
              (id,tenant_id,site_id,asset_id,actor_subject,event_type,request_id)
              VALUES ('asset-event-no-grant','tenant-a','site-a','asset-a','owner-sub','created','asset-request-no-grant')
            """)

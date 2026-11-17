from pathlib import Path
import sqlite3
import unittest


MIGRATION = Path(__file__).resolve().parents[1] / "migrations" / "0035_observation_ingestion_requires_verified_source.sql"


class ObservationVerifiedSourceGuardTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.executescript("""
          CREATE TABLE tenants (id TEXT PRIMARY KEY, status TEXT NOT NULL);
          CREATE TABLE sites (
            id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL,
            UNIQUE(id, tenant_id)
          );
          CREATE TABLE sources (
            id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, site_id TEXT,
            module TEXT NOT NULL, verification_status TEXT NOT NULL
          );
          CREATE TABLE observations (
            id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, site_id TEXT NOT NULL,
            source_id TEXT NOT NULL, module TEXT NOT NULL
          );
          INSERT INTO tenants VALUES ('tenant-a', 'active');
          INSERT INTO sites VALUES ('site-a', 'tenant-a', 'active');
          INSERT INTO sources VALUES ('source-a', 'tenant-a', 'site-a', 'neoagro', 'unverified');
          INSERT INTO sources VALUES ('source-global', 'tenant-a', NULL, 'neogrid', 'verified');
        """)
        self.db.executescript(MIGRATION.read_text(encoding="utf-8"))

    def tearDown(self):
        self.db.close()

    def insert_observation(self, observation_id="obs-a", source_id="source-a", module="neoagro",
                           tenant_id="tenant-a", site_id="site-a"):
        self.db.execute(
            "INSERT INTO observations(id, tenant_id, site_id, source_id, module) VALUES (?, ?, ?, ?, ?)",
            (observation_id, tenant_id, site_id, source_id, module),
        )

    def test_unverified_source_is_rejected_at_insert(self):
        with self.assertRaisesRegex(sqlite3.IntegrityError, "verified matching source"):
            self.insert_observation()

    def test_verified_matching_source_is_accepted(self):
        self.db.execute("UPDATE sources SET verification_status='verified' WHERE id='source-a'")
        self.insert_observation()
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM observations").fetchone()[0], 1)

    def test_revoked_source_is_rejected_even_if_earlier_lookup_had_passed(self):
        self.db.execute("UPDATE sources SET verification_status='verified' WHERE id='source-a'")
        # Models a revocation committing after the Worker's ownership lookup but before its insert.
        self.db.execute("UPDATE sources SET verification_status='disabled' WHERE id='source-a'")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "verified matching source"):
            self.insert_observation()

    def test_global_source_still_requires_verified_status_and_matching_module(self):
        self.insert_observation(source_id="source-global", module="neogrid")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "verified matching source"):
            self.insert_observation("obs-b", source_id="source-global", module="neoagro")

    def test_source_must_match_tenant_and_site(self):
        self.db.execute("UPDATE sources SET verification_status='verified' WHERE id='source-a'")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "verified matching source"):
            self.insert_observation(tenant_id="tenant-other")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "verified matching source"):
            self.insert_observation("obs-b", site_id="site-other")

    def test_site_and_tenant_must_be_active(self):
        self.db.execute("UPDATE sources SET verification_status='verified' WHERE id='source-a'")
        self.db.execute("UPDATE sites SET status='inactive' WHERE id='site-a'")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "verified matching source"):
            self.insert_observation()
        self.db.execute("UPDATE sites SET status='active' WHERE id='site-a'")
        self.db.execute("UPDATE tenants SET status='suspended' WHERE id='tenant-a'")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "verified matching source"):
            self.insert_observation()


if __name__ == "__main__":
    unittest.main()

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const migration = readFileSync(fileURLToPath(new URL("../../api/migrations/0026_reviewer_active_membership_write_guard.sql", import.meta.url)), "utf8");

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE tenant_memberships (tenant_id TEXT NOT NULL, subject TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY (tenant_id, subject));
    CREATE TABLE sensor_source_mapping_events (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, reviewer_subject TEXT NOT NULL);
    CREATE TABLE sensor_calibration_verification_events (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, reviewer_subject TEXT NOT NULL);
    INSERT INTO tenants VALUES ('tenant-1', 'active');
    INSERT INTO tenant_memberships VALUES ('tenant-1', 'reviewer-1', 'active');
  `);
  db.exec(migration);
  return db;
}

test("sensor-source mapping review writes require active tenant membership", (t) => {
  const db = fixture(t);
  db.prepare("INSERT INTO sensor_source_mapping_events VALUES ('event-active', 'tenant-1', 'reviewer-1')").run();
  db.prepare("UPDATE tenant_memberships SET status = 'suspended' WHERE tenant_id = 'tenant-1' AND subject = 'reviewer-1'").run();
  assert.throws(
    () => db.prepare("INSERT INTO sensor_source_mapping_events VALUES ('event-suspended', 'tenant-1', 'reviewer-1')").run(),
    /sensor source mapping reviewer membership must be active/
  );
});

test("calibration verification writes require active tenant membership", (t) => {
  const db = fixture(t);
  db.prepare("INSERT INTO sensor_calibration_verification_events VALUES ('event-active', 'tenant-1', 'reviewer-1')").run();
  db.prepare("UPDATE tenant_memberships SET status = 'suspended' WHERE tenant_id = 'tenant-1' AND subject = 'reviewer-1'").run();
  assert.throws(
    () => db.prepare("INSERT INTO sensor_calibration_verification_events VALUES ('event-suspended', 'tenant-1', 'reviewer-1')").run(),
    /sensor calibration reviewer membership must be active/
  );
});

test("review writes remain blocked when tenant itself is inactive", (t) => {
  const db = fixture(t);
  db.prepare("UPDATE tenants SET status = 'suspended' WHERE id = 'tenant-1'").run();
  assert.throws(
    () => db.prepare("INSERT INTO sensor_source_mapping_events VALUES ('event-inactive-tenant', 'tenant-1', 'reviewer-1')").run(),
    /sensor source mapping reviewer membership must be active/
  );
  assert.throws(
    () => db.prepare("INSERT INTO sensor_calibration_verification_events VALUES ('event-inactive-tenant', 'tenant-1', 'reviewer-1')").run(),
    /sensor calibration reviewer membership must be active/
  );
});

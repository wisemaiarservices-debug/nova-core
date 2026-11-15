import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const migration = readFileSync(fileURLToPath(new URL("../../api/migrations/0028_criteria_reviewer_active_membership_write_guard.sql", import.meta.url)), "utf8");

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE tenant_memberships (tenant_id TEXT NOT NULL, subject TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY (tenant_id, subject));
    CREATE TABLE water_quality_criteria_approvals (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, reviewer_subject TEXT NOT NULL);
    INSERT INTO tenants VALUES ('tenant-1', 'active');
    INSERT INTO tenant_memberships VALUES ('tenant-1', 'reviewer-1', 'active');
  `);
  db.exec(migration);
  return db;
}

test("criteria approval allows active tenant membership", (t) => {
  const db = fixture(t);
  assert.doesNotThrow(() => db.prepare("INSERT INTO water_quality_criteria_approvals VALUES ('approval-active', 'tenant-1', 'reviewer-1')").run());
});

test("criteria approval rejects suspended reviewer membership", (t) => {
  const db = fixture(t);
  db.prepare("UPDATE tenant_memberships SET status = 'suspended' WHERE tenant_id = 'tenant-1' AND subject = 'reviewer-1'").run();
  assert.throws(
    () => db.prepare("INSERT INTO water_quality_criteria_approvals VALUES ('approval-suspended', 'tenant-1', 'reviewer-1')").run(),
    /criteria approval reviewer membership must be active/
  );
});

test("criteria approval rejects inactive tenant", (t) => {
  const db = fixture(t);
  db.prepare("UPDATE tenants SET status = 'suspended' WHERE id = 'tenant-1'").run();
  assert.throws(
    () => db.prepare("INSERT INTO water_quality_criteria_approvals VALUES ('approval-inactive-tenant', 'tenant-1', 'reviewer-1')").run(),
    /criteria approval reviewer membership must be active/
  );
});

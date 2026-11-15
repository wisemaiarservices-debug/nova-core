import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const migration = readFileSync(fileURLToPath(new URL("../../api/migrations/0027_observation_reviewer_active_membership_write_guard.sql", import.meta.url)), "utf8");

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE tenant_memberships (tenant_id TEXT NOT NULL, subject TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY (tenant_id, subject));
    CREATE TABLE observation_verification_events (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, reviewer_subject TEXT NOT NULL);
    INSERT INTO tenants VALUES ('tenant-1', 'active');
    INSERT INTO tenant_memberships VALUES ('tenant-1', 'reviewer-1', 'active');
  `);
  db.exec(migration);
  return db;
}

test("observation verification writes allow active tenant membership", (t) => {
  const db = fixture(t);
  assert.doesNotThrow(() => db.prepare("INSERT INTO observation_verification_events VALUES ('event-active', 'tenant-1', 'reviewer-1')").run());
});

test("observation verification writes reject suspended reviewer membership", (t) => {
  const db = fixture(t);
  db.prepare("UPDATE tenant_memberships SET status = 'suspended' WHERE tenant_id = 'tenant-1' AND subject = 'reviewer-1'").run();
  assert.throws(
    () => db.prepare("INSERT INTO observation_verification_events VALUES ('event-suspended', 'tenant-1', 'reviewer-1')").run(),
    /observation verification reviewer membership must be active/
  );
});

test("observation verification writes reject inactive tenants", (t) => {
  const db = fixture(t);
  db.prepare("UPDATE tenants SET status = 'suspended' WHERE id = 'tenant-1'").run();
  assert.throws(
    () => db.prepare("INSERT INTO observation_verification_events VALUES ('event-inactive-tenant', 'tenant-1', 'reviewer-1')").run(),
    /observation verification reviewer membership must be active/
  );
});

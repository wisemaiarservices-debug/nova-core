import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const migration = readFileSync(fileURLToPath(new URL("../../api/migrations/0031_membership_event_actor_active_membership_guard.sql", import.meta.url)), "utf8");

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE tenant_memberships (tenant_id TEXT NOT NULL, subject TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY (tenant_id, subject));
    CREATE TABLE tenant_membership_events (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, actor_subject TEXT NOT NULL);
    INSERT INTO tenants VALUES ('tenant-1', 'active');
    INSERT INTO tenant_memberships VALUES ('tenant-1', 'owner-1', 'active');
  `);
  db.exec(migration);
  return db;
}

test("membership lifecycle event allows active actor in active tenant", (t) => {
  const db = fixture(t);
  assert.doesNotThrow(() => db.prepare("INSERT INTO tenant_membership_events VALUES ('event-1', 'tenant-1', 'owner-1')").run());
});

test("membership lifecycle event rejects suspended actor", (t) => {
  const db = fixture(t);
  db.prepare("UPDATE tenant_memberships SET status = 'suspended' WHERE tenant_id = 'tenant-1' AND subject = 'owner-1'").run();
  assert.throws(
    () => db.prepare("INSERT INTO tenant_membership_events VALUES ('event-2', 'tenant-1', 'owner-1')").run(),
    /membership event actor membership must be active/
  );
});

test("membership lifecycle event rejects inactive tenant", (t) => {
  const db = fixture(t);
  db.prepare("UPDATE tenants SET status = 'suspended' WHERE id = 'tenant-1'").run();
  assert.throws(
    () => db.prepare("INSERT INTO tenant_membership_events VALUES ('event-3', 'tenant-1', 'owner-1')").run(),
    /membership event actor membership must be active/
  );
});

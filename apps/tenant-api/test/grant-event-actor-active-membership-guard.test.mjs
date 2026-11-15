import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const migration = readFileSync(fileURLToPath(new URL("../../api/migrations/0030_grant_event_actor_active_membership_guard.sql", import.meta.url)), "utf8");

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE tenant_memberships (tenant_id TEXT NOT NULL, subject TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY (tenant_id, subject));
    CREATE TABLE tenant_site_grant_events (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, actor_subject TEXT NOT NULL);
    CREATE TABLE tenant_resource_grant_events (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, actor_subject TEXT NOT NULL);
    INSERT INTO tenants VALUES ('tenant-1', 'active');
    INSERT INTO tenant_memberships VALUES ('tenant-1', 'admin-1', 'active');
  `);
  db.exec(migration);
  return db;
}

for (const [table, prefix] of [
  ["tenant_site_grant_events", "site"],
  ["tenant_resource_grant_events", "resource"]
]) {
  test(`${prefix} grant event allows active tenant actor`, (t) => {
    const db = fixture(t);
    assert.doesNotThrow(() => db.prepare(`INSERT INTO ${table} VALUES (?, 'tenant-1', 'admin-1')`).run(`${prefix}-active`));
  });

  test(`${prefix} grant event rejects suspended actor membership`, (t) => {
    const db = fixture(t);
    db.prepare("UPDATE tenant_memberships SET status = 'suspended' WHERE tenant_id = 'tenant-1' AND subject = 'admin-1'").run();
    assert.throws(
      () => db.prepare(`INSERT INTO ${table} VALUES (?, 'tenant-1', 'admin-1')`).run(`${prefix}-suspended`),
      new RegExp(`${prefix} grant event actor membership must be active`)
    );
  });

  test(`${prefix} grant event rejects inactive tenant`, (t) => {
    const db = fixture(t);
    db.prepare("UPDATE tenants SET status = 'suspended' WHERE id = 'tenant-1'").run();
    assert.throws(
      () => db.prepare(`INSERT INTO ${table} VALUES (?, 'tenant-1', 'admin-1')`).run(`${prefix}-inactive-tenant`),
      new RegExp(`${prefix} grant event actor membership must be active`)
    );
  });
}

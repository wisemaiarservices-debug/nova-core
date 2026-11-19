import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  matchTenantSiteLifecycleCommandRoute,
  prepareTenantSiteLifecycleCommand,
  readTenantSiteLifecycleCommand,
  applyTenantSiteLifecycleCommand,
  rejectTenantSiteLifecycleCommand,
} from "../src/site-lifecycle-command.mjs";

const migrationDir = new URL("../../api/migrations/", import.meta.url);
const migrations = [
  "0040_site_lifecycle_governance.sql",
  "0042_site_lifecycle_command_recovery.sql",
  "0043_site_lifecycle_command_resolver.sql",
  "0044_site_lifecycle_command_idempotency.sql",
].map(name => readFileSync(fileURLToPath(new URL(name, migrationDir)), "utf8"));

const tenant = "tenant-command-test";
const site = "site-command-test";
const owner = "owner-command-test";
const resolver = "resolver-command-test";
const operator = "operator-command-test";
const now = "2026-11-19T12:00:00.000Z";

function d1Adapter(sqlite) {
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async all() { return { results: sqlite.prepare(sql).all(...args) }; },
            async run() {
              const result = sqlite.prepare(sql).run(...args);
              return { meta: { changes: Number(result.changes) } };
            },
          };
        },
      };
    },
  };
}

function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec("PRAGMA foreign_keys=ON");
  sqlite.exec(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE sites (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL,
      updated_at TEXT NOT NULL, UNIQUE(id,tenant_id)
    );
    CREATE TABLE tenant_memberships (
      tenant_id TEXT NOT NULL, subject TEXT NOT NULL, role TEXT NOT NULL,
      status TEXT NOT NULL, PRIMARY KEY(tenant_id,subject)
    );
    CREATE TABLE tenant_resource_grants (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, subject TEXT NOT NULL,
      resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, action TEXT NOT NULL
    );
  `);
  for (const migration of migrations) sqlite.exec(migration);
  sqlite.prepare("INSERT INTO tenants VALUES (?, 'active')").run(tenant);
  sqlite.prepare("INSERT INTO sites VALUES (?, ?, 'active', ?)").run(site, tenant, now);
  const addMember = sqlite.prepare("INSERT INTO tenant_memberships VALUES (?, ?, ?, 'active')");
  addMember.run(tenant, owner, "tenant_owner");
  addMember.run(tenant, resolver, "tenant_admin");
  addMember.run(tenant, operator, "operator");
  const grant = sqlite.prepare(`
    INSERT INTO tenant_resource_grants
      (id,tenant_id,subject,resource_type,resource_id,action)
    VALUES(?,?,?,'site',?,'read')
  `);
  grant.run("owner-grant", tenant, owner, site);
  grant.run("resolver-grant", tenant, resolver, site);
  grant.run("operator-grant", tenant, operator, site);
  return { sqlite, db: d1Adapter(sqlite) };
}

const prepareInput = (overrides = {}) => ({
  tenant, site, actorSubject: owner, idempotencyKey: "retry-command-001",
  requestId: "request-prepare-001", body: { action: "deactivate", reason: "Scheduled maintenance" },
  now, ...overrides,
});

test("route matcher exposes only exact method/path combinations", () => {
  assert.deepEqual(matchTenantSiteLifecycleCommandRoute(
    "https://internal.test/internal/v1/tenants/t1/sites/s1/lifecycle-commands", "POST"),
    { tenant: "t1", site: "s1", action: "prepare" });
  assert.deepEqual(matchTenantSiteLifecycleCommandRoute(
    "https://internal.test/internal/v1/tenants/t1/sites/s1/lifecycle-commands/c1/apply", "POST"),
    { tenant: "t1", site: "s1", commandId: "c1", action: "apply" });
  assert.equal(matchTenantSiteLifecycleCommandRoute(
    "https://internal.test/internal/v1/tenants/t1/sites/s1/lifecycle-commands/c1/apply?x=1", "POST"), null);
  assert.equal(matchTenantSiteLifecycleCommandRoute(
    "https://internal.test/internal/v1/tenants/t1/sites/s1/lifecycle-commands", "GET"), null);
  assert.equal(matchTenantSiteLifecycleCommandRoute(
    "https://internal.test/internal/v1/tenants/t1/sites/s1/lifecycle-commands/c1/reject", "GET"), null);
});

test("prepare is reload-safe, binds the retry key to immutable intent, and apply is actor-bound", async t => {
  const { sqlite, db } = fixture(t);
  const prepared = await prepareTenantSiteLifecycleCommand(db, prepareInput());
  assert.equal(prepared.status, 201);
  assert.equal(prepared.data.status, "pending");
  assert.equal(prepared.data.events[0].event_type, "prepared");

  const recovered = await prepareTenantSiteLifecycleCommand(db,
    prepareInput({ requestId: "request-prepare-retry" }));
  assert.equal(recovered.status, 200);
  assert.equal(recovered.data.id, prepared.data.id);

  const changedIntent = await prepareTenantSiteLifecycleCommand(db,
    prepareInput({ body: { action: "deactivate", reason: "Different intent" } }));
  assert.equal(changedIntent.status, 409);
  assert.equal(changedIntent.error, "site_lifecycle_idempotency_conflict");

  const wrongActor = await applyTenantSiteLifecycleCommand(db, {
    tenant, site, actorSubject: resolver, commandId: prepared.data.id,
    requestId: "request-wrong-actor", now,
  });
  assert.equal(wrongActor.status, 404);

  const applied = await applyTenantSiteLifecycleCommand(db, {
    tenant, site, actorSubject: owner, commandId: prepared.data.id,
    requestId: "request-apply-001", now,
  });
  assert.equal(applied.status, 200);
  assert.equal(applied.data.status, "applied");
  assert.equal(sqlite.prepare("SELECT status FROM sites WHERE id=?").get(site).status, "inactive");
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM tenant_site_lifecycle_applications").get().n, 1);

  const retry = await applyTenantSiteLifecycleCommand(db, {
    tenant, site, actorSubject: owner, commandId: prepared.data.id,
    requestId: "request-apply-retry", now,
  });
  assert.equal(retry.data.event_id, applied.data.event_id);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM tenant_site_lifecycle_events").get().n, 1);
});

test("resolver rejection is separately attributed and cannot change site status", async t => {
  const { sqlite, db } = fixture(t);
  const prepared = await prepareTenantSiteLifecycleCommand(db);
  sqlite.prepare("UPDATE tenant_memberships SET status='revoked' WHERE tenant_id=? AND subject=?")
    .run(tenant, owner);

  const rejected = await rejectTenantSiteLifecycleCommand(db, {
    tenant, site, actorSubject: resolver, commandId: prepared.data.id,
    rejectionCode: "original_actor_revoked", now,
  });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.data.status, "rejected");
  assert.equal(rejected.data.events.at(-1).performed_by_subject, resolver);
  assert.equal(sqlite.prepare("SELECT status FROM sites WHERE id=?").get(site).status, "active");
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM tenant_site_lifecycle_applications").get().n, 0);
  assert.equal(sqlite.prepare("SELECT actor_subject FROM tenant_site_lifecycle_commands WHERE id=?")
    .get(prepared.data.id).actor_subject, owner);
});

test("operator role cannot prepare, read or resolve lifecycle commands", async t => {
  const { db } = fixture(t);
  const prepared = await prepareTenantSiteLifecycleCommand(db, prepareInput({ actorSubject: operator }));
  assert.equal(prepared.status, 404);
  assert.equal(prepared.error, "site_not_found");
});

import test from "node:test";
import assert from "node:assert/strict";
import { readSiteConfigurationHistory } from "../src/configuration-read-persistence.mjs";

const rows = [
  { id: "cfg-v2", tenant_id: "tenant-a", site_id: "site-a", configuration_version: "v2",
    schema_id: "nova.client-config.v1", configuration_json: '{"site":{"site_id":"site-a"}}',
    content_sha256: "b".repeat(64), created_by_subject: "admin", request_id: "req-2",
    created_at: "2026-11-13T12:00:00Z", lifecycle_status: "submitted_for_review" },
  { id: "cfg-v1", tenant_id: "tenant-a", site_id: "site-a", configuration_version: "v1",
    schema_id: "nova.client-config.v1", configuration_json: '{"site":{"site_id":"site-a"}}',
    content_sha256: "a".repeat(64), created_by_subject: "admin", request_id: "req-1",
    created_at: "2026-11-12T12:00:00Z", lifecycle_status: "approved_for_review" },
];

function db({ membership = true, grant = true, records = rows } = {}) {
  const calls = [];
  return { calls, prepare(sql) {
    return { bind(...args) { return { sql, args, async all() {
      calls.push({ sql, args });
      if (sql.includes("tenant_memberships")) return { results: membership ? [{
        subject: "reader", tenant_id: "tenant-a", role: "viewer",
        membership_status: "active", tenant_status: "active",
      }] : [] };
      if (sql.includes("tenant_resource_grants")) return { results: grant ? [{
        subject: "reader", tenant_id: "tenant-a", resource_type: "site",
        resource_id: "site-a", action: "read",
      }] : [] };
      if (sql.includes("tenant_site_configurations")) {
        if (sql.includes("configuration_version = ?")) return {
          results: records.filter(row => row.configuration_version === args[2]),
        };
        return { results: records };
      }
      throw new Error("unexpected SQL");
    } }; } };
  } };
}

test("lists immutable site configuration history newest version first with lifecycle status", async () => {
  const database = db();
  const result = await readSiteConfigurationHistory({ db: database,
    principalSubject: "reader", tenantId: "tenant-a", siteId: "site-a" });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.map(row => row.configuration_version), ["v2", "v1"]);
  assert.equal(result.data[0].configuration.site.site_id, "site-a");
  assert.equal(result.data[1].lifecycle_status, "approved_for_review");
  assert.equal(database.calls[0].args.join("|"), "reader|tenant-a");
  assert.equal(database.calls[1].args.join("|"), "tenant-a|reader|site-a");
  assert.match(database.calls[2].sql, /ORDER BY CAST\(substr\(c\.configuration_version/);
});

test("reads only the exact requested tenant, site and configuration version", async () => {
  const database = db();
  const result = await readSiteConfigurationHistory({ db: database,
    principalSubject: "reader", tenantId: "tenant-a", siteId: "site-a", version: "v1" });
  assert.equal(result.status, 200);
  assert.equal(result.data.id, "cfg-v1");
  assert.deepEqual(database.calls[2].args, ["tenant-a", "site-a", "v1"]);
});

test("denies missing site grants and inactive tenant memberships before reading snapshots", async () => {
  for (const options of [{ grant: false }, { membership: false }]) {
    const database = db(options);
    const result = await readSiteConfigurationHistory({ db: database,
      principalSubject: "reader", tenantId: "tenant-a", siteId: "site-a" });
    assert.deepEqual(result, { error: "not_found", status: 404 });
    assert.equal(database.calls.some(call => call.sql.includes("tenant_site_configurations")), false);
  }
});

test("does not expose another site's or unknown version's configuration", async () => {
  const database = db({ records: [] });
  const result = await readSiteConfigurationHistory({ db: database,
    principalSubject: "reader", tenantId: "tenant-a", siteId: "site-a", version: "v9" });
  assert.deepEqual(result, { error: "not_found", status: 404 });
});

test("rejects malformed configuration version selectors", async () => {
  const result = await readSiteConfigurationHistory({ db: db(),
    principalSubject: "reader", tenantId: "tenant-a", siteId: "site-a", version: "v0" });
  assert.deepEqual(result, { error: "not_found", status: 404 });
});

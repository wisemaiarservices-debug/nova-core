import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync, sign, webcrypto } from "node:crypto";
globalThis.crypto ??= webcrypto;
import worker from "../src/index.mjs";

const now = Math.floor(Date.now() / 1000);
class DB {
  constructor({ membership = true, grant = true, resource = true } = {}) {
    this.membership = membership; this.grant = grant; this.resource = resource; this.calls = []; this.nonces = new Set(); this.revokeIdentityLinkAfterCheck = false; this.revokeSiteGrantAfterAuthorization = false; this.revokeMembershipAfterAuthorization = false;
    this.membershipRows = null; this.identityLinkRows = null; this.identityLinkEventRows = null; this.grantRows = null; this.resourceRows = null; this.criteriaRows = null; this.criteriaEventRows = null; this.approvalRows = null; this.observationEvidenceRows = []; this.siteObservationRows = []; this.siteObservationAuthorizationRows = null; this.siteListRows = null; this.laboratoryEvidenceRows = []; this.siteRows = null; this.batchCalls = []; this.batchResult = null; this.batchError = null;
  }
  async batch(statements) {
    this.batchCalls.push(statements);
    if (this.batchError) throw this.batchError;
    return this.batchResult ?? [{ meta: { changes: 1 } }, { meta: { changes: 1 } }];
  }
  prepare(sql) {
    const db = this;
    return { bind(...args) { return { sql, args,
      async all() {
        db.calls.push({ sql, args });
        if (sql.includes("FROM tenant_identity_link_events")) return { results: db.identityLinkEventRows ?? [] };
        if (sql.startsWith("SELECT id FROM tenant_identity_link_requests")) {
          const result = db.identityLinkRows ?? [];
          if (db.revokeIdentityLinkAfterCheck) db.identityLinkRows = [];
          return { results: result };
        }
        if (sql.includes("EXISTS (SELECT 1 FROM tenant_identity_link_requests") &&
            !(db.identityLinkRows ?? []).length) return { results: [] };
        if (sql.includes("SELECT s.id, s.name, s.timezone FROM sites s JOIN tenant_memberships")) return { results: db.siteListRows ?? [] };
        if (sql.includes("SELECT s.id FROM sites s JOIN tenant_memberships")) {
          const result = db.siteObservationAuthorizationRows ?? (db.membership && db.grant ? [{ id: args[2] }] : []);
          if (db.revokeSiteGrantAfterAuthorization) db.grant = false;
          if (db.revokeMembershipAfterAuthorization) db.membership = false;
          return { results: result };
        }
        if (sql.includes("SELECT o.id, o.tenant_id, o.site_id, o.asset_id, o.source_id, o.module, o.metric")) {
          if (sql.includes("EXISTS (SELECT 1 FROM tenant_memberships") && (!db.membership || !db.grant)) return { results: [] };
          return { results: db.siteObservationRows ?? [] };
        }
        if (sql.includes("FROM tenant_memberships m JOIN tenants t") && sql.includes("m.role = 'tenant_owner'")) {
          const rows = db.membershipRows ?? (db.membership ? [{
            subject: "operator@example.test", tenant_id: "tenant-a", role: "viewer",
            membership_status: "active", tenant_status: "active",
          }] : []);
          return { results: rows.filter(row => row.role === "tenant_owner" &&
            row.membership_status === "active" && row.tenant_status === "active" &&
            row.tenant_id === args[0] && row.subject === args[1]) };
        }
        if (sql.includes("FROM tenant_memberships")) return { results: db.membershipRows ?? (db.membership ? [{
          subject: "operator@example.test", tenant_id: "tenant-a", role: "viewer",
          membership_status: "active", tenant_status: "active",
        }] : []) };
        if (sql.startsWith("SELECT subject, tenant_id, resource_type, resource_id, action FROM tenant_resource_grants")) {
          const siteGrantQuery = sql.includes("resource_type = 'site'");
          const result = db.grantRows ?? (db.grant ? [{
            subject: "operator@example.test", tenant_id: "tenant-a",
            resource_type: siteGrantQuery ? "site" : args[2],
            resource_id: siteGrantQuery ? args[2] : args[3], action: "read",
          }] : []);
          if (db.revokeSiteGrantAfterAuthorization) db.grant = false;
          if (db.revokeMembershipAfterAuthorization) db.membership = false;
          return { results: result };
        }
        if (sql.includes("SELECT id FROM sites WHERE tenant_id = ? AND id = ?")) return { results: db.siteRows ?? [{ id: args[1] }] };
        if (sql.includes("FROM laboratory_report_evidence e")) return { results: db.laboratoryEvidenceRows };
        if (sql.includes("FROM observations WHERE id = ? AND tenant_id = ? AND site_id = ?")) return { results: db.observationEvidenceRows };
        if (sql.includes("FROM water_quality_criteria_entries")) return { results: db.criteriaRows ?? [] };
        if (sql.includes("FROM water_quality_criteria_events")) return { results: db.criteriaEventRows ?? [] };
        if (sql.includes("FROM water_quality_criteria_approvals")) return { results: db.approvalRows ?? [] };
        if (sql.includes("FROM water_quality_criteria_reviewers")) {
          const reviewerRows = db.reviewerRows ?? [];
          return { results: sql.includes("SELECT DISTINCT") ? reviewerRows.slice(0, 1) : reviewerRows };
        }
        if (sql.includes("FROM water_quality_criteria_reviewer_events")) return { results: db.reviewerEventRows ?? [] };
        if (/FROM (sites|assets|sources|observations|audit_events)/.test(sql)) {
          if (sql.includes("EXISTS (SELECT 1 FROM tenant_memberships m JOIN tenants t") &&
              (!db.membership || !db.grant)) return { results: [] };
          return { results: db.resourceRows ?? (db.resource ? [{
            id: args[1], tenant_id: args[0], name: "Test resource",
          }] : []) };
        }
        throw new Error("unexpected SQL");
      },
      async run() {
        db.calls.push({ sql, args });
        if (sql.includes("INSERT INTO internal_request_nonces")) {
          if (db.nonces.has(args[0])) return { meta: { changes: 0 } };
          db.nonces.add(args[0]);
          return { meta: { changes: 1 } };
        }
        throw new Error("unexpected write SQL");
      },
    }; } };
  }
}
const SECRET = "test-only-internal-secret-with-32-bytes-minimum";
async function request(overrides = {}, targetUrl = "https://private.internal/internal/v1/tenants/tenant-a/sites/site-a", method = "GET", body = undefined) {
  const url = targetUrl;
  const headers = new Headers({ "x-nova-verified-subject": "operator@example.test",
    "x-nova-verified-issuer": "https://example.cloudflareaccess.com",
    "x-nova-verified-audience": "aud", "x-nova-gateway-issued-at": String(now),
    "x-nova-request-id": "request-123", ...(method === "POST" ? { "content-type": "application/json" } : {}), ...overrides });
  for (const [key, value] of Object.entries(overrides)) if (value === null) headers.delete(key);
  const path = new URL(url).pathname;
  const bodyBytes = new TextEncoder().encode(body ?? "");
  const bodyDigest = createHash("sha256").update(bodyBytes).digest("hex");
  if (!headers.has("x-nova-body-sha256")) headers.set("x-nova-body-sha256", bodyDigest);
  const supabaseToken = headers.get("x-nova-supabase-access-token");
  if (supabaseToken !== null && !headers.has("x-nova-supabase-token-sha256")) {
    headers.set("x-nova-supabase-token-sha256", createHash("sha256").update(supabaseToken).digest("hex"));
  }
  const canonical = JSON.stringify([method, path, headers.get("x-nova-verified-subject"),
    headers.get("x-nova-verified-issuer"), headers.get("x-nova-verified-audience"),
    headers.get("x-nova-gateway-issued-at"), headers.get("x-nova-request-id"), headers.get("x-nova-body-sha256"),
    headers.get("x-nova-supabase-token-sha256"), headers.get("x-nova-idempotency-key")]);
  headers.set("x-nova-internal-signature",
    createHmac("sha256", SECRET).update(canonical).digest("hex"));
  return new Request(url, { method, headers, body });
}
const env = db => ({ ACCESS_ISSUER: "https://example.cloudflareaccess.com",
  ACCESS_AUDIENCE: "aud", INTERNAL_AUTH_SECRET: SECRET,
  SUPABASE_AUTH_ISSUER: "https://project.example.test/auth/v1", SUPABASE_AUTH_AUDIENCE: "authenticated", DB: db });

test("requires a complete, fresh gateway identity envelope", async () => {
  const db = new DB();
  const response = await worker.fetch(await request({ "x-nova-verified-issuer": "https://attacker.test" }), env(db));
  assert.equal(response.status, 401); assert.equal(db.calls.length, 0);
});

test("rejects identity subjects longer than the tenant schema supports", async () => {
  const db = new DB();
  const response = await worker.fetch(
    await request({ "x-nova-verified-subject": "s".repeat(201) }), env(db));
  assert.equal(response.status, 401);
  assert.equal(db.calls.length, 0);
});

test("authorizes exact tenant membership and resource grant before scoped read", async () => {
  const db = new DB();
  const response = await worker.fetch(await request(), env(db));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.name, "Test resource");
  assert.deepEqual(db.calls[3].args, ["tenant-a", "site-a", "tenant-a", "operator@example.test"]);
  assert.match(db.calls[3].sql, /EXISTS \(SELECT 1 FROM tenant_memberships m JOIN tenants t/);
  assert.match(db.calls[3].sql, /g\.action = 'read'/);
});
test("resource detail query rechecks membership and exact grant after preliminary authorization", async () => {
  for (const revoked of ["membership", "grant"]) {
    const db = new DB();
    if (revoked === "membership") db.revokeMembershipAfterAuthorization = true;
    else db.revokeSiteGrantAfterAuthorization = true;
    const response = await worker.fetch(await request(), env(db));
    assert.equal(response.status, 404, revoked);
    const finalRead = db.calls.find(call => /FROM sites WHERE tenant_id = \? AND id = \?/.test(call.sql));
    assert.ok(finalRead, "final resource query must execute");
    assert.match(finalRead.sql, /EXISTS \(SELECT 1 FROM tenant_memberships m JOIN tenants t/);
    assert.match(finalRead.sql, /g\.action = 'read'/);
    assert.deepEqual(finalRead.args, ["tenant-a", "site-a", "tenant-a", "operator@example.test"]);
  }
});

test("all resource detail types bind their exact grant into the final protected query", async () => {
  const cases = [
    ["/internal/v1/tenants/tenant-a/sites/site-a", "site"],
    ["/internal/v1/tenants/tenant-a/assets/asset-a", "asset"],
    ["/internal/v1/tenants/tenant-a/sources/source-a", "source"],
    ["/internal/v1/tenants/tenant-a/observations/observation-a", "observation"],
    ["/internal/v1/tenants/tenant-a/audit-events/event-a", "audit_event"],
  ];
  for (const [path, resourceType] of cases) {
    const db = new DB();
    const response = await worker.fetch(await request({}, "https://private.internal" + path), env(db));
    assert.equal(response.status, 200, path);
    const finalRead = db.calls.find(call =>
      /FROM (sites|assets|sources|observations|audit_events)/.test(call.sql) &&
      call.sql.includes("EXISTS (SELECT 1 FROM tenant_memberships m JOIN tenants t"));
    assert.ok(finalRead, path);
    assert.match(finalRead.sql, new RegExp("g\\.resource_type = '" + resourceType + "'"), path);
    assert.match(finalRead.sql, /g\.resource_id = /, path);
    assert.match(finalRead.sql, /g\.action = 'read'/, path);
    assert.deepEqual(finalRead.args, [ "tenant-a", path.split("/").at(-1), "tenant-a", "operator@example.test" ], path);
  }
});

test("denies when exact resource grant is absent without reading resource", async () => {
  const db = new DB({ grant: false });
  const response = await worker.fetch(await request(), env(db));
  assert.equal(response.status, 404); assert.equal(db.calls.length, 3);
});
test("denies missing and duplicate memberships without grant lookup", async () => {
  const missing = new DB({ membership: false });
  const missingResponse = await worker.fetch(await request(), env(missing));
  assert.equal(missingResponse.status, 404);
  assert.equal(missing.calls.length, 2);

  const duplicate = new DB();
  duplicate.membershipRows = [
    { subject: "operator@example.test", tenant_id: "tenant-a", role: "viewer",
      membership_status: "active", tenant_status: "active" },
    { subject: "operator@example.test", tenant_id: "tenant-a", role: "viewer",
      membership_status: "active", tenant_status: "active" },
  ];
  const duplicateResponse = await worker.fetch(await request(), env(duplicate));
  assert.equal(duplicateResponse.status, 404);
  assert.equal(duplicate.calls.length, 2);
});
test("Supabase identity cannot substitute for the Access subject across site, asset, source, observation and audit reads", async () => {
  const paths = [
    "/internal/v1/tenants/tenant-a/sites/site-a",
    "/internal/v1/tenants/tenant-a/assets/asset-a",
    "/internal/v1/tenants/tenant-a/sources/source-a",
    "/internal/v1/tenants/tenant-a/observations/observation-a",
    "/internal/v1/tenants/tenant-a/audit-events/event-a",
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    assert.equal(String(url), IDENTITY_SUPABASE_ISSUER + "/.well-known/jwks.json");
    return new Response(JSON.stringify({ keys: [identityJwk] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  try {
    for (const path of paths) {
      const db = new DB();
      // Only the Supabase subject has membership and a grant. The Access
      // subject supplied by the authenticated gateway deliberately does not.
      db.membershipRows = [{
        subject: "supabase-user-1", tenant_id: "tenant-a", role: "viewer",
        membership_status: "active", tenant_status: "active",
      }];
      db.grantRows = [{
        subject: "supabase-user-1", tenant_id: "tenant-a",
        resource_type: path.split("/")[5].replace(/s$/, "").replace("audit-event", "audit_event"),
        resource_id: path.split("/").at(-1), action: "read",
      }];
      const response = await worker.fetch(await request({
        "x-nova-supabase-access-token": identitySupabaseToken(),
      }, "https://private.internal" + path), env(db));
      assert.equal(response.status, 404, path);
      const membershipRead = db.calls.find(call => call.sql.includes("FROM tenant_memberships"));
      assert.ok(membershipRead, path);
      assert.equal(membershipRead.args[0], "operator@example.test", path);
      assert.equal(db.calls.some(call => call.sql.includes("FROM tenant_identity_link_requests")), false, path);
      assert.equal(db.calls.some(call =>
        /FROM (sites|assets|sources|observations|audit_events)/.test(call.sql)), false,
        "resource row must not be read for " + path);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("denies inactive memberships and suspended tenants before checking grants or reading resources", async () => {
  const inactiveMembership = new DB();
  inactiveMembership.membershipRows = [{
    subject: "operator@example.test", tenant_id: "tenant-a", role: "viewer",
    membership_status: "inactive", tenant_status: "active",
  }];
  const inactiveResponse = await worker.fetch(await request(), env(inactiveMembership));
  assert.equal(inactiveResponse.status, 404);
  assert.equal(inactiveMembership.calls.length, 2,
    "inactive membership must be rejected before grant lookup");
  assert.equal(inactiveMembership.calls.some(call =>
    call.sql.includes("FROM tenant_resource_grants")), false);
  assert.equal(inactiveMembership.calls.some(call =>
    /FROM (sites|assets|sources|observations|audit_events)/.test(call.sql)), false);

  const suspendedTenant = new DB();
  suspendedTenant.membershipRows = [{
    subject: "operator@example.test", tenant_id: "tenant-a", role: "viewer",
    membership_status: "active", tenant_status: "suspended",
  }];
  const suspendedResponse = await worker.fetch(await request(), env(suspendedTenant));
  assert.equal(suspendedResponse.status, 404);
  assert.equal(suspendedTenant.calls.length, 2,
    "suspended tenant must be rejected before grant lookup");
  assert.equal(suspendedTenant.calls.some(call =>
    call.sql.includes("FROM tenant_resource_grants")), false);
  assert.equal(suspendedTenant.calls.some(call =>
    /FROM (sites|assets|sources|observations|audit_events)/.test(call.sql)), false);
});

test("returns same not-found result for cross-tenant selection", async () => {
  const db = new DB();
  const response = await worker.fetch(await request({},
    "https://private.internal/internal/v1/tenants/tenant-b/sites/site-a"), env(db));
  assert.equal(response.status, 404); assert.equal(db.calls.length, 2);
});

test("rejects a grant whose tenant, subject, resource or action does not exactly match", async () => {
  const mismatches = [
    { subject: "other-subject", tenant_id: "tenant-a", resource_type: "site", resource_id: "site-a", action: "read" },
    { subject: "operator@example.test", tenant_id: "tenant-b", resource_type: "site", resource_id: "site-a", action: "read" },
    { subject: "operator@example.test", tenant_id: "tenant-a", resource_type: "asset", resource_id: "site-a", action: "read" },
    { subject: "operator@example.test", tenant_id: "tenant-a", resource_type: "site", resource_id: "site-b", action: "read" },
    { subject: "operator@example.test", tenant_id: "tenant-a", resource_type: "site", resource_id: "site-a", action: "update" },
  ];
  for (const grant of mismatches) {
    const db = new DB();
    db.grantRows = [grant];
    const response = await worker.fetch(await request(), env(db));
    assert.equal(response.status, 404);
    assert.equal(db.calls.length, 3);
  }
});

test("defensively rejects a resource row returned for another tenant or resource ID", async () => {
  for (const row of [
    { id: "site-a", tenant_id: "tenant-b", name: "cross-tenant row" },
    { id: "site-b", tenant_id: "tenant-a", name: "wrong resource row" },
  ]) {
    const db = new DB();
    db.resourceRows = [row];
    const response = await worker.fetch(await request(), env(db));
    assert.equal(response.status, 404);
    assert.equal(db.calls.length, 4);
  }
});
test("rejects forged signatures, path tampering, and missing internal secret", async () => {
  const signed = await request();
  const forgedHeaders = new Headers(signed.headers);
  forgedHeaders.set("x-nova-internal-signature", "A".repeat(64));
  assert.equal((await worker.fetch(new Request(signed.url, { headers: forgedHeaders }), env(new DB()))).status, 401);
  const pathTamper = new Request("https://private.internal/internal/v1/tenants/tenant-a/assets/site-a", { headers: signed.headers });
  assert.equal((await worker.fetch(pathTamper, env(new DB()))).status, 401);
  assert.equal((await worker.fetch(signed, { ...env(new DB()), INTERNAL_AUTH_SECRET: undefined })).status, 401);
});
test("consumes each signed request ID exactly once", async () => {
  const db = new DB();
  const first = await worker.fetch(await request(), env(db));
  assert.equal(first.status, 200);
  const callsAfterFirst = db.calls.length;
  const replay = await worker.fetch(await request(), env(db));
  assert.equal(replay.status, 401);
  assert.equal(db.calls.length, callsAfterFirst + 1);
});
test("rejects signed envelopes outside the 120-second freshness window", async () => {
  const stale = await request({ "x-nova-gateway-issued-at": String(now - 121) });
  const future = await request({ "x-nova-gateway-issued-at": String(now + 60) });
  assert.equal((await worker.fetch(stale, env(new DB()))).status, 401);
  assert.equal((await worker.fetch(future, env(new DB()))).status, 401);
});
test("fails closed when D1 is unavailable", async () => {
  const response = await worker.fetch(await request(), { ...env(null), DB: null });
  assert.equal(response.status, 503);
});
test("rejects unsupported methods and routes", async () => {
  assert.equal((await worker.fetch(new Request("https://private.internal/internal/v1/tenants/tenant-a/sites/site-a", { method: "POST" }), env(new DB()))).status, 404);
  assert.equal((await worker.fetch(new Request("https://private.internal/internal/debug"), env(new DB()))).status, 404);
});

test("maps every allowlisted route to its canonical resource grant and scoped SQL", async () => {
  const cases = [
    ["sites", "site"], ["assets", "asset"], ["sources", "source"],
    ["observations", "observation"], ["audit-events", "audit_event"],
  ];
  for (const [route, expectedType] of cases) {
    const db = new DB();
    const response = await worker.fetch(new Request(
      `https://private.internal/internal/v1/tenants/tenant-a/${route}/resource-1`,
      { headers: (await request({}, `https://private.internal/internal/v1/tenants/tenant-a/${route}/resource-1`)).headers }), env(db));
    assert.equal(response.status, 200, route);
    assert.equal(db.calls[2].args[2], expectedType, route);
    assert.deepEqual(db.calls[3].args, ["tenant-a", "resource-1"], route);
  }
});
test("denies inactive tenant membership and unknown roles before grant lookup", async () => {
  for (const patch of [
    { membership: [{ subject: "operator@example.test", tenant_id: "tenant-a", role: "viewer",
      membership_status: "active", tenant_status: "suspended" }] },
    { membership: [{ subject: "operator@example.test", tenant_id: "tenant-a", role: "unknown",
      membership_status: "active", tenant_status: "active" }] },
  ]) {
    const db = new DB();
    if (patch.membership) db.membershipRows = patch.membership;
    const response = await worker.fetch(await request(), env(db));
    assert.equal(response.status, 404);
    assert.equal(db.calls.length, 2);
  }
});


test("lists only the authenticated tenant's water-quality criteria entries", async () => {
  const db = new DB();
  db.criteriaRows = [{
    id: "criteria-tn-1", site_id: null, jurisdiction: "TN", version: "1.0",
    title: "Fixture criteria", entry_json: JSON.stringify({ criteria: [{ parameter: "ec", unit: "dS/m", value: 2 }] }),
    source_document_sha256: "a".repeat(64), source_evidence_ref: "evidence:source",
    published_on: "2026-01-01", effective_from: "2026-02-01", effective_to: null,
    supersedes_entry_id: null, supersedes_entry_version: null,
    created_by_subject: "author", created_at: "2026-01-01T00:00:00Z",
  }];
  const response = await worker.fetch(await request({}, "https://private.internal/internal/v1/tenants/tenant-a/water-quality-criteria"), env(db));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].entry.criteria[0].parameter, "ec");
  assert.equal(body.data[0].entry_json, undefined);
  assert.deepEqual(db.calls[1].args, ["operator@example.test", "tenant-a"]);
  assert.deepEqual(db.calls[2].args, ["tenant-a", "operator@example.test", "operator@example.test"]);
});

test("reads one criteria version with tenant, entry and version selectors bound in SQL", async () => {
  const db = new DB();
  db.criteriaRows = [{
    id: "criteria-tn-1", tenant_id: "tenant-a", site_id: null, version: "1.0",
    entry_json: JSON.stringify({ id: "criteria-tn-1", version: "1.0" }),
  }];
  const response = await worker.fetch(await request({}, "https://private.internal/internal/v1/tenants/tenant-a/water-quality-criteria/criteria-tn-1/1.0"), env(db));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.entry.id, "criteria-tn-1");
  assert.deepEqual(db.calls[2].args, ["tenant-a", "criteria-tn-1", "1.0"]);
});

test("denies criteria registry reads for inactive, duplicate or non-reader tenant memberships", async () => {
  for (const membershipRows of [
    [{ subject: "operator@example.test", tenant_id: "tenant-a", role: "viewer", membership_status: "active", tenant_status: "suspended" }],
    [{ subject: "operator@example.test", tenant_id: "tenant-a", role: "unknown", membership_status: "active", tenant_status: "active" }],
    [
      { subject: "operator@example.test", tenant_id: "tenant-a", role: "viewer", membership_status: "active", tenant_status: "active" },
      { subject: "operator@example.test", tenant_id: "tenant-a", role: "viewer", membership_status: "active", tenant_status: "active" },
    ],
  ]) {
    const db = new DB(); db.membershipRows = membershipRows;
    const response = await worker.fetch(await request({}, "https://private.internal/internal/v1/tenants/tenant-a/water-quality-criteria"), env(db));
    assert.equal(response.status, 404);
    assert.equal(db.calls.length, 2);
  }
});

test("jurisdiction reviewer with both approval roles can read a site-scoped entry without a site grant", async () => {
  const db = new DB({ grant: false });
  db.criteriaRows = [{
    id: "criteria-site-a", tenant_id: "tenant-a", site_id: "site-a",
    jurisdiction: "TN", version: "1.0", title: "Site criteria",
    entry_json: JSON.stringify({ id: "criteria-site-a" }),
  }];
  db.reviewerRows = [
    { reviewer_subject: "operator@example.test", jurisdiction: "TN", reviewer_role: "regulatory_reviewer" },
    { reviewer_subject: "operator@example.test", jurisdiction: "TN", reviewer_role: "domain_expert" },
  ];
  const response = await worker.fetch(await request({},
    "https://private.internal/internal/v1/tenants/tenant-a/water-quality-criteria/criteria-site-a/1.0"), env(db));
  assert.equal(response.status, 200);
  const reviewerQuery = db.calls.find(call => call.sql.includes("SELECT DISTINCT r.reviewer_subject"));
  assert.deepEqual(reviewerQuery.args, ["tenant-a", "operator@example.test", "TN"]);
  assert.match(reviewerQuery.sql, /LIMIT 1/);
});

test("criteria list binds the authenticated subject to both site-grant and reviewer-jurisdiction filters", async () => {
  const db = new DB();
  db.criteriaRows = [{
    id: "criteria-site-a", tenant_id: "tenant-a", site_id: "site-a",
    jurisdiction: "TN", version: "1.0", title: "Site criteria",
    entry_json: JSON.stringify({ id: "criteria-site-a" }),
  }];
  const response = await worker.fetch(await request({},
    "https://private.internal/internal/v1/tenants/tenant-a/water-quality-criteria"), env(db));
  assert.equal(response.status, 200);
  const query = db.calls.find(call => call.sql.includes("FROM water_quality_criteria_entries"));
  assert.deepEqual(query.args, ["tenant-a", "operator@example.test", "operator@example.test"]);
  assert.match(query.sql, /tenant_resource_grants g/);
  assert.match(query.sql, /g\.subject = \?/);
  assert.match(query.sql, /water_quality_criteria_reviewers r/);
  assert.match(query.sql, /r\.reviewer_subject = \?/);
  assert.match(query.sql, /r\.jurisdiction = e\.jurisdiction/);
});

test("does not return criteria belonging to another tenant or unknown versions", async () => {
  const db = new DB(); db.criteriaRows = [];
  const response = await worker.fetch(await request({}, "https://private.internal/internal/v1/tenants/tenant-a/water-quality-criteria/criteria-tn-1/9.9"), env(db));
  assert.equal(response.status, 404);
  assert.deepEqual(db.calls[1].args, ["tenant-a", "criteria-tn-1", "9.9"]);
});


const draftEntry = {
  id: "criteria-tn-draft", jurisdiction: "TN", title: "Draft criteria fixture",
  version: "1.0.0", published_on: "2026-01-01", effective_from: "2026-02-01",
  authority: { name: "Declared source", source_evidence_ref: "evidence:source",
    document_digest: "sha256:" + "a".repeat(64) },
  scope: { tenant_id: "tenant-a", crop_ids: ["olive"], irrigation_methods: ["drip"],
    intended_uses: ["agricultural_irrigation"] },
  criteria: [{ parameter: "ec", unit: "dS/m", operator: "max", value: 2,
    reference_clause: "clause 1", evidence_ref: "evidence:clause-1" }],
  review: { status: "draft", approvals: [] },
};

test("creates a criteria draft only for an active tenant owner/admin and appends its first event atomically", async () => {
  const db = new DB();
  db.membershipRows = [{ subject: "operator@example.test", tenant_id: "tenant-a",
    role: "tenant_admin", membership_status: "active", tenant_status: "active" }];
  const response = await worker.fetch(await request({}, 
    "https://private.internal/internal/v1/tenants/tenant-a/water-quality-criteria",
    "POST", JSON.stringify({ entry: draftEntry })), env(db));
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.data.id, draftEntry.id);
  assert.equal(body.data.status, "draft");
  assert.equal(db.batchCalls.length, 1);
  assert.equal(db.batchCalls[0].length, 2);
  assert.match(db.batchCalls[0][0].sql, /INSERT INTO water_quality_criteria_entries/);
  assert.match(db.batchCalls[0][1].sql, /'draft_created'/);
  assert.equal(db.batchCalls[0][0].args[1], "tenant-a");
  assert.equal(db.batchCalls[0][0].args[14], "operator@example.test");
});

test("denies criteria draft creation to read-only tenant members", async () => {
  const db = new DB();
  const response = await worker.fetch(await request({}, 
    "https://private.internal/internal/v1/tenants/tenant-a/water-quality-criteria",
    "POST", JSON.stringify({ entry: draftEntry })), env(db));
  assert.equal(response.status, 404);
  assert.equal(db.batchCalls.length, 0);
});

test("rejects criteria drafts with cross-tenant scope, non-draft state or invalid provenance", async () => {
  const db = new DB();
  db.membershipRows = [{ subject: "operator@example.test", tenant_id: "tenant-a",
    role: "tenant_owner", membership_status: "active", tenant_status: "active" }];
  let index = 0;
  for (const entry of [
    { ...draftEntry, scope: { ...draftEntry.scope, tenant_id: "tenant-b" } },
    { ...draftEntry, review: { status: "approved", approvals: [] } },
    { ...draftEntry, authority: { name: "missing digest" } },
    { ...draftEntry, reviewer_subject: "forged-reviewer" },
    { ...draftEntry, review: { status: "draft", approvals: [{ reviewer_id: "forged", role: "domain_expert" }] } },
  ]) {
    index += 1;
    const response = await worker.fetch(await request({ "x-nova-request-id": "invalid-draft-" + index },
      "https://private.internal/internal/v1/tenants/tenant-a/water-quality-criteria",
      "POST", JSON.stringify({ entry })), env(db));
    assert.ok([400, 422].includes(response.status));
  }
  assert.equal(db.batchCalls.length, 0);
});

test("rejects malformed draft request envelopes and payload sizes", async () => {
  const db = new DB();
  db.membershipRows = [{ subject: "operator@example.test", tenant_id: "tenant-a",
    role: "tenant_admin", membership_status: "active", tenant_status: "active" }];
  const wrongShape = await worker.fetch(await request({}, 
    "https://private.internal/internal/v1/tenants/tenant-a/water-quality-criteria",
    "POST", JSON.stringify({ tenant_id: "tenant-a", reviewer_subject: "forged" })), env(db));
  assert.equal(wrongShape.status, 400);
  const wrongType = await request({}, 
    "https://private.internal/internal/v1/tenants/tenant-a/water-quality-criteria",
    "POST", JSON.stringify({ entry: draftEntry }));
  const headers = new Headers(wrongType.headers); headers.set("content-type", "text/plain");
  assert.equal((await worker.fetch(new Request(wrongType.url, { method: "POST", headers, body: JSON.stringify({ entry: draftEntry }) }), env(db))).status, 400);
  assert.equal(db.batchCalls.length, 0);
});


const reviewerPayload = {
  reviewer_subject: "independent-reviewer@example.test",
  reviewer_role: "regulatory_reviewer",
  jurisdiction: "TN",
  evidence_ref: "evidence:reviewer-appointment",
};

test("tenant owner/admin can assign an independent scoped reviewer with append-only history", async () => {
  const db = new DB();
  db.membershipRows = [{ subject: "operator@example.test", tenant_id: "tenant-a",
    role: "tenant_owner", membership_status: "active", tenant_status: "active" }];
  const response = await worker.fetch(await request({ "x-nova-request-id": "assign-reviewer-1" },
    "https://private.internal/internal/v1/tenants/tenant-a/water-quality-criteria/reviewers/assign",
    "POST", JSON.stringify(reviewerPayload)), env(db));
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.data.reviewer_subject, reviewerPayload.reviewer_subject);
  assert.equal(body.data.status, "active");
  assert.equal(db.batchCalls.length, 1);
  assert.equal(db.batchCalls[0].length, 2);
  assert.match(db.batchCalls[0][0].sql, /INSERT INTO water_quality_criteria_reviewers/);
  assert.match(db.batchCalls[0][1].sql, /water_quality_criteria_reviewer_events/);
  assert.match(db.batchCalls[0][1].sql, /WHERE changes\(\) = 1/);
  assert.equal(db.batchCalls[0][0].args[4], "operator@example.test");
});

test("denies reviewer provisioning to operators and rejects self-assignment or malformed scope", async () => {
  const db = new DB();
  const denied = await worker.fetch(await request({ "x-nova-request-id": "assign-denied-1" },
    "https://private.internal/internal/v1/tenants/tenant-a/water-quality-criteria/reviewers/assign",
    "POST", JSON.stringify(reviewerPayload)), env(db));
  assert.equal(denied.status, 404);
  db.membershipRows = [{ subject: "operator@example.test", tenant_id: "tenant-a",
    role: "tenant_admin", membership_status: "active", tenant_status: "active" }];
  const self = await worker.fetch(await request({ "x-nova-request-id": "assign-self-1" },
    "https://private.internal/internal/v1/tenants/tenant-a/water-quality-criteria/reviewers/assign",
    "POST", JSON.stringify({ ...reviewerPayload, reviewer_subject: "operator@example.test" })), env(db));
  assert.equal(self.status, 400);
  const badRole = await worker.fetch(await request({ "x-nova-request-id": "assign-role-1" },
    "https://private.internal/internal/v1/tenants/tenant-a/water-quality-criteria/reviewers/assign",
    "POST", JSON.stringify({ ...reviewerPayload, reviewer_role: "tenant_admin" })), env(db));
  assert.equal(badRole.status, 400);
  assert.equal(db.batchCalls.length, 0);
});

test("tenant admin can revoke only an active exact-scope reviewer with reason and evidence", async () => {
  const db = new DB();
  db.membershipRows = [{ subject: "operator@example.test", tenant_id: "tenant-a",
    role: "tenant_admin", membership_status: "active", tenant_status: "active" }];
  const payload = { ...reviewerPayload, evidence_ref: "evidence:revocation", reason: "Appointment ended" };
  const response = await worker.fetch(await request({ "x-nova-request-id": "revoke-reviewer-1" },
    "https://private.internal/internal/v1/tenants/tenant-a/water-quality-criteria/reviewers/revoke",
    "POST", JSON.stringify(payload)), env(db));
  assert.equal(response.status, 200);
  assert.match(db.batchCalls[0][0].sql, /UPDATE water_quality_criteria_reviewers SET status = 'revoked'/);
  assert.match(db.batchCalls[0][1].sql, /event_type/);
  assert.match(db.batchCalls[0][1].sql, /WHERE changes\(\) = 1/);
});

test("reviewer list and immutable assignment history are restricted to tenant owners/admins", async () => {
  const db = new DB();
  db.membershipRows = [{ subject: "operator@example.test", tenant_id: "tenant-a",
    role: "tenant_admin", membership_status: "active", tenant_status: "active" }];
  db.reviewerRows = [{ reviewer_subject: reviewerPayload.reviewer_subject, reviewer_role: "regulatory_reviewer", status: "active" }];
  db.reviewerEventRows = [{ event_type: "assigned", actor_subject: "operator@example.test" }];
  const response = await worker.fetch(await request({},
    "https://private.internal/internal/v1/tenants/tenant-a/water-quality-criteria/reviewers"), env(db));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.reviewers.length, 1);
  assert.equal(body.data.events[0].event_type, "assigned");
  const viewer = new DB();
  const denied = await worker.fetch(await request({},
    "https://private.internal/internal/v1/tenants/tenant-a/water-quality-criteria/reviewers"), env(viewer));
  assert.equal(denied.status, 404);
});


const reviewEntryRow = { jurisdiction: "TN", created_by_subject: "criteria-author@example.test" };
const reviewAssignmentRow = (subject, role, jurisdiction = "TN") => ({
  reviewer_subject: subject, reviewer_role: role, jurisdiction,
});

test("tenant owner/admin submits only an existing draft into review", async () => {
  const db = new DB();
  db.membershipRows = [{ subject: "operator@example.test", tenant_id: "tenant-a",
    role: "tenant_admin", membership_status: "active", tenant_status: "active" }];
  db.batchResult = [{ meta: { changes: 1 } }];
  const response = await worker.fetch(await request({ "x-nova-request-id": "criteria-submit-1" },
    "https://private.internal/internal/v1/tenants/tenant-a/water-quality-criteria/criteria-1/1.0/submit",
    "POST", JSON.stringify({})), env(db));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.status, "submitted_for_review");
  assert.equal(db.batchCalls.length, 1);
  assert.match(db.batchCalls[0][0].sql, /submitted_for_review/);
});

test("criteria submit is denied to non-admin members and malformed bodies", async () => {
  const db = new DB();
  const denied = await worker.fetch(await request({ "x-nova-request-id": "criteria-submit-denied" },
    "https://private.internal/internal/v1/tenants/tenant-a/water-quality-criteria/criteria-1/1.0/submit",
    "POST", JSON.stringify({})), env(db));
  assert.equal(denied.status, 404);
  db.membershipRows = [{ subject: "operator@example.test", tenant_id: "tenant-a",
    role: "tenant_owner", membership_status: "active", tenant_status: "active" }];
  const invalid = await worker.fetch(await request({ "x-nova-request-id": "criteria-submit-invalid" },
    "https://private.internal/internal/v1/tenants/tenant-a/water-quality-criteria/criteria-1/1.0/submit",
    "POST", JSON.stringify({ reviewer_subject: "forged" })), env(db));
  assert.equal(invalid.status, 400);
});

test("assigned independent reviewer records first approval without prematurely approving criteria", async () => {
  const db = new DB();
  db.criteriaRows = [reviewEntryRow];
  db.reviewerRows = [reviewAssignmentRow("regulatory@example.test", "regulatory_reviewer")];
  db.batchResult = [{ meta: { changes: 1 } }, { meta: { changes: 0 } }];
  const response = await worker.fetch(await request({ "x-nova-verified-subject": "regulatory@example.test",
    "x-nova-request-id": "criteria-review-regulatory" },
    "https://private.internal/internal/v1/tenants/tenant-a/water-quality-criteria/criteria-1/1.0/review",
    "POST", JSON.stringify({ reviewer_role: "regulatory_reviewer", decision: "approve",
      evidence_ref: "evidence:regulatory-review" })), env(db));
  assert.equal(response.status, 201);
  assert.equal((await response.json()).data.status, "submitted_for_review");
  assert.match(db.batchCalls[0][0].sql, /INSERT INTO water_quality_criteria_approvals/);
  assert.match(db.batchCalls[0][1].sql, /COUNT\(DISTINCT a.reviewer_subject\)/);
});

test("second distinct assigned reviewer role completes approval; rejection records a terminal event", async () => {
  const db = new DB();
  db.criteriaRows = [reviewEntryRow];
  db.reviewerRows = [reviewAssignmentRow("domain@example.test", "domain_expert")];
  db.batchResult = [{ meta: { changes: 1 } }, { meta: { changes: 1 } }];
  const approved = await worker.fetch(await request({ "x-nova-verified-subject": "domain@example.test",
    "x-nova-request-id": "criteria-review-domain" },
    "https://private.internal/internal/v1/tenants/tenant-a/water-quality-criteria/criteria-1/1.0/review",
    "POST", JSON.stringify({ reviewer_role: "domain_expert", decision: "approve",
      evidence_ref: "evidence:domain-review" })), env(db));
  assert.equal(approved.status, 201);
  assert.equal((await approved.json()).data.status, "approved");
  assert.match(db.batchCalls[0][1].sql, /event_type/);
  const rejectDb = new DB();
  rejectDb.criteriaRows = [reviewEntryRow];
  rejectDb.reviewerRows = [reviewAssignmentRow("regulatory@example.test", "regulatory_reviewer")];
  const rejected = await worker.fetch(await request({ "x-nova-verified-subject": "regulatory@example.test",
    "x-nova-request-id": "criteria-review-reject" },
    "https://private.internal/internal/v1/tenants/tenant-a/water-quality-criteria/criteria-1/1.0/review",
    "POST", JSON.stringify({ reviewer_role: "regulatory_reviewer", decision: "reject",
      evidence_ref: "evidence:rejection", reason: "Evidence is incomplete" })), env(rejectDb));
  assert.equal(rejected.status, 201);
  assert.equal((await rejected.json()).data.status, "rejected");
  assert.match(rejectDb.batchCalls[0][1].sql, /'rejected'/);
});

test("unassigned, revoked, wrong-scope and author identities cannot review criteria", async () => {
  let deniedIndex = 0;
  for (const { subject, assignment } of [
    { subject: "unassigned@example.test", assignment: [] },
    { subject: "criteria-author@example.test", assignment: [reviewAssignmentRow("criteria-author@example.test", "domain_expert")] },
    { subject: "wrong-jurisdiction@example.test", assignment: [reviewAssignmentRow("wrong-jurisdiction@example.test", "domain_expert", "FR")] },
  ]) {
    deniedIndex += 1;
    const db = new DB();
    db.criteriaRows = [reviewEntryRow];
    db.reviewerRows = assignment;
    const response = await worker.fetch(await request({ "x-nova-verified-subject": subject,
      "x-nova-request-id": "criteria-review-denied-" + deniedIndex },
      "https://private.internal/internal/v1/tenants/tenant-a/water-quality-criteria/criteria-1/1.0/review",
      "POST", JSON.stringify({ reviewer_role: "domain_expert", decision: "approve",
        evidence_ref: "evidence:review" })), env(db));
    assert.equal(response.status, 404);
    assert.equal(db.batchCalls.length, 0);
  }
});

test("review requires a rejection reason and returns conflict on terminal or duplicate writes", async () => {
  const db = new DB();
  db.criteriaRows = [reviewEntryRow];
  db.reviewerRows = [reviewAssignmentRow("domain@example.test", "domain_expert")];
  const invalid = await worker.fetch(await request({ "x-nova-verified-subject": "domain@example.test",
    "x-nova-request-id": "criteria-review-invalid" },
    "https://private.internal/internal/v1/tenants/tenant-a/water-quality-criteria/criteria-1/1.0/review",
    "POST", JSON.stringify({ reviewer_role: "domain_expert", decision: "reject",
      evidence_ref: "evidence:review" })), env(db));
  assert.equal(invalid.status, 400);
  db.batchError = new Error("unique constraint failed");
  const conflict = await worker.fetch(await request({ "x-nova-verified-subject": "domain@example.test",
    "x-nova-request-id": "criteria-review-conflict" },
    "https://private.internal/internal/v1/tenants/tenant-a/water-quality-criteria/criteria-1/1.0/review",
    "POST", JSON.stringify({ reviewer_role: "domain_expert", decision: "approve",
      evidence_ref: "evidence:review" })), env(db));
  assert.equal(conflict.status, 409);
});


test("assigned external reviewer can read only the matching jurisdiction criteria and full review context", async () => {
  const db = new DB();
  db.criteriaRows = [{ id: "criteria-1", tenant_id: "tenant-a", version: "1.0",
    jurisdiction: "TN", created_by_subject: "criteria-author@example.test",
    entry_json: JSON.stringify({ id: "criteria-1", criteria: [{ parameter: "ec", value: 2 }] }) }];
  db.membershipRows = [];
  db.reviewerRows = [reviewAssignmentRow("reviewer@example.test", "domain_expert")];
  db.criteriaEventRows = [{ event_type: "submitted_for_review", actor_subject: "tenant-admin" }];
  db.approvalRows = [{ reviewer_subject: "regulatory@example.test", reviewer_role: "regulatory_reviewer",
    decision: "approve", evidence_ref: "evidence:regulatory", reviewed_at: "2026-11-13T10:00:00Z" }];
  const response = await worker.fetch(await request({ "x-nova-verified-subject": "reviewer@example.test" },
    "https://private.internal/internal/v1/tenants/tenant-a/water-quality-criteria/criteria-1/1.0"), env(db));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.lifecycle.status, "submitted_for_review");
  assert.equal(body.data.approvals[0].decision, "approve");
  assert.equal(body.data.legal_status, "not_verified");
  assert.equal(body.data.operational_decision, "not_authorized");
});

test("unassigned and wrong-jurisdiction identities cannot read criteria review context", async () => {
  for (const assignment of [
    [],
    [reviewAssignmentRow("reviewer@example.test", "domain_expert", "FR")],
  ]) {
    const db = new DB();
    db.criteriaRows = [{ id: "criteria-1", tenant_id: "tenant-a", version: "1.0",
      jurisdiction: "TN", created_by_subject: "criteria-author@example.test",
      entry_json: JSON.stringify({ id: "criteria-1" }) }];
    db.membershipRows = [];
    db.reviewerRows = assignment;
    const response = await worker.fetch(await request({ "x-nova-verified-subject": "reviewer@example.test" },
      "https://private.internal/internal/v1/tenants/tenant-a/water-quality-criteria/criteria-1/1.0"), env(db));
    assert.equal(response.status, 404);
  }
});


const resolutionEntry = {
  id: "criteria-resolve-1", jurisdiction: "TN", title: "Fixture criteria",
  version: "1.0", published_on: "2026-01-01", effective_from: "2026-02-01",
  authority: { name: "Declared source", source_evidence_ref: "evidence:source",
    document_digest: "sha256:" + "a".repeat(64) },
  scope: { tenant_id: "tenant-a", site_id: "site-a", crop_ids: ["olive"],
    irrigation_methods: ["drip"], intended_uses: ["agricultural_irrigation"] },
  criteria: [{ parameter: "ec", unit: "dS/m", operator: "max", value: 2,
    reference_clause: "clause 1", evidence_ref: "evidence:clause-1" }],
  review: { status: "draft", approvals: [] },
};
const resolutionContext = { tenant_id: "tenant-a", site_id: "site-a",
  jurisdiction: "TN", crop_id: "olive", irrigation_method: "drip",
  intended_use: "agricultural_irrigation" };
const resolutionApprovals = [
  { reviewer_subject: "regulatory@example.test", reviewer_role: "regulatory_reviewer",
    decision: "approve", evidence_ref: "evidence:regulatory", reviewed_at: "2026-11-13T10:00:00Z" },
  { reviewer_subject: "domain@example.test", reviewer_role: "domain_expert",
    decision: "approve", evidence_ref: "evidence:domain", reviewed_at: "2026-11-13T11:00:00Z" },
];

test("resolves approved database criteria only after persisted dual-role approval and exact scope match", async () => {
  const db = new DB();
  db.criteriaRows = [{ id: resolutionEntry.id, tenant_id: "tenant-a", version: "1.0",
    title: resolutionEntry.title, site_id: "site-a", entry_json: JSON.stringify(resolutionEntry) }];
  db.criteriaEventRows = [{ event_type: "draft_created" }, { event_type: "submitted_for_review" },
    { event_type: "approved" }];
  db.approvalRows = resolutionApprovals;
  db.membershipRows = [{ subject: "operator@example.test", tenant_id: "tenant-a",
    role: "viewer", membership_status: "active", tenant_status: "active" }];
  const response = await worker.fetch(await request({ "x-nova-request-id": "criteria-resolve-approved" },
    "https://private.internal/internal/v1/tenants/tenant-a/water-quality-criteria/criteria-resolve-1/1.0/resolve",
    "POST", JSON.stringify({ context: resolutionContext, sampled_at: "2026-05-10T10:00:00Z" })), env(db));
  assert.equal(response.status, 200);
  const result = (await response.json()).data;
  assert.equal(result.status, "approved_entry_scope_match");
  assert.equal(result.lifecycle_status, "approved");
  assert.equal(result.criteria[0].parameter, "ec");
  assert.equal(result.legal_status, "not_independently_verified");
  assert.equal(result.operational_decision, "not_authorized");
});

test("does not resolve draft, pending, rejected, expired or mismatched registry entries", async () => {
  for (const { event, context, sampled_at, expected } of [
    { event: "draft_created", context: resolutionContext, sampled_at: "2026-05-10T10:00:00Z", expected: "registry_entry_not_approved" },
    { event: "submitted_for_review", context: resolutionContext, sampled_at: "2026-05-10T10:00:00Z", expected: "registry_entry_not_approved" },
    { event: "rejected", context: resolutionContext, sampled_at: "2026-05-10T10:00:00Z", expected: "registry_entry_not_approved" },
    { event: "approved", context: { ...resolutionContext, crop_id: "other" }, sampled_at: "2026-05-10T10:00:00Z", expected: "registry_scope_mismatch" },
    { event: "approved", context: resolutionContext, sampled_at: "2025-12-31T10:00:00Z", expected: "registry_entry_not_effective_on_sample_date" },
  ]) {
    const db = new DB();
    db.criteriaRows = [{ id: resolutionEntry.id, tenant_id: "tenant-a", version: "1.0",
      entry_json: JSON.stringify(resolutionEntry) }];
    db.criteriaEventRows = [{ event_type: event }];
    db.approvalRows = resolutionApprovals;
    db.membershipRows = [{ subject: "operator@example.test", tenant_id: "tenant-a",
      role: "viewer", membership_status: "active", tenant_status: "active" }];
    const response = await worker.fetch(await request({ "x-nova-request-id": "criteria-resolve-" + event },
      "https://private.internal/internal/v1/tenants/tenant-a/water-quality-criteria/criteria-resolve-1/1.0/resolve",
      "POST", JSON.stringify({ context, sampled_at })), env(db));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.reason, expected);
  }
});

test("criteria resolution rejects cross-tenant and malformed caller context", async () => {
  const db = new DB();
  db.membershipRows = [{ subject: "operator@example.test", tenant_id: "tenant-a",
    role: "viewer", membership_status: "active", tenant_status: "active" }];
  const response = await worker.fetch(await request({ "x-nova-request-id": "criteria-resolve-cross" },
    "https://private.internal/internal/v1/tenants/tenant-a/water-quality-criteria/criteria-resolve-1/1.0/resolve",
    "POST", JSON.stringify({ context: { ...resolutionContext, tenant_id: "tenant-b" },
      sampled_at: "2026-05-10T10:00:00Z" })), env(db));
  assert.equal(response.status, 400);
});


test("assesses sample values only against the approved tenant criteria and preserves comparison-only meaning", async () => {
  const db = new DB();
  db.criteriaRows = [{ id: resolutionEntry.id, tenant_id: "tenant-a", version: "1.0",
    title: resolutionEntry.title, site_id: "site-a", entry_json: JSON.stringify(resolutionEntry) }];
  db.criteriaEventRows = [{ event_type: "draft_created" }, { event_type: "submitted_for_review" },
    { event_type: "approved" }];
  db.approvalRows = resolutionApprovals;
  db.membershipRows = [{ subject: "operator@example.test", tenant_id: "tenant-a",
    role: "viewer", membership_status: "active", tenant_status: "active" }];
  db.observationEvidenceRows = [{
    id: "obs-sample-1", tenant_id: "tenant-a", site_id: "site-a",
    metric: "ec", value: 1.5, unit: "dS/m", observed_at: "2026-05-10T10:00:00Z",
    verification_status: "verified",
  }];
  const samples = [
    { id: "sample-within", parameter: "ec", value: 1.5, unit: "dS/m", sampled_at: "2026-05-10T10:00:00Z", provenance: { source_type: "measured", method: "field_meter", evidence_ref: "observation:obs-sample-1" } },
    { id: "sample-outside", parameter: "ec", value: 3, unit: "dS/m", sampled_at: "2026-05-10T10:00:00Z", provenance: { source_type: "laboratory", method: "ion_chromatography", laboratory: "Declared lab", evidence_ref: "report:sample-2" } },
  ];
  const response = await worker.fetch(await request({ "x-nova-request-id": "criteria-assess-approved" },
    "https://private.internal/internal/v1/tenants/tenant-a/water-quality-criteria/criteria-resolve-1/1.0/assess",
    "POST", JSON.stringify({ context: resolutionContext, samples })), env(db));
  assert.equal(response.status, 200);
  const result = (await response.json()).data;
  assert.equal(result.status, "partial_criteria_comparison");
  assert.equal(result.results[0].status, "within_declared_criterion");
  assert.equal(result.results[0].sample_provenance.verification_status, "matched_to_verified_core_observation");
  assert.equal(result.results[1].status, "not_assessed");
  assert.equal(result.results[1].reason, "external_evidence_verification_not_configured");
  assert.equal(result.interpretation, "comparison_to_caller_supplied_criteria_only");
  assert.equal(result.scientific_suitability, "not_assessed");
  assert.equal(result.operational_decision, "not_authorized");
});

test("does not assess samples against draft or pending criteria and leaves invalid samples not assessed", async () => {
  const db = new DB();
  db.criteriaRows = [{ id: resolutionEntry.id, tenant_id: "tenant-a", version: "1.0",
    title: resolutionEntry.title, site_id: "site-a", entry_json: JSON.stringify(resolutionEntry) }];
  db.criteriaEventRows = [{ event_type: "submitted_for_review" }];
  db.approvalRows = resolutionApprovals;
  db.membershipRows = [{ subject: "operator@example.test", tenant_id: "tenant-a",
    role: "analyst", membership_status: "active", tenant_status: "active" }];
  const response = await worker.fetch(await request({ "x-nova-request-id": "criteria-assess-pending" },
    "https://private.internal/internal/v1/tenants/tenant-a/water-quality-criteria/criteria-resolve-1/1.0/assess",
    "POST", JSON.stringify({ context: resolutionContext, samples: [
      { id: "pending-sample", parameter: "ec", value: 1, unit: "dS/m", sampled_at: "2026-05-10T10:00:00Z", provenance: { source_type: "measured", method: "field_meter", evidence_ref: "evidence:pending" } },
      { id: "missing-time", parameter: "ec", value: 1, unit: "dS/m", provenance: { source_type: "measured", method: "field_meter", evidence_ref: "evidence:missing-time" } },
    ] })), env(db));
  assert.equal(response.status, 200);
  const result = (await response.json()).data;
  assert.equal(result.status, "partial_criteria_comparison");
  assert.equal(result.results[0].reason, "registry_entry_not_approved");
  assert.equal(result.results[1].reason, "sample_value_unit_or_date_invalid");
});

test("criteria sample assessment rejects oversized batches and caller scope injection", async () => {
  const db = new DB();
  db.membershipRows = [{ subject: "operator@example.test", tenant_id: "tenant-a",
    role: "viewer", membership_status: "active", tenant_status: "active" }];
  const tooMany = await worker.fetch(await request({ "x-nova-request-id": "criteria-assess-too-many" },
    "https://private.internal/internal/v1/tenants/tenant-a/water-quality-criteria/criteria-1/1.0/assess",
    "POST", JSON.stringify({ context: resolutionContext, samples: Array.from({ length: 51 }, () => ({})) })), env(db));
  assert.equal(tooMany.status, 400);
  const badContext = await worker.fetch(await request({ "x-nova-request-id": "criteria-assess-bad-context" },
    "https://private.internal/internal/v1/tenants/tenant-a/water-quality-criteria/criteria-1/1.0/assess",
    "POST", JSON.stringify({ context: { ...resolutionContext, tenant_id: "tenant-b" }, samples: [{}] })), env(db));
  assert.equal(badContext.status, 400);
});


test("tenant admin registers PDF bytes through the site-scoped evidence route", async () => {
  const db = new DB();
  db.membershipRows = [{ subject: "operator@example.test", tenant_id: "tenant-a",
    role: "tenant_admin", membership_status: "active", tenant_status: "active" }];
  const bytes = Buffer.from("%PDF-1.4\
lab evidence\
%%EOF");
  const payload = { file_name: "report.pdf", media_type: "application/pdf",
    laboratory_name: "Declared lab", report_number: "RPT-1",
    issued_at: "2026-10-01T10:30:00Z", document_base64: bytes.toString("base64") };
  const response = await worker.fetch(await request({}, 
    "https://private.internal/internal/v1/tenants/tenant-a/sites/site-a/laboratory-reports",
    "POST", JSON.stringify(payload)), env(db));
  assert.equal(response.status, 201);
  assert.equal(db.batchCalls.length, 1);
  assert.match(db.batchCalls[0][0].sql, /INSERT(?: OR IGNORE)? INTO laboratory_report_evidence/);
  assert.match(db.batchCalls[0][1].sql, /INSERT INTO laboratory_report_evidence_events/);
  assert.equal(db.batchCalls[0][0].args[1], "tenant-a");
  assert.equal(db.batchCalls[0][0].args[2], "site-a");
  assert.equal(db.batchCalls[0][0].args[3], "report.pdf");
  assert.equal(db.batchCalls[0][0].args[4], bytes.length);
});

test("read-only tenant members cannot register laboratory report evidence", async () => {
  const db = new DB();
  const payload = { file_name: "report.pdf", media_type: "application/pdf",
    laboratory_name: "Declared lab", report_number: "RPT-1",
    issued_at: "2026-10-01", document_base64: Buffer.from("%PDF-1.4").toString("base64") };
  const response = await worker.fetch(await request({}, 
    "https://private.internal/internal/v1/tenants/tenant-a/sites/site-a/laboratory-reports",
    "POST", JSON.stringify(payload)), env(db));
  assert.equal(response.status, 404);
  assert.equal(db.batchCalls.length, 0);
});


test("site-granted reader retrieves laboratory report bytes only after stored digest verification", async () => {
  const db = new DB();
  const bytes = Buffer.from("%PDF-1.4\
retrievable report\
%%EOF");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  db.laboratoryEvidenceRows = [{
    id: "lab-report-a", tenant_id: "tenant-a", site_id: "site-a",
    evidence_type: "laboratory_report", file_name: "report.pdf", media_type: "application/pdf",
    byte_length: bytes.length, sha256, document_bytes: new Uint8Array(bytes),
    laboratory_name: "Declared lab", report_number: "RPT-1", sample_reference: null,
    issued_at: "2026-10-01", verification_status: "registered_unverified",
    uploaded_by_subject: "owner@example.test", created_at: "2026-11-13T10:00:00Z",
  }];
  const response = await worker.fetch(await request({}, 
    "https://private.internal/internal/v1/tenants/tenant-a/sites/site-a/laboratory-reports/lab-report-a"),
    env(db));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.data.sha256, sha256);
  assert.equal(Buffer.from(result.data.document_base64, "base64").compare(bytes), 0);
  assert.equal(result.data.verification_status, "registered_unverified");
});


class ProvisioningDB {
  constructor(batchResult, existingRows = []) {
    this.batchResult = batchResult;
    this.existingRows = existingRows;
    this.batchCalls = [];
    this.nonces = new Set();
  }
  prepare(sql) {
    const db = this;
    return { bind(...args) { return { sql, args,
      async run() {
        if (sql.includes("INSERT INTO internal_request_nonces")) {
          if (db.nonces.has(args[0])) return { meta: { changes: 0 } };
          db.nonces.add(args[0]);
          return { meta: { changes: 1 } };
        }
        throw new Error("unexpected provisioning write");
      },
      async all() {
        if (sql.includes("FROM tenant_provisioning_requests")) {
          if (sql.includes("WHERE nova_os_tenant_id = ?")) {
            return { results: db.existingRows.filter(row => row.nova_os_tenant_id === args[0]) };
          }
          if (sql.includes("WHERE r.actor_subject = ? AND r.idempotency_key = ?")) {
            return { results: db.existingRows.filter(row => row.actor_subject === args[0] &&
              row.idempotency_key === args[1]) };
          }
          return { results: db.existingRows };
        }
        throw new Error("unexpected provisioning read");
      },
    }; } };
  }
  async batch(statements) {
    this.batchCalls.push(statements);
    return this.batchResult;
  }
}
const provisioningKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const provisioningJwk = {
  ...provisioningKeyPair.publicKey.export({ format: "jwk" }),
  kid: "provisioning-test-key", alg: "RS256", use: "sig", key_ops: ["verify"],
};
const novaOsOwnerKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const coreReceiptKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const novaOsOwnerJwk = {
  ...novaOsOwnerKeyPair.publicKey.export({ format: "jwk" }),
  kid: "nova-os-owner-test-key", alg: "RS256", use: "sig", key_ops: ["verify"],
};
function novaOsOwnerAssertion(subject = "supabase-owner", tenantId = "nova-tenant-001", jti = "owner-proof-001") {
  const b64 = value => Buffer.from(value).toString("base64url");
  const header = b64(JSON.stringify({ alg: "RS256", typ: "JWT", kid: novaOsOwnerJwk.kid }));
  const claims = b64(JSON.stringify({
    iss: "https://nova-os.example.test/tenant-provisioning",
    aud: "nova-core-tenant-provisioning",
    sub: subject,
    supabase_issuer: "https://project.example.test/auth/v1",
    nova_os_tenant_id: tenantId,
    role: "owner", membership_status: "active", tenant_status: "active",
    iat: now - 10, exp: now + 120, jti,
  }));
  const input = header + "." + claims;
  return input + "." + sign("RSA-SHA256", Buffer.from(input), novaOsOwnerKeyPair.privateKey).toString("base64url");
}
function provisioningSupabaseToken(subject = "supabase-owner") {
  const b64 = value => Buffer.from(value).toString("base64url");
  const header = b64(JSON.stringify({ alg: "RS256", typ: "JWT", kid: provisioningJwk.kid }));
  const claims = b64(JSON.stringify({
    iss: "https://project.example.test/auth/v1", aud: "authenticated",
    sub: subject, role: "authenticated", iat: now - 10, exp: now + 600,
  }));
  const input = header + "." + claims;
  return input + "." + sign("RSA-SHA256", Buffer.from(input), provisioningKeyPair.privateKey).toString("base64url");
}
async function withProvisioningJwks(callback) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    assert.equal(String(url), "https://project.example.test/auth/v1/.well-known/jwks.json");
    return new Response(JSON.stringify({ keys: [provisioningJwk] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  try { return await callback(); } finally { globalThis.fetch = originalFetch; }
}
const provisioningPath = "https://private.internal/internal/v1/tenants";
const provisioningBody = JSON.stringify({
  display_name: "Research tenant", idempotency_key: "bootstrap-001",
  nova_os_tenant_id: "nova-tenant-001",
  nova_os_owner_assertion: novaOsOwnerAssertion(),
});
const provisioningHeaders = () => ({
  "x-nova-supabase-access-token": provisioningSupabaseToken(),
});
const provisioningEnv = db => ({
  ...env(db), TENANT_PROVISIONING_SUBJECTS: "operator@example.test",
  NOVA_OS_PROVISIONING_AUTH_ISSUER: "https://nova-os.example.test/tenant-provisioning",
  NOVA_OS_PROVISIONING_AUTH_AUDIENCE: "nova-core-tenant-provisioning",
  NOVA_OS_PROVISIONING_AUTH_JWK: JSON.stringify(novaOsOwnerJwk),
  NOVA_OS_MAPPING_RECEIPT_ISSUER: "https://nova-core.example.test/provisioning",
  NOVA_OS_MAPPING_RECEIPT_AUDIENCE: "https://nova-os.example.test/mapping",
  NOVA_OS_MAPPING_RECEIPT_KEY_ID: "core-receipt-test-key",
  NOVA_OS_MAPPING_RECEIPT_PRIVATE_KEY: coreReceiptKeyPair.privateKey.export({ type: "pkcs8", format: "pem" }),
});

test("tenant provisioning fails closed before writes when the Core mapping receipt signer is not configured", async () => {
  const db = new ProvisioningDB([]);
  await withProvisioningJwks(async () => {
    const incomplete = { ...provisioningEnv(db) };
    delete incomplete.NOVA_OS_MAPPING_RECEIPT_PRIVATE_KEY;
    const response = await worker.fetch(
      await request(provisioningHeaders(), provisioningPath, "POST", provisioningBody), incomplete);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "nova_os_mapping_receipt_not_configured");
    assert.equal(db.batchCalls.length, 0);
    assert.equal(db.existingRows.length, 0);
  });
});

test("tenant provisioning requires a Supabase bearer in addition to the verified Access identity", async () => {
  const db = new ProvisioningDB([]);
  const response = await worker.fetch(await request({}, provisioningPath, "POST", provisioningBody), provisioningEnv(db));
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "supabase_identity_required");
  assert.equal(db.batchCalls.length, 0);
  assert.equal(db.existingRows.length, 0);
});

test("tenant provisioning rejects missing or invalid NOVA OS owner proof before database writes", async () => {
  const db = new ProvisioningDB([]);
  await withProvisioningJwks(async () => {
    const body = JSON.stringify({ ...JSON.parse(provisioningBody), nova_os_owner_assertion: "header.payload.signature" });
    const response = await worker.fetch(await request(provisioningHeaders(), provisioningPath, "POST", body), provisioningEnv(db));
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, "nova_os_owner_authorization_invalid");
    assert.equal(db.batchCalls.length, 0);
    assert.equal(db.existingRows.length, 0);
  });
});

test("tenant provisioning fails closed when the NOVA OS owner assertion verifier is not configured", async () => {
  const db = new ProvisioningDB([]);
  await withProvisioningJwks(async () => {
    const response = await worker.fetch(await request(provisioningHeaders(), provisioningPath, "POST", provisioningBody), {
      ...env(db), TENANT_PROVISIONING_SUBJECTS: "operator@example.test",
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "nova_os_provisioning_auth_not_configured");
    assert.equal(db.batchCalls.length, 0);
    assert.equal(db.existingRows.length, 0);
  });
});

test("tenant provisioning rejects owner assertions for another NOVA OS tenant", async () => {
  const db = new ProvisioningDB([]);
  const body = JSON.stringify({
    ...JSON.parse(provisioningBody),
    nova_os_owner_assertion: novaOsOwnerAssertion("supabase-owner", "another-tenant", "owner-proof-other"),
  });
  await withProvisioningJwks(async () => {
    const response = await worker.fetch(await request(provisioningHeaders(), provisioningPath, "POST", body), provisioningEnv(db));
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, "nova_os_owner_authorization_invalid");
    assert.equal(db.batchCalls.length, 0);
    assert.equal(db.existingRows.length, 0);
  });
});

test("tenant provisioning requires an exact configured Access subject allowlist", async () => {
  const db = new ProvisioningDB([]);
  await withProvisioningJwks(async () => {
    const denied = await worker.fetch(await request(provisioningHeaders(), provisioningPath, "POST", provisioningBody), {
      ...provisioningEnv(db), TENANT_PROVISIONING_SUBJECTS: "different-subject",
    });
    assert.equal(denied.status, 404);
    assert.equal(db.batchCalls.length, 0);
    const missing = await worker.fetch(await request({ ...provisioningHeaders(), "x-nova-request-id": "provision-no-allowlist" },
      provisioningPath, "POST", provisioningBody), env(db));
    assert.equal(missing.status, 404);
    assert.equal(db.batchCalls.length, 0);
  });
});

test("tenant provisioning rejects caller-selected owners and unknown fields", async () => {
  const db = new ProvisioningDB([]);
  const body = JSON.stringify({ display_name: "Research tenant", idempotency_key: "bootstrap-002",
    nova_os_tenant_id: "nova-tenant-001", nova_os_owner_assertion: novaOsOwnerAssertion(),
    initial_owner_subject: "attacker-subject" });
  await withProvisioningJwks(async () => {
    const response = await worker.fetch(await request(provisioningHeaders(), provisioningPath, "POST", body), provisioningEnv(db));
    assert.equal(response.status, 400);
    assert.equal(db.batchCalls.length, 0);
  });
});

test("tenant provisioning atomically binds the Core tenant to both verified identities and the NOVA OS tenant", async () => {
  const db = new ProvisioningDB(Array.from({ length: 10 }, () => ({ meta: { changes: 1 } })));
  await withProvisioningJwks(async () => {
    const response = await worker.fetch(await request(provisioningHeaders(), provisioningPath, "POST", provisioningBody), provisioningEnv(db));
    assert.equal(response.status, 201);
    const result = (await response.json()).data;
    assert.equal(result.display_name, "Research tenant");
    assert.equal(result.tenant_status, "active");
    assert.equal(result.membership_role, "tenant_owner");
    assert.equal(result.membership_status, "active");
    assert.equal(result.created, true);
    assert.match(result.tenant_id, /^tenant-[0-9a-f-]{36}$/);
    assert.equal(result.mapping_receipt_id, "request-123");
    assert.ok(result.mapping_receipt_expires_at > now);
    const [receiptHeader, receiptClaims, receiptSignature] = result.mapping_receipt.split(".");
    const decodedHeader = JSON.parse(Buffer.from(receiptHeader, "base64url").toString("utf8"));
    const decodedClaims = JSON.parse(Buffer.from(receiptClaims, "base64url").toString("utf8"));
    assert.equal(decodedHeader.alg, "RS256");
    assert.equal(decodedHeader.kid, "core-receipt-test-key");
    assert.equal(decodedClaims.core_tenant_id, result.tenant_id);
    assert.equal(decodedClaims.nova_os_tenant_id, "nova-tenant-001");
    assert.equal(decodedClaims.access_subject, "operator@example.test");
    assert.equal(decodedClaims.supabase_subject, "supabase-owner");
    assert.equal(decodedClaims.owner_assertion_jti, "owner-proof-001");
    assert.equal(decodedClaims.jti, "request-123");
    assert.equal(await webcrypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      await webcrypto.subtle.importKey("jwk", {
        ...coreReceiptKeyPair.publicKey.export({ format: "jwk" }),
        key_ops: ["verify"], ext: true,
      }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]),
      Buffer.from(receiptSignature, "base64url"),
      new TextEncoder().encode(receiptHeader + "." + receiptClaims),
    ), true);
    assert.equal(db.batchCalls.length, 1);
    const sql = db.batchCalls[0].map(statement => statement.sql).join("\n");
    assert.match(sql, /INSERT INTO tenant_memberships/);
    assert.match(sql, /'tenant_owner', 'active'/);
    assert.match(sql, /INSERT INTO tenant_membership_events/);
    assert.match(sql, /INSERT INTO tenant_provisioning_requests/);
    const record = db.batchCalls[0].at(-1);
    assert.ok(record.args.includes("https://project.example.test/auth/v1"));
    assert.ok(record.args.includes("supabase-owner"));
    assert.ok(record.args.includes("nova-tenant-001"));
    assert.ok(record.args.includes("owner-proof-001"));
    assert.ok(db.batchCalls[0].every(statement => !statement.args.includes("attacker-subject")));
  });
});

test("tenant provisioning returns the existing result only for the same dual identity and NOVA OS tenant", async () => {
  const digest = createHash("sha256").update(JSON.stringify([
    "operator@example.test", "https://project.example.test/auth/v1",
    "supabase-owner", "nova-tenant-001", "owner-proof-001", "Research tenant",
  ])).digest("hex");
  const db = new ProvisioningDB(Array.from({ length: 10 }, () => ({ meta: { changes: 0 } })), [{
    actor_subject: "operator@example.test", idempotency_key: "bootstrap-001",
    request_sha256: digest, supabase_issuer: "https://project.example.test/auth/v1",
    supabase_subject: "supabase-owner", nova_os_tenant_id: "nova-tenant-001", nova_os_assertion_jti: "owner-proof-001",
    id: "provisioning-request-existing",
    tenant_id: "tenant-existing", display_name: "Research tenant", status: "active",
    membership_id: "membership-existing", role: "tenant_owner", membership_status: "active",
  }]);
  await withProvisioningJwks(async () => {
    const response = await worker.fetch(await request(provisioningHeaders(), provisioningPath, "POST", provisioningBody), provisioningEnv(db));
    assert.equal(response.status, 200);
    const result = (await response.json()).data;
    assert.equal(result.tenant_id, "tenant-existing");
    assert.equal(result.created, false);
    assert.equal(result.mapping_receipt_id, "provisioning-request-existing");
  });
});

test("tenant provisioning rejects idempotency key reuse across another Supabase identity or NOVA OS tenant", async () => {
  const db = new ProvisioningDB(Array.from({ length: 10 }, () => ({ meta: { changes: 0 } })), [{
    actor_subject: "operator@example.test", idempotency_key: "bootstrap-001",
    request_sha256: "0".repeat(64), supabase_issuer: "https://project.example.test/auth/v1",
    supabase_subject: "another-user", nova_os_tenant_id: "another-tenant", nova_os_assertion_jti: "another-proof",
    tenant_id: "tenant-existing", display_name: "Other name", status: "active",
    membership_id: "membership-existing", role: "tenant_owner", membership_status: "active",
  }]);
  await withProvisioningJwks(async () => {
    const response = await worker.fetch(await request(provisioningHeaders(), provisioningPath, "POST", provisioningBody), provisioningEnv(db));
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, "idempotency_key_reused");
  });
});


class MembershipEventsDB {
  constructor(role = "tenant_owner", eventRows = []) {
    this.role = role;
    this.eventRows = eventRows;
    this.nonces = new Set();
    this.calls = [];
  }
  prepare(sql) {
    const db = this;
    return { bind(...args) { return {
      async run() {
        if (sql.includes("INSERT INTO internal_request_nonces")) {
          if (db.nonces.has(args[0])) return { meta: { changes: 0 } };
          db.nonces.add(args[0]);
          return { meta: { changes: 1 } };
        }
        throw new Error("unexpected audit read write");
      },
      async all() {
        db.calls.push({ sql, args });
        if (sql.includes("FROM tenant_memberships")) return { results: [{
          subject: "operator@example.test", tenant_id: args[1], role: db.role, membership_status: "active",
        }] };
        if (sql.includes("FROM tenant_membership_events")) return { results: db.eventRows };
        if (sql.includes("FROM tenant_membership_invitation_events")) return { results: [] };
        if (sql.includes("FROM tenant_site_grant_events")) return { results: [] };
        if (sql.includes("FROM tenant_resource_grant_events")) return { results: [] };
        throw new Error("unexpected audit read SQL");
      },
    }; } };
  }
}

test("tenant owners and admins read only their tenant's bounded membership audit history", async () => {
  const event = { id: "event-1", tenant_id: "tenant-a", membership_id: "membership-a",
    subject: "owner-sub", actor_subject: "operator@example.test", event_type: "created",
    previous_role: null, new_role: "tenant_owner", previous_status: null, new_status: "active",
    reason: "Initial owner", request_id: "request-event-1", created_at: "2026-11-14T10:00:00Z" };
  for (const role of ["tenant_owner", "tenant_admin"]) {
    const db = new MembershipEventsDB(role, [event]);
    const response = await worker.fetch(await request({}, 
      "https://private.internal/internal/v1/tenants/tenant-a/membership-events"), env(db));
    assert.equal(response.status, 200);
    const audit = (await response.json()).data;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].event_type, "membership_created");
    assert.equal(audit[0].tenant_id, "tenant-a");
    const query = db.calls.find(call => call.sql.includes("FROM tenant_membership_events"));
    assert.deepEqual(query.args, ["tenant-a"]);
    assert.match(query.sql, /ORDER BY created_at DESC, id DESC LIMIT 100/);
  }
});

test("non-admin tenant members cannot read membership audit history", async () => {
  const db = new MembershipEventsDB("operator", []);
  const response = await worker.fetch(await request({}, 
    "https://private.internal/internal/v1/tenants/tenant-a/membership-events"), env(db));
  assert.equal(response.status, 404);
  assert.equal(db.calls.some(call => call.sql.includes("FROM tenant_membership_events")), false);
});


class MembershipInvitationDB {
  constructor({ role = "tenant_owner", invitationRows = [], existingMemberships = [],
    batchResult = [] } = {}) {
    this.role = role;
    this.invitationRows = invitationRows;
    this.existingMemberships = existingMemberships;
    this.batchResult = batchResult;
    this.batchCalls = [];
    this.calls = [];
    this.nonces = new Set();
  }
  prepare(sql) {
    const db = this;
    return { bind(...args) { return { sql, args,
      async run() {
        if (sql.includes("INSERT INTO internal_request_nonces")) {
          if (db.nonces.has(args[0])) return { meta: { changes: 0 } };
          db.nonces.add(args[0]);
          return { meta: { changes: 1 } };
        }
        throw new Error("unexpected invitation write");
      },
      async all() {
        db.calls.push({ sql, args });
        if (sql.includes("SELECT status FROM tenants")) return { results: [{ status: "active" }] };
        if (sql.includes("FROM tenant_membership_invitations")) return { results: db.invitationRows };
        if (sql.includes("FROM tenant_memberships")) return { results: sql.includes("SELECT id, status")
          ? db.existingMemberships : [{ subject: "operator@example.test", tenant_id: args[1],
            role: db.role, status: "active" }] };
        throw new Error("unexpected invitation read SQL");
      },
    }; } };
  }
  async batch(statements) {
    this.batchCalls.push(statements);
    return this.batchResult;
  }
}

test("tenant owner creates a one-time invitation without selecting the invitee identity", async () => {
  const db = new MembershipInvitationDB({ batchResult: [
    { meta: { changes: 1 } }, { meta: { changes: 1 } },
  ] });
  const response = await worker.fetch(await request({}, 
    "https://private.internal/internal/v1/tenants/tenant-a/membership-invitations",
    "POST", JSON.stringify({ role: "operator", reason: "Field operations access" })), env(db));
  assert.equal(response.status, 201);
  const result = (await response.json()).data;
  assert.equal(result.role, "operator");
  assert.equal(result.status, "pending");
  assert.match(result.invitation_token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(result.delivery.includes("out-of-band"), true);
  assert.match(db.batchCalls[0][0].sql, /INSERT INTO tenant_membership_invitations/);
  assert.match(db.batchCalls[0][1].sql, /INSERT INTO tenant_membership_invitation_events/);
});

test("only an active tenant owner can create or revoke membership invitations", async () => {
  const db = new MembershipInvitationDB({ role: "tenant_admin" });
  const response = await worker.fetch(await request({}, 
    "https://private.internal/internal/v1/tenants/tenant-a/membership-invitations",
    "POST", JSON.stringify({ role: "viewer", reason: "Read access" })), env(db));
  assert.equal(response.status, 404);
  assert.equal(db.batchCalls.length, 0);
});

test("authenticated Access subject accepts a one-time invitation into a tenant membership", async () => {
  const db = new MembershipInvitationDB({
    invitationRows: [{ id: "invite-1", tenant_id: "tenant-a", role: "analyst",
      status: "pending", reason: "Research access",
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() }],
    batchResult: Array.from({ length: 5 }, () => ({ meta: { changes: 1 } })),
  });
  const response = await worker.fetch(await request({}, 
    "https://private.internal/internal/v1/tenants/tenant-a/membership-invitations/invite-1/accept",
    "POST", JSON.stringify({ invitation_token: "A".repeat(43) })), env(db));
  assert.equal(response.status, 201);
  const result = (await response.json()).data;
  assert.equal(result.subject, "operator@example.test");
  assert.equal(result.role, "analyst");
  assert.equal(result.status, "active");
  assert.equal(db.batchCalls[0].length, 5);
  assert.match(db.batchCalls[0][1].sql, /INSERT INTO tenant_memberships/);
  assert.match(db.batchCalls[0][3].sql, /INSERT INTO tenant_membership_events/);
  assert.match(db.batchCalls[0][4].sql, /INSERT INTO tenant_membership_invitation_events/);
});

test("membership invitation acceptance rejects an existing membership", async () => {
  const db = new MembershipInvitationDB({
    invitationRows: [{ id: "invite-1", tenant_id: "tenant-a", role: "viewer",
      status: "pending", reason: "Read access",
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() }],
    existingMemberships: [{ id: "membership-existing", status: "active" }],
  });
  const response = await worker.fetch(await request({}, 
    "https://private.internal/internal/v1/tenants/tenant-a/membership-invitations/invite-1/accept",
    "POST", JSON.stringify({ invitation_token: "A".repeat(43) })), env(db));
  assert.equal(response.status, 409);
  assert.equal(db.batchCalls.length, 0);
});

test("tenant owner revokes a pending invitation with an append-only event", async () => {
  const db = new MembershipInvitationDB({ batchResult: [
    { meta: { changes: 1 } }, { meta: { changes: 1 } },
  ] });
  const response = await worker.fetch(await request({}, 
    "https://private.internal/internal/v1/tenants/tenant-a/membership-invitations/invite-1/revoke",
    "POST", JSON.stringify({ reason: "Access no longer required" })), env(db));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.status, "revoked");
  assert.match(db.batchCalls[0][0].sql, /UPDATE tenant_membership_invitations/);
  assert.match(db.batchCalls[0][1].sql, /INSERT INTO tenant_membership_invitation_events/);
});


class MembershipChangeDB {
  constructor({ actorRole = "tenant_owner", target = { id: "member-1", tenant_id: "tenant-a",
    subject: "member@example.test", role: "operator", status: "active" },
    batchResult = [{ meta: { changes: 1 } }, { meta: { changes: 1 } }] } = {}) {
    this.actorRole = actorRole; this.target = target; this.batchResult = batchResult;
    this.batchCalls = []; this.calls = []; this.nonces = new Set();
  }
  prepare(sql) {
    const db = this;
    return { bind(...args) { return { sql, args,
      async run() {
        if (sql.includes("INSERT INTO internal_request_nonces")) {
          if (db.nonces.has(args[0])) return { meta: { changes: 0 } };
          db.nonces.add(args[0]); return { meta: { changes: 1 } };
        }
        throw new Error("unexpected membership change write");
      },
      async all() {
        db.calls.push({ sql, args });
        if (sql.includes("FROM tenant_memberships") && sql.includes("WHERE subject = ?")) {
          return { results: [{ subject: "operator@example.test", tenant_id: "tenant-a",
            role: db.actorRole, status: "active" }] };
        }
        if (sql.includes("FROM tenant_memberships") && sql.includes("WHERE id = ?")) {
          return { results: db.target ? [db.target] : [] };
        }
        throw new Error("unexpected membership change read SQL");
      },
    }; } };
  }
  async batch(statements) { this.batchCalls.push(statements); return this.batchResult; }
}

test("tenant owner changes a member role with a matching append-only event in one batch", async () => {
  const db = new MembershipChangeDB();
  const response = await worker.fetch(await request({ "x-nova-request-id": "membership-change-001" },
    "https://private.internal/internal/v1/tenants/tenant-a/membership-actions", "POST",
    JSON.stringify({ membership_id: "member-1", action: "change_role", role: "analyst",
      reason: "Role adjusted to current responsibilities" })), env(db));
  assert.equal(response.status, 200);
  const result = (await response.json()).data;
  assert.equal(result.role, "analyst");
  assert.equal(result.status, "active");
  assert.equal(result.event_type, "role_changed");
  assert.equal(db.batchCalls.length, 1);
  assert.match(db.batchCalls[0][0].sql, /INSERT INTO tenant_membership_events/);
  assert.match(db.batchCalls[0][1].sql, /UPDATE tenant_memberships SET role = \?, status = \?/);
  assert.deepEqual(db.batchCalls[0][0].args.slice(5, 10),
    ["role_changed", "operator", "analyst", "active", "active"]);
});

test("tenant admin may suspend a lower-privilege member but cannot change roles", async () => {
  const allowed = new MembershipChangeDB({ actorRole: "tenant_admin" });
  const suspended = await worker.fetch(await request({ "x-nova-request-id": "membership-suspend-001" },
    "https://private.internal/internal/v1/tenants/tenant-a/membership-actions", "POST",
    JSON.stringify({ membership_id: "member-1", action: "suspend",
      reason: "Temporary access pause" })), env(allowed));
  assert.equal(suspended.status, 200);
  assert.equal((await suspended.json()).data.status, "inactive");
  const denied = new MembershipChangeDB({ actorRole: "tenant_admin" });
  const changed = await worker.fetch(await request({ "x-nova-request-id": "membership-role-denied-001" },
    "https://private.internal/internal/v1/tenants/tenant-a/membership-actions", "POST",
    JSON.stringify({ membership_id: "member-1", action: "change_role", role: "analyst",
      reason: "Attempted escalation" })), env(denied));
  assert.equal(changed.status, 404);
  assert.equal(denied.batchCalls.length, 0);
});

test("membership lifecycle rejects self-targeting and never accepts owner promotion", async () => {
  const self = new MembershipChangeDB({ target: { id: "member-1", tenant_id: "tenant-a",
    subject: "operator@example.test", role: "tenant_owner", status: "active" } });
  const selfResponse = await worker.fetch(await request({ "x-nova-request-id": "membership-self-001" },
    "https://private.internal/internal/v1/tenants/tenant-a/membership-actions", "POST",
    JSON.stringify({ membership_id: "member-1", action: "revoke",
      reason: "Self revoke" })), env(self));
  assert.equal(selfResponse.status, 404);
  assert.equal(self.batchCalls.length, 0);
  const ownerPromotion = new MembershipChangeDB();
  const promotion = await worker.fetch(await request({ "x-nova-request-id": "membership-owner-promotion-001" },
    "https://private.internal/internal/v1/tenants/tenant-a/membership-actions", "POST",
    JSON.stringify({ membership_id: "member-1", action: "change_role", role: "tenant_owner",
      reason: "Owner promotion attempt" })), env(ownerPromotion));
  assert.equal(promotion.status, 400);
  assert.equal(ownerPromotion.batchCalls.length, 0);
});

test("membership lifecycle returns conflict when atomic audit and state writes do not both succeed", async () => {
  const db = new MembershipChangeDB({ batchResult: [
    { meta: { changes: 1 } }, { meta: { changes: 0 } },
  ] });
  const response = await worker.fetch(await request({ "x-nova-request-id": "membership-conflict-001" },
    "https://private.internal/internal/v1/tenants/tenant-a/membership-actions", "POST",
    JSON.stringify({ membership_id: "member-1", action: "revoke",
      reason: "Access withdrawn" })), env(db));
  assert.equal(response.status, 409);
});


class SiteGrantChangeDB {
  constructor({ actorRole = "tenant_owner", targetStatus = "active", existing = [],
    batchResult = [{ meta: { changes: 1 } }, { meta: { changes: 1 } }] } = {}) {
    this.actorRole = actorRole; this.targetStatus = targetStatus; this.existing = existing;
    this.batchResult = batchResult; this.batchCalls = []; this.calls = []; this.nonces = new Set();
  }
  prepare(sql) {
    const db = this;
    return { bind(...args) { return { sql, args,
      async run() {
        if (sql.includes("INSERT INTO internal_request_nonces")) {
          if (db.nonces.has(args[0])) return { meta: { changes: 0 } };
          db.nonces.add(args[0]); return { meta: { changes: 1 } };
        }
        throw new Error("unexpected site grant write");
      },
      async all() {
        db.calls.push({ sql, args });
        if (sql.includes("JOIN tenants")) return { results: [{
          subject: "operator@example.test", tenant_id: "tenant-a", role: db.actorRole,
          status: "active", tenant_status: "active",
        }] };
        if (sql.includes("FROM sites")) return { results: [{ id: "site-a", tenant_id: "tenant-a", status: "active" }] };
        if (sql.includes("FROM tenant_memberships")) return { results: [{
          id: "member-1", subject: "member@example.test", status: db.targetStatus,
        }] };
        if (sql.includes("FROM tenant_resource_grants")) return { results: db.existing };
        throw new Error("unexpected site grant read SQL");
      },
    }; } };
  }
  async batch(statements) { this.batchCalls.push(statements); return this.batchResult; }
}

test("tenant owner grants exact site access and appends a matching event atomically", async () => {
  const db = new SiteGrantChangeDB();
  const response = await worker.fetch(await request({ "x-nova-request-id": "site-grant-001" },
    "https://private.internal/internal/v1/tenants/tenant-a/site-grants", "POST",
    JSON.stringify({ action: "grant", subject: "member@example.test", site_id: "site-a",
      grant_action: "read", reason: "Approved site access" })), env(db));
  assert.equal(response.status, 201);
  const result = (await response.json()).data;
  assert.equal(result.status, "active");
  assert.equal(result.resource_type, "site");
  assert.equal(result.site_id, "site-a");
  assert.match(result.grant_id, /^[0-9a-f-]{36}$/);
  assert.match(db.batchCalls[0][0].sql, /INSERT INTO tenant_resource_grants/);
  assert.match(db.batchCalls[0][1].sql, /INSERT INTO tenant_site_grant_events/);
});

test("tenant admin cannot grant delete or manage-members privileges", async () => {
  for (const [grant_action, expectedStatus] of [["delete", 404], ["manage_members", 400]]) {
    const db = new SiteGrantChangeDB({ actorRole: "tenant_admin" });
    const response = await worker.fetch(await request({ "x-nova-request-id": "site-grant-denied-" + grant_action },
      "https://private.internal/internal/v1/tenants/tenant-a/site-grants", "POST",
      JSON.stringify({ action: "grant", subject: "member@example.test", site_id: "site-a",
        grant_action, reason: "Must be owner controlled" })), env(db));
    assert.equal(response.status, expectedStatus);
    assert.equal(db.batchCalls.length, 0);
  }
});

test("site grant changes fail closed for inactive target memberships and duplicate grants", async () => {
  const inactive = new SiteGrantChangeDB({ targetStatus: "inactive" });
  const inactiveResponse = await worker.fetch(await request({ "x-nova-request-id": "site-grant-inactive-001" },
    "https://private.internal/internal/v1/tenants/tenant-a/site-grants", "POST",
    JSON.stringify({ action: "grant", subject: "member@example.test", site_id: "site-a",
      grant_action: "read", reason: "Inactive membership must not receive access" })), env(inactive));
  assert.equal(inactiveResponse.status, 404);
  const duplicate = new SiteGrantChangeDB({ existing: [{ id: "grant-existing" }] });
  const duplicateResponse = await worker.fetch(await request({ "x-nova-request-id": "site-grant-duplicate-001" },
    "https://private.internal/internal/v1/tenants/tenant-a/site-grants", "POST",
    JSON.stringify({ action: "grant", subject: "member@example.test", site_id: "site-a",
      grant_action: "read", reason: "Duplicate grant attempt" })), env(duplicate));
  assert.equal(duplicateResponse.status, 409);
  assert.equal(duplicate.batchCalls.length, 0);

  const cleanup = new SiteGrantChangeDB({ targetStatus: "inactive", existing: [{ id: "grant-stale" }] });
  const cleanupResponse = await worker.fetch(await request({ "x-nova-request-id": "site-grant-cleanup-001" },
    "https://private.internal/internal/v1/tenants/tenant-a/site-grants", "POST",
    JSON.stringify({ action: "revoke", subject: "member@example.test", site_id: "site-a",
      grant_action: "read", reason: "Remove stale access after suspension" })), env(cleanup));
  assert.equal(cleanupResponse.status, 200);
  assert.equal((await cleanupResponse.json()).data.grant_id, "grant-stale");
  assert.match(cleanup.batchCalls[0][0].sql, /DELETE FROM tenant_resource_grants/);
  assert.match(cleanup.batchCalls[0][0].sql, /actor_m\.status = 'active'/);
  assert.match(cleanup.batchCalls[0][0].sql, /tenant_memberships WHERE id = \? AND tenant_id = \? AND subject = \?/);
  assert.doesNotMatch(cleanup.batchCalls[0][0].sql, /tenant_memberships WHERE id = \? AND tenant_id = \? AND subject = \? AND status = 'active'/);
});

test("tenant owner revokes an exact site grant and appends a matching event", async () => {
  const db = new SiteGrantChangeDB({ existing: [{ id: "grant-existing" }] });
  const response = await worker.fetch(await request({ "x-nova-request-id": "site-grant-revoke-001" },
    "https://private.internal/internal/v1/tenants/tenant-a/site-grants", "POST",
    JSON.stringify({ action: "revoke", subject: "member@example.test", site_id: "site-a",
      grant_action: "read", reason: "Site access withdrawn" })), env(db));
  assert.equal(response.status, 200);
  const result = (await response.json()).data;
  assert.equal(result.grant_id, "grant-existing");
  assert.equal(result.status, "revoked");
  assert.match(db.batchCalls[0][0].sql, /DELETE FROM tenant_resource_grants/);
  assert.match(db.batchCalls[0][1].sql, /INSERT INTO tenant_site_grant_events/);
});


test("site grant API rejects unsupported tenant-level manage-members permission", async () => {
  const db = new SiteGrantChangeDB();
  const response = await worker.fetch(await request({ "x-nova-request-id": "site-grant-unsupported-001" },
    "https://private.internal/internal/v1/tenants/tenant-a/site-grants", "POST",
    JSON.stringify({ action: "grant", subject: "member@example.test", site_id: "site-a",
      grant_action: "manage_members", reason: "Not a site-level permission" })), env(db));
  assert.equal(response.status, 400);
  assert.equal(db.batchCalls.length, 0);
});


class TenantLifecycleDB {
  constructor({ role = "tenant_owner", membershipStatus = "active", status = "active",
    batchResult = null, events = [] } = {}) {
    this.role = role; this.membershipStatus = membershipStatus; this.status = status;
    this.batchResult = batchResult; this.events = events; this.batchCalls = []; this.calls = [];
    this.nonces = new Set();
  }
  prepare(sql) {
    const db = this;
    return { bind(...args) { return { sql, args,
      async all() {
        db.calls.push({ sql, args });
        if (sql.includes("SELECT status, last_lifecycle_event_id FROM tenants")) return { results: [{
          status: db.status, last_lifecycle_event_id: db.lastLifecycleEventId ?? null,
        }] };
        if (sql.includes("FROM tenants t JOIN tenant_memberships")) return { results: [{
          id: args[0], status: db.status, role: db.role, membership_status: db.membershipStatus,
        }] };
        if (sql.includes("FROM tenant_lifecycle_events")) return { results: db.events };
        if (sql.includes("FROM tenant_memberships m WHERE")) return { results: [{
          subject: "operator@example.test", tenant_id: "tenant-a", role: db.role,
          membership_status: db.membershipStatus,
        }] };
        throw new Error("unexpected tenant lifecycle query");
      },
      async run() {
        if (sql.includes("INSERT INTO internal_request_nonces")) {
          if (db.nonces.has(args[0])) return { meta: { changes: 0 } };
          db.nonces.add(args[0]); return { meta: { changes: 1 } };
        }
        throw new Error("unexpected tenant lifecycle write");
      },
    }; } };
  }
  async batch(statements) {
    this.batchCalls.push(statements);
    if (this.batchResult) return this.batchResult;
    this.status = statements[1].args[0];
    this.lastLifecycleEventId = statements[1].args[1];
    return [{ meta: { changes: 1 } }, { meta: { changes: 1 } }];
  }
}

test("tenant owner suspends a tenant with an atomic immutable lifecycle event", async () => {
  const db = new TenantLifecycleDB();
  const response = await worker.fetch(await request({ "x-nova-request-id": "tenant-suspend-001" },
    "https://private.internal/internal/v1/tenants/tenant-a/lifecycle-actions", "POST",
    JSON.stringify({ action: "suspend", reason: "Security review" })), env(db));
  assert.equal(response.status, 200);
  const data = (await response.json()).data;
  assert.equal(data.previous_status, "active");
  assert.equal(data.status, "suspended");
  assert.equal(data.event_type, "suspended");
  assert.equal(db.batchCalls[0].length, 2);
  assert.match(db.batchCalls[0][0].sql, /INSERT INTO tenant_lifecycle_events/);
  assert.match(db.batchCalls[0][1].sql, /UPDATE tenants SET status = \?/);
  assert.match(db.batchCalls[0][1].sql, /last_lifecycle_event_id = \?/);
  assert.equal(db.batchCalls[0][0].args[7], "tenant-suspend-001");
});

test("suspended tenant can be reactivated and active or suspended tenant can be archived", async () => {
  for (const [action, status, expected] of [
    ["reactivate", "suspended", "active"],
    ["archive", "active", "archived"],
    ["archive", "suspended", "archived"],
  ]) {
    const db = new TenantLifecycleDB({ status });
    const response = await worker.fetch(await request({ "x-nova-request-id": "tenant-" + action + "-" + status },
      "https://private.internal/internal/v1/tenants/tenant-a/lifecycle-actions", "POST",
      JSON.stringify({ action, reason: "Approved lifecycle change" })), env(db));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.status, expected);
  }
});

test("only active tenant owners can change lifecycle; archived tenants are terminal", async () => {
  for (const config of [
    { role: "tenant_admin", status: "active" },
    { role: "tenant_owner", membershipStatus: "inactive", status: "active" },
    { role: "tenant_owner", status: "archived" },
  ]) {
    const db = new TenantLifecycleDB(config);
    const response = await worker.fetch(await request({ "x-nova-request-id": "tenant-lifecycle-denied-" + config.status },
      "https://private.internal/internal/v1/tenants/tenant-a/lifecycle-actions", "POST",
      JSON.stringify({ action: "reactivate", reason: "Denied transition" })), env(db));
    assert.ok([404, 409].includes(response.status));
    assert.equal(db.batchCalls.length, 0);
  }
});

test("tenant lifecycle rejects caller-supplied actor and invalid actions", async () => {
  const invalidBodies = [
    { action: "suspend", reason: "reason", actor_subject: "forged" },
    { action: "delete", reason: "reason" },
    { action: "suspend", reason: " " },
  ];
  for (const [index, body] of invalidBodies.entries()) {
    const db = new TenantLifecycleDB();
    const response = await worker.fetch(await request({ "x-nova-request-id": "tenant-lifecycle-invalid-" + index },
      "https://private.internal/internal/v1/tenants/tenant-a/lifecycle-actions", "POST",
      JSON.stringify(body)), env(db));
    assert.equal(response.status, 400);
    assert.equal(db.batchCalls.length, 0);
  }
});

test("tenant lifecycle audit history is available to active tenant administrators", async () => {
  const db = new TenantLifecycleDB({ role: "tenant_admin", status: "archived",
    events: [{ id: "event-1", tenant_id: "tenant-a", event_type: "archived" }] });
  const response = await worker.fetch(await request({ "x-nova-request-id": "tenant-lifecycle-events-001" },
    "https://private.internal/internal/v1/tenants/tenant-a/lifecycle-events", "GET"), env(db));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data[0].event_type, "archived");
});

class OwnershipTransferDB {
  constructor({ actorRole = "tenant_owner", targetStatus = "active", targetRole = "operator",
    batchResult = null } = {}) {
    this.actorRole = actorRole; this.targetStatus = targetStatus; this.targetRole = targetRole;
    this.batchResult = batchResult; this.calls = []; this.batchCalls = []; this.nonces = new Set();
  }
  prepare(sql) {
    const db = this;
    return { bind(...args) { return { sql, args,
      async all() {
        db.calls.push({ sql, args });
        if (sql.includes("FROM tenant_memberships m JOIN tenants t")) return { results: [{
          id: "owner-membership", subject: "operator@example.test", tenant_id: "tenant-a",
          role: db.actorRole, status: "active", tenant_status: "active",
        }] };
        if (sql.includes("FROM tenant_memberships WHERE id = ? AND tenant_id = ?")) return { results: [{
          id: args[0], tenant_id: args[1], subject: "target@example.test",
          role: db.targetRole, status: db.targetStatus,
        }] };
        throw new Error("unexpected ownership transfer SQL");
      },
      async run() {
        if (sql.includes("INSERT INTO internal_request_nonces")) {
          if (db.nonces.has(args[0])) return { meta: { changes: 0 } };
          db.nonces.add(args[0]); return { meta: { changes: 1 } };
        }
        throw new Error("unexpected ownership transfer write");
      },
    }; } };
  }
  async batch(statements) {
    this.batchCalls.push(statements);
    return this.batchResult ?? Array.from({ length: 4 }, () => ({ meta: { changes: 1 } }));
  }
}

test("tenant owner transfers ownership atomically and audits both role changes", async () => {
  const db = new OwnershipTransferDB();
  const response = await worker.fetch(await request({ "x-nova-request-id": "owner-transfer-001" },
    "https://private.internal/internal/v1/tenants/tenant-a/ownership-transfer", "POST",
    JSON.stringify({ target_membership_id: "membership-target", reason: "Designated successor" })), env(db));
  assert.equal(response.status, 200);
  const data = (await response.json()).data;
  assert.equal(data.new_owner_subject, "target@example.test");
  assert.equal(data.previous_owner_role, "tenant_admin");
  assert.equal(db.batchCalls[0].length, 4);
  assert.match(db.batchCalls[0][0].sql, /INSERT INTO tenant_membership_events/);
  assert.match(db.batchCalls[0][1].sql, /SET role = 'tenant_owner'/);
  assert.match(db.batchCalls[0][0].sql, /role = 'tenant_owner' AND status = 'active'/);
  assert.match(db.batchCalls[0][1].sql, /role = 'tenant_owner' AND status = 'active'/);
  assert.match(db.batchCalls[0][2].sql, /new_role, previous_status/);
  assert.match(db.batchCalls[0][3].sql, /SET role = 'tenant_admin'/);
  assert.equal(db.batchCalls[0][2].args[6], "owner-transfer-001:actor");
  assert.deepEqual(db.batchCalls[0][2].args.slice(7, 10),
    ["owner-membership", "tenant-a", "operator@example.test"]);
});

test("only active owners can transfer ownership to another active non-owner", async () => {
  const admin = new OwnershipTransferDB({ actorRole: "tenant_admin" });
  const denied = await worker.fetch(await request({ "x-nova-request-id": "owner-transfer-admin" },
    "https://private.internal/internal/v1/tenants/tenant-a/ownership-transfer", "POST",
    JSON.stringify({ target_membership_id: "membership-target", reason: "Should be denied" })), env(admin));
  assert.equal(denied.status, 404);
  assert.equal(admin.batchCalls.length, 0);

  const forgedActor = new OwnershipTransferDB();
  const forged = await worker.fetch(await request({ "x-nova-request-id": "owner-transfer-forged-actor" },
    "https://private.internal/internal/v1/tenants/tenant-a/ownership-transfer", "POST",
    JSON.stringify({ target_membership_id: "membership-target", actor_membership_id: "forged",
      reason: "Caller cannot choose actor membership" })), env(forgedActor));
  assert.equal(forged.status, 400);
  assert.equal(forgedActor.batchCalls.length, 0);

  const inactiveTarget = new OwnershipTransferDB({ targetStatus: "inactive" });
  const inactive = await worker.fetch(await request({ "x-nova-request-id": "owner-transfer-inactive" },
    "https://private.internal/internal/v1/tenants/tenant-a/ownership-transfer", "POST",
    JSON.stringify({ target_membership_id: "membership-target", reason: "Inactive target" })), env(inactiveTarget));
  assert.equal(inactive.status, 404);
  assert.equal(inactiveTarget.batchCalls.length, 0);
});

class ResourceGrantDB {
  constructor({ actorRole = "tenant_owner", targetStatus = "active", resourceRows = null,
    existing = [], batchResult = null } = {}) {
    this.actorRole = actorRole; this.targetStatus = targetStatus; this.resourceRows = resourceRows;
    this.existing = existing; this.batchCalls = []; this.calls = []; this.nonces = new Set();
    this.batchResult = batchResult;
  }
  prepare(sql) {
    const db = this;
    return { bind(...args) { return { sql, args,
      async all() {
        db.calls.push({ sql, args });
        if (sql.includes("FROM tenant_memberships m JOIN tenants t")) return { results: [{
          subject: "operator@example.test", tenant_id: "tenant-a", role: db.actorRole,
          status: "active", tenant_status: "active",
        }] };
        if (sql.includes("SELECT id FROM tenants WHERE id = ?")) return { results: [{ id: "tenant-a" }] };
        if (sql.includes("FROM assets a JOIN sites s")) return { results: db.resourceRows ?? [{
          id: args[1], tenant_id: args[0], site_id: "site-a",
        }] };
        if (sql.includes("FROM sources src LEFT JOIN sites")) return { results: db.resourceRows ?? [{
          id: args[1], tenant_id: args[0], site_id: "site-a",
        }] };
        if (sql.includes("FROM observations o JOIN sites")) return { results: db.resourceRows ?? [{
          id: args[1], tenant_id: args[0], site_id: "site-a", source_id: "source-a", asset_id: null,
        }] };
        if (sql.includes("FROM tenant_memberships WHERE tenant_id = ? AND subject = ?")) return { results: [{
          id: "target-membership", subject: args[1], status: db.targetStatus,
        }] };
        if (sql.includes("FROM tenant_resource_grants WHERE tenant_id = ? AND subject = ? AND resource_type = ?")) return { results: db.existing };
        throw new Error("unexpected resource grant SQL: " + sql);
      },
      async run() {
        db.calls.push({ sql, args });
        if (sql.includes("INSERT INTO internal_request_nonces")) {
          if (db.nonces.has(args[0])) return { meta: { changes: 0 } };
          db.nonces.add(args[0]); return { meta: { changes: 1 } };
        }
        throw new Error("unexpected resource grant write SQL");
      },
    }; } };
  }
  async batch(statements) {
    this.batchCalls.push(statements);
    return this.batchResult ?? [{ meta: { changes: 1 } }, { meta: { changes: 1 } }];
  }
}

test("tenant owner grants exact asset access with matching append-only audit event", async () => {
  const db = new ResourceGrantDB();
  const response = await worker.fetch(await request({ "x-nova-request-id": "resource-grant-001" },
    "https://private.internal/internal/v1/tenants/tenant-a/resource-grants", "POST",
    JSON.stringify({ action: "grant", subject: "member@example.test", resource_type: "asset",
      resource_id: "asset-a", grant_action: "read", reason: "Approved asset access" })), env(db));
  assert.equal(response.status, 201);
  const result = (await response.json()).data;
  assert.equal(result.resource_type, "asset");
  assert.equal(result.resource_id, "asset-a");
  assert.equal(result.status, "active");
  assert.match(db.batchCalls[0][0].sql, /INSERT INTO tenant_resource_grants/);
  assert.match(db.batchCalls[0][1].sql, /INSERT INTO tenant_resource_grant_events/);
  assert.match(db.batchCalls[0][0].sql, /s\.tenant_id = a\.tenant_id/);
});

test("resource grants reject inactive targets, mismatched resources and admin delete", async () => {
  const body = action => JSON.stringify({ action: "grant", subject: "member@example.test",
    resource_type: "asset", resource_id: "asset-a", grant_action: action,
    reason: "Controlled access" });
  const inactive = new ResourceGrantDB({ targetStatus: "inactive" });
  assert.equal((await worker.fetch(await request({ "x-nova-request-id": "resource-inactive" },
    "https://private.internal/internal/v1/tenants/tenant-a/resource-grants", "POST", body("read")), env(inactive))).status, 404);
  assert.equal(inactive.batchCalls.length, 0);

  const mismatched = new ResourceGrantDB({ resourceRows: [{ id: "asset-a", tenant_id: "tenant-b", site_id: "site-b" }] });
  assert.equal((await worker.fetch(await request({ "x-nova-request-id": "resource-cross-tenant" },
    "https://private.internal/internal/v1/tenants/tenant-a/resource-grants", "POST", body("read")), env(mismatched))).status, 404);
  assert.equal(mismatched.batchCalls.length, 0);

  const admin = new ResourceGrantDB({ actorRole: "tenant_admin" });
  assert.equal((await worker.fetch(await request({ "x-nova-request-id": "resource-admin-delete" },
    "https://private.internal/internal/v1/tenants/tenant-a/resource-grants", "POST", body("delete")), env(admin))).status, 404);
  assert.equal(admin.batchCalls.length, 0);
});

test("resource grants reject parent mismatches, duplicate tuples and malformed scope", async () => {
  const payload = patch => JSON.stringify({ action: "grant", subject: "member@example.test",
    resource_type: "observation", resource_id: "obs-a", grant_action: "read",
    reason: "Exact resource access", ...patch });
  const parentMismatch = new ResourceGrantDB({ resourceRows: [] });
  assert.equal((await worker.fetch(await request({ "x-nova-request-id": "resource-parent-mismatch" },
    "https://private.internal/internal/v1/tenants/tenant-a/resource-grants", "POST", payload({})), env(parentMismatch))).status, 404);
  assert.equal(parentMismatch.batchCalls.length, 0);

  const duplicate = new ResourceGrantDB({ existing: [{ id: "grant-already-there" }] });
  assert.equal((await worker.fetch(await request({ "x-nova-request-id": "resource-duplicate" },
    "https://private.internal/internal/v1/tenants/tenant-a/resource-grants", "POST", payload({})), env(duplicate))).status, 409);
  assert.equal(duplicate.batchCalls.length, 0);

  for (const patch of [
    { resource_type: "tenant" },
    { grant_action: "manage_members" },
    { resource_id: "../asset" },
    { caller_role: "tenant_owner" },
  ]) {
    const db = new ResourceGrantDB();
    const response = await worker.fetch(await request({ "x-nova-request-id": "resource-invalid-" + Object.keys(patch)[0] },
      "https://private.internal/internal/v1/tenants/tenant-a/resource-grants", "POST", payload(patch)), env(db));
    assert.equal(response.status, 400);
    assert.equal(db.batchCalls.length, 0);
  }
});

test("resource grant resolvers enforce each resource's tenant and parent relationships", async () => {
  const cases = [
    ["asset", "asset-a", /s\.tenant_id = a\.tenant_id.*s\.status = 'active'/],
    ["source", "source-a", /src\.tenant_id = \? AND src\.id = \?.*src\.verification_status = 'verified'.*src\.site_id IS NULL OR s\.id IS NOT NULL/],
    ["observation", "obs-a", /src\.tenant_id = o\.tenant_id.*src\.site_id IS NULL OR src\.site_id = o\.site_id.*a\.tenant_id = o\.tenant_id.*a\.site_id = o\.site_id/],
  ];
  for (const [resource_type, resource_id, expected] of cases) {
    const db = new ResourceGrantDB({ resourceRows: [] });
    const response = await worker.fetch(await request({ "x-nova-request-id": "resource-parent-" + resource_type },
      "https://private.internal/internal/v1/tenants/tenant-a/resource-grants", "POST",
      JSON.stringify({ action: "grant", subject: "member@example.test", resource_type,
        resource_id, grant_action: "read", reason: "Parent scope validation" })), env(db));
    assert.equal(response.status, 404, resource_type);
    const lookup = db.calls.find(call => call.sql.includes(
      resource_type === "asset" ? "FROM assets a" :
      resource_type === "source" ? "FROM sources src" : "FROM observations o"));
    assert.ok(lookup, resource_type + " resolver query exists");
    assert.match(lookup.sql, expected, resource_type);
    assert.equal(db.batchCalls.length, 0);
  }
});

test("concurrent exact grant conflict cannot append a duplicate audit event", async () => {
  const db = new ResourceGrantDB({ batchResult: [{ meta: { changes: 0 } }, { meta: { changes: 0 } }] });
  const response = await worker.fetch(await request({ "x-nova-request-id": "resource-concurrent-duplicate" },
    "https://private.internal/internal/v1/tenants/tenant-a/resource-grants", "POST",
    JSON.stringify({ action: "grant", subject: "member@example.test", resource_type: "asset",
      resource_id: "asset-a", grant_action: "read", reason: "Concurrent exact grant" })), env(db));
  assert.equal(response.status, 409);
  assert.match(db.batchCalls[0][0].sql, /ON CONFLICT\(tenant_id, subject, resource_type, resource_id, action\) DO NOTHING/);
  assert.match(db.batchCalls[0][1].sql, /WHERE changes\(\) = 1/);
});

test("resource grant audit failure is not reported as a successful transition", async () => {
  const db = new ResourceGrantDB({ batchResult: [{ meta: { changes: 1 } }, { meta: { changes: 0 } }] });
  const response = await worker.fetch(await request({ "x-nova-request-id": "resource-audit-failure" },
    "https://private.internal/internal/v1/tenants/tenant-a/resource-grants", "POST",
    JSON.stringify({ action: "grant", subject: "member@example.test", resource_type: "asset",
      resource_id: "asset-a", grant_action: "read", reason: "Audit must be paired" })), env(db));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "resource_grant_transition_conflict");
});

test("resource grant revocation allows explicit cleanup for an inactive member", async () => {
  const db = new ResourceGrantDB({ targetStatus: "inactive",
    existing: [{ id: "grant-existing" }] });
  const response = await worker.fetch(await request({ "x-nova-request-id": "resource-revoke-001" },
    "https://private.internal/internal/v1/tenants/tenant-a/resource-grants", "POST",
    JSON.stringify({ action: "revoke", subject: "member@example.test", resource_type: "asset",
      resource_id: "asset-a", grant_action: "read", reason: "Remove stale access" })), env(db));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.status, "revoked");
  assert.match(db.batchCalls[0][0].sql, /DELETE FROM tenant_resource_grants/);
  assert.match(db.batchCalls[0][1].sql, /tenant_resource_grant_events/);
});


test("identity-link challenge endpoints require a dual-authenticated request", async () => {
  const routes = [
    ["POST", "https://private.internal/internal/v1/identity-links/challenges", JSON.stringify({})],
    ["POST", "https://private.internal/internal/v1/identity-links/challenges/challenge-1/consume", JSON.stringify({ challenge: "a".repeat(43) })],
  ];
  for (const [method, url, body] of routes) {
    const db = new DB();
    const response = await worker.fetch(await request({}, url, method, body), env(db));
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, "supabase_identity_required");
    assert.equal(db.calls.length, 0, "challenge endpoints must reject Access-only callers before storage access");
  }
});


test("rejects a body changed after the gateway signed its digest before storage access", async () => {
  const db = new DB();
  const signed = await request({}, "https://private.internal/internal/v1/tenants/tenant-a/observations/observation-a/measurement-quality-assessment", "POST", JSON.stringify({ action: "original" }));
  const tampered = new Request(signed.url, {
    method: "POST",
    headers: signed.headers,
    body: JSON.stringify({ action: "tampered" }),
  });
  const response = await worker.fetch(tampered, env(db));
  assert.equal(response.status, 401);
  assert.equal(db.calls.length, 0);
});

test("rejects Supabase token substitution before any tenant database access", async () => {
  const db = new DB();
  const response = await worker.fetch(await request({
    "x-nova-supabase-access-token": "not-a-jwt",
    "x-nova-supabase-token-sha256": "0".repeat(64),
  }), env(db));
  assert.equal(response.status, 401);
  assert.equal(db.calls.length, 0);
});

test("rejects a Supabase token without its signed digest", async () => {
  const db = new DB();
  const response = await worker.fetch(await request({
    "x-nova-supabase-access-token": "not-a-jwt",
    "x-nova-supabase-token-sha256": null,
  }), env(db));
  assert.equal(response.status, 401);
  assert.equal(db.calls.length, 0);
});

test("rejects malformed Supabase JWTs before any tenant database access", async () => {
  const db = new DB();
  const response = await worker.fetch(await request({
    "x-nova-supabase-access-token": "not-a-jwt",
  }), env(db));
  assert.equal(response.status, 401);
  assert.equal(db.calls.length, 0);
});


test("identity-link pending queue is restricted to an active tenant owner and exact Access issuer", async () => {
  const db = new DB();
  db.membershipRows = [{
    subject: "operator@example.test", tenant_id: "tenant-a", role: "tenant_owner",
    membership_status: "active", tenant_status: "active",
  }];
  db.identityLinkRows = [{
    id: "link-request-1", supabase_issuer: "https://project.example.test/auth/v1",
    supabase_subject: "supabase-user", cloudflare_issuer: "https://example.cloudflareaccess.com",
    cloudflare_subject: "requester-subject", created_at: new Date().toISOString(),
  }];
  const response = await worker.fetch(await request({},
    "https://private.internal/internal/v1/tenants/tenant-a/identity-links/pending"), env(db));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data[0].id, "link-request-1");
  const pendingQuery = db.calls.find(call => call.sql.includes("FROM tenant_identity_link_requests"));
  assert.deepEqual(pendingQuery.args, ["https://example.cloudflareaccess.com",
    "operator@example.test", "tenant-a", "tenant-a", 50]);
  assert.equal(db.calls.some(call => call.args?.includes("tenant-b")), false);
});

test("identity-link decision uses the gateway-derived owner identity and caller idempotency key", async () => {
  const db = new DB();
  db.membershipRows = [{
    subject: "operator@example.test", tenant_id: "tenant-a",
    role: "tenant_owner", membership_status: "active", tenant_status: "active",
  }];
  db.identityLinkEventRows = [];
  db.identityLinkRows = [{ id: "link-request-1", status: "pending", tenant_id: null }];
  const response = await worker.fetch(await request({},
    "https://private.internal/internal/v1/tenants/tenant-a/identity-links/link-request-1/decision",
    "POST", JSON.stringify({ decision: "approve", reason: "Independent owner review",
      idempotency_key: "decision-idempotency-1" })), env(db));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.data.status, "approved");
  assert.deepEqual(result.data.decided_by, {
    issuer: "https://example.cloudflareaccess.com", subject: "operator@example.test",
  });
  assert.equal(db.batchCalls.length, 1);
  assert.equal(db.batchCalls[0][0].args[6], "https://example.cloudflareaccess.com");
  assert.equal(db.batchCalls[0][0].args[7], "operator@example.test");
  assert.equal(db.batchCalls[0][0].args[9], "decision-idempotency-1");
});


const IDENTITY_SUPABASE_ISSUER = "https://project.example.test/auth/v1";
const IDENTITY_SUPABASE_AUDIENCE = "authenticated";
const { publicKey: identityPublicKey, privateKey: identityPrivateKey } =
  generateKeyPairSync("rsa", { modulusLength: 2048 });
const identityJwk = { ...identityPublicKey.export({ format: "jwk" }),
  kid: "tenant-api-identity-link-test", alg: "RS256", use: "sig", key_ops: ["verify"] };
function identitySupabaseToken() {
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", typ: "JWT", kid: identityJwk.kid });
  const claims = encode({ iss: IDENTITY_SUPABASE_ISSUER, aud: IDENTITY_SUPABASE_AUDIENCE,
    sub: "supabase-user-1", role: "authenticated", iat: now - 5, exp: now + 300 });
  const input = header + "." + claims;
  return input + "." + sign("RSA-SHA256", Buffer.from(input), identityPrivateKey).toString("base64url");
}

class IdentityLinkRouteDB extends DB {
  constructor({ rateLimitDefaultCount = 0 } = {}) { super(); this.identityChallengeRow = null; this.rateLimitDefaultCount = rateLimitDefaultCount; this.rateLimitCounts = new Map(); }
  prepare(sql) {
    const db = this;
    if (sql.startsWith("DELETE FROM tenant_identity_link_rate_limits")) {
      return { bind(...args) { return { sql, args, run() { return { meta: { changes: 0 } }; } }; } };
    }
    if (sql.includes("INSERT INTO tenant_identity_link_rate_limits")) {
      return { bind(...args) { return { sql, args, all() {
        const key = args.slice(0, 3).join("|");
        const count = db.rateLimitCounts.get(key) ?? db.rateLimitDefaultCount;
        return { results: [{ request_count: count }] };
      } }; } };
    }
    if (sql.startsWith("INSERT INTO tenant_identity_link_challenges")) {
      return { bind(...args) { return { async run() {
        db.calls.push({ sql, args });
        if (db.identityChallengeRow) return { meta: { changes: 0 } };
        const [id, si, ss, ci, cs, digest, created, expires, requestId] = args;
        db.identityChallengeRow = { id, supabase_issuer: si, supabase_subject: ss,
          cloudflare_issuer: ci, cloudflare_subject: cs, challenge_sha256: digest,
          status: "pending", created_at: created, expires_at: expires, request_id: requestId };
        return { meta: { changes: 1 } };
      } }; } };
    }
    if (sql.startsWith("SELECT id, supabase_issuer, supabase_subject, cloudflare_issuer, cloudflare_subject, status, expires_at FROM tenant_identity_link_challenges")) {
      return { bind(...args) { return { async all() {
        db.calls.push({ sql, args });
        const row = db.identityChallengeRow;
        return { results: row && row.id === args[0] && row.challenge_sha256 === args[1] ? [row] : [] };
      } }; } };
    }
    return super.prepare(sql);
  }
  async batch(statements) {
    this.batchCalls.push(statements);
    if (statements.length === 3 && statements[0].sql?.startsWith("DELETE FROM tenant_identity_link_rate_limits")) {
      const results = [ { meta: { changes: 0 } } ];
      for (const statement of statements.slice(1)) {
        const key = statement.args.slice(0, 3).join("|");
        const count = Math.min((this.rateLimitCounts.get(key) ?? this.rateLimitDefaultCount) + 1, 6);
        this.rateLimitCounts.set(key, count);
        results.push({ results: [{ request_count: count }] });
      }
      return results;
    }
    if (statements.length === 3 && this.identityChallengeRow) {
      this.identityChallengeRow.status = "consumed";
      return statements.map(() => ({ meta: { changes: 1 } }));
    }
    return super.batch(statements);
  }
}

test("dual-auth HTTP routes create and consume a challenge bound to both verified identities", async () => {
  const db = new IdentityLinkRouteDB();
  const originalFetch = globalThis.fetch;
  let jwksFetchCount = 0;
  globalThis.fetch = async url => {
    jwksFetchCount += 1;
    assert.equal(String(url), IDENTITY_SUPABASE_ISSUER + "/.well-known/jwks.json");
    return new Response(JSON.stringify({ keys: [identityJwk] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  try {
    const token = identitySupabaseToken();
    const createdResponse = await worker.fetch(await request({
      "x-nova-request-id": "identity-create-001",
      "x-nova-supabase-access-token": token,
    }, "https://private.internal/internal/v1/identity-links/challenges", "POST", "{}"), env(db));
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.equal(db.identityChallengeRow.supabase_issuer, IDENTITY_SUPABASE_ISSUER);
    assert.equal(db.identityChallengeRow.supabase_subject, "supabase-user-1");
    assert.equal(db.identityChallengeRow.cloudflare_issuer, "https://example.cloudflareaccess.com");
    assert.equal(db.identityChallengeRow.cloudflare_subject, "operator@example.test");
    assert.equal(db.identityChallengeRow.status, "pending");
    assert.equal(Object.hasOwn(db.identityChallengeRow, "supabase_token"), false);
    assert.equal(Object.hasOwn(db.identityChallengeRow, "challenge"), false);

    const consumedResponse = await worker.fetch(await request({
      "x-nova-request-id": "identity-consume-001",
      "x-nova-supabase-access-token": token,
    }, "https://private.internal/internal/v1/identity-links/challenges/" +
      created.data.challenge_id + "/consume", "POST",
    JSON.stringify({ challenge: created.data.challenge })), env(db));
    assert.equal(consumedResponse.status, 201);
    assert.equal((await consumedResponse.json()).data.status, "pending");
    assert.equal(db.identityChallengeRow.status, "consumed");
    assert.equal(jwksFetchCount, 2, "each challenge request must fetch and verify the configured JWKS exactly once");
    assert.equal(db.batchCalls.length, 3, "create and consume each charge rate limits; consumption also commits the challenge batch");
    assert.equal(db.batchCalls[0].length, 3);
    assert.equal(db.batchCalls[1].length, 3);
    assert.equal(db.batchCalls[2].length, 3);
    assert.match(db.batchCalls[0][0].sql, /DELETE FROM tenant_identity_link_rate_limits/);
    assert.match(db.batchCalls[1][0].sql, /DELETE FROM tenant_identity_link_rate_limits/);
    assert.match(db.batchCalls[2][0].sql, /UPDATE tenant_identity_link_challenges/);
  } finally { globalThis.fetch = originalFetch; }
});


test("identity-link HTTP routes reject invalid Supabase signatures before challenge or rate-limit persistence", async () => {
  const originalFetch = globalThis.fetch;
  let jwksFetchCount = 0;
  globalThis.fetch = async url => {
    jwksFetchCount += 1;
    assert.equal(String(url), IDENTITY_SUPABASE_ISSUER + "/.well-known/jwks.json");
    return new Response(JSON.stringify({ keys: [identityJwk] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  try {
    for (const [name, path, body] of [
      ["create", "/internal/v1/identity-links/challenges", "{}"],
      ["consume", "/internal/v1/identity-links/challenges/challenge-existing/consume",
        JSON.stringify({ challenge: "test-challenge" })],
    ]) {
      const db = new IdentityLinkRouteDB();
      const parts = identitySupabaseToken().split(".");
      parts[2] = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
      const response = await worker.fetch(await request({
        "x-nova-request-id": "identity-invalid-signature-" + name,
        "x-nova-supabase-access-token": parts.join("."),
      }, "https://private.internal" + path, "POST", body), env(db));
      assert.equal(response.status, 401, name);
      assert.equal((await response.json()).error, "supabase_identity_not_authorized", name);
      assert.equal(db.identityChallengeRow, null, name + " must not create or consume a challenge");
      assert.equal(db.batchCalls.length, 0, name + " must not charge rate limits or persist a challenge");
    }
    assert.equal(jwksFetchCount, 2, "one JWKS fetch per invalid-signature route request");
  } finally { globalThis.fetch = originalFetch; }
});

test("identity-link HTTP routes fail closed on Supabase JWKS outages before challenge or rate-limit persistence", async () => {
  const originalFetch = globalThis.fetch;
  let jwksFetchCount = 0;
  globalThis.fetch = async url => {
    jwksFetchCount += 1;
    assert.equal(String(url), IDENTITY_SUPABASE_ISSUER + "/.well-known/jwks.json");
    return new Response("provider unavailable", { status: 503 });
  };
  try {
    for (const [name, path, body] of [
      ["create", "/internal/v1/identity-links/challenges", "{}"],
      ["consume", "/internal/v1/identity-links/challenges/challenge-existing/consume",
        JSON.stringify({ challenge: "test-challenge" })],
    ]) {
      const db = new IdentityLinkRouteDB();
      const response = await worker.fetch(await request({
        "x-nova-request-id": "identity-jwks-outage-" + name,
        "x-nova-supabase-access-token": identitySupabaseToken(),
      }, "https://private.internal" + path, "POST", body), env(db));
      assert.equal(response.status, 503, name);
      assert.equal((await response.json()).error, "supabase_identity_provider_unavailable", name);
      assert.equal(db.identityChallengeRow, null, name + " must not create or consume a challenge");
      assert.equal(db.batchCalls.length, 0, name + " must not charge rate limits or persist a challenge");
    }
    assert.equal(jwksFetchCount, 2, "one JWKS fetch per provider-outage route request");
  } finally { globalThis.fetch = originalFetch; }
});

test("identity-link HTTP routes fail closed on malformed successful Supabase JWKS responses", async () => {
  const originalFetch = globalThis.fetch;
  let jwksFetchCount = 0;
  globalThis.fetch = async url => {
    jwksFetchCount += 1;
    assert.equal(String(url), IDENTITY_SUPABASE_ISSUER + "/.well-known/jwks.json");
    return new Response("{ malformed jwks", {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  try {
    for (const [name, path, body] of [
      ["create", "/internal/v1/identity-links/challenges", "{}"],
      ["consume", "/internal/v1/identity-links/challenges/challenge-existing/consume",
        JSON.stringify({ challenge: "test-challenge" })],
    ]) {
      const db = new IdentityLinkRouteDB();
      const response = await worker.fetch(await request({
        "x-nova-request-id": "identity-malformed-jwks-" + name,
        "x-nova-supabase-access-token": identitySupabaseToken(),
      }, "https://private.internal" + path, "POST", body), env(db));
      assert.equal(response.status, 503, name);
      assert.equal((await response.json()).error, "supabase_identity_provider_unavailable", name);
      assert.equal(db.identityChallengeRow, null, name + " must not create or consume a challenge");
      assert.equal(db.batchCalls.length, 0, name + " must not charge rate limits or persist a challenge");
    }
    assert.equal(jwksFetchCount, 2, "one JWKS fetch per malformed-provider response");
  } finally { globalThis.fetch = originalFetch; }
});

test("identity-link HTTP routes reject structurally invalid successful Supabase JWKS responses", async () => {
  const originalFetch = globalThis.fetch;
  let jwksFetchCount = 0;
  globalThis.fetch = async url => {
    jwksFetchCount += 1;
    assert.equal(String(url), IDENTITY_SUPABASE_ISSUER + "/.well-known/jwks.json");
    return new Response(JSON.stringify({ keys: [] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  try {
    for (const [name, path, body] of [
      ["create", "/internal/v1/identity-links/challenges", "{}"],
      ["consume", "/internal/v1/identity-links/challenges/challenge-existing/consume",
        JSON.stringify({ challenge: "test-challenge" })],
    ]) {
      const db = new IdentityLinkRouteDB();
      const response = await worker.fetch(await request({
        "x-nova-request-id": "identity-invalid-jwks-shape-" + name,
        "x-nova-supabase-access-token": identitySupabaseToken(),
      }, "https://private.internal" + path, "POST", body), env(db));
      assert.equal(response.status, 503, name);
      assert.equal((await response.json()).error, "supabase_identity_provider_unavailable", name);
      assert.equal(db.identityChallengeRow, null, name + " must not create or consume a challenge");
      assert.equal(db.batchCalls.length, 0, name + " must not charge rate limits or persist a challenge");
    }
    assert.equal(jwksFetchCount, 2, "one JWKS fetch per invalid-provider response");
  } finally { globalThis.fetch = originalFetch; }
});

test("identity-link HTTP routes reject oversized Supabase JWKS responses without writes", async () => {
  const originalFetch = globalThis.fetch;
  let jwksFetchCount = 0;
  globalThis.fetch = async (url, init) => {
    jwksFetchCount += 1;
    assert.equal(String(url), IDENTITY_SUPABASE_ISSUER + "/.well-known/jwks.json");
    assert.equal(init?.redirect, "error");
    return new Response(" ".repeat(65_537), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  try {
    for (const [name, path, body] of [
      ["create", "/internal/v1/identity-links/challenges", "{}"],
      ["consume", "/internal/v1/identity-links/challenges/challenge-existing/consume",
        JSON.stringify({ challenge: "test-challenge" })],
    ]) {
      const db = new IdentityLinkRouteDB();
      const response = await worker.fetch(await request({
        "x-nova-request-id": "identity-jwks-oversized-" + name,
        "x-nova-supabase-access-token": identitySupabaseToken(),
      }, "https://private.internal" + path, "POST", body), env(db));
      assert.equal(response.status, 503, name);
      assert.equal((await response.json()).error, "supabase_identity_provider_unavailable", name);
      assert.equal(db.identityChallengeRow, null, name + " must not create or consume a challenge");
      assert.equal(db.batchCalls.length, 0, name + " must not charge rate limits or persist a challenge");
    }
    assert.equal(jwksFetchCount, 2, "one JWKS fetch per invalid-provider response");
  } finally { globalThis.fetch = originalFetch; }
});

test("identity-link HTTP routes reject oversized JWKS Content-Length before reading the body", async () => {
  const originalFetch = globalThis.fetch;
  let jwksFetchCount = 0;
  let bodyRead = false;
  globalThis.fetch = async (url, init) => {
    jwksFetchCount += 1;
    assert.equal(String(url), IDENTITY_SUPABASE_ISSUER + "/.well-known/jwks.json");
    assert.equal(init?.redirect, "error");
    return {
      ok: true,
      headers: new Headers({ "content-type": "application/json", "content-length": "65537" }),
      get body() {
        bodyRead = true;
        return new ReadableStream({ start(controller) { controller.close(); } });
      },
    };
  };
  try {
    for (const [name, path, body] of [
      ["create", "/internal/v1/identity-links/challenges", "{}"],
      ["consume", "/internal/v1/identity-links/challenges/challenge-existing/consume",
        JSON.stringify({ challenge: "test-challenge" })],
    ]) {
      const db = new IdentityLinkRouteDB();
      const response = await worker.fetch(await request({
        "x-nova-request-id": "identity-jwks-content-length-" + name,
        "x-nova-supabase-access-token": identitySupabaseToken(),
      }, "https://private.internal" + path, "POST", body), env(db));
      assert.equal(response.status, 503, name);
      assert.equal((await response.json()).error, "supabase_identity_provider_unavailable", name);
      assert.equal(db.identityChallengeRow, null, name + " must not create or consume a challenge");
      assert.equal(db.batchCalls.length, 0, name + " must not charge rate limits or persist a challenge");
    }
    assert.equal(jwksFetchCount, 2, "one JWKS fetch per invalid-provider response");
    assert.equal(bodyRead, false, "oversized declared bodies must be rejected before reading");
  } finally { globalThis.fetch = originalFetch; }
});

test("identity-link HTTP routes reject malformed JWKS Content-Length before reading the body", async () => {
  const originalFetch = globalThis.fetch;
  let jwksFetchCount = 0;
  let bodyRead = false;
  globalThis.fetch = async (url, init) => {
    jwksFetchCount += 1;
    assert.equal(String(url), IDENTITY_SUPABASE_ISSUER + "/.well-known/jwks.json");
    assert.equal(init?.redirect, "error");
    return {
      ok: true,
      headers: new Headers({ "content-type": "application/json", "content-length": "65k" }),
      get body() {
        bodyRead = true;
        return new ReadableStream({ start(controller) { controller.close(); } });
      },
    };
  };
  try {
    for (const [name, path, body] of [
      ["create", "/internal/v1/identity-links/challenges", "{}"],
      ["consume", "/internal/v1/identity-links/challenges/challenge-existing/consume",
        JSON.stringify({ challenge: "test-challenge" })],
    ]) {
      const db = new IdentityLinkRouteDB();
      const response = await worker.fetch(await request({
        "x-nova-request-id": "identity-jwks-invalid-content-length-" + name,
        "x-nova-supabase-access-token": identitySupabaseToken(),
      }, "https://private.internal" + path, "POST", body), env(db));
      assert.equal(response.status, 503, name);
      assert.equal((await response.json()).error, "supabase_identity_provider_unavailable", name);
      assert.equal(db.identityChallengeRow, null, name + " must not create or consume a challenge");
      assert.equal(db.batchCalls.length, 0, name + " must not charge rate limits or persist a challenge");
    }
    assert.equal(jwksFetchCount, 2, "one JWKS fetch per invalid-provider response");
    assert.equal(bodyRead, false, "malformed declared bodies must be rejected before reading");
  } finally { globalThis.fetch = originalFetch; }
});

test("identity-link HTTP routes reject successful JWKS responses with no body", async () => {
  const originalFetch = globalThis.fetch;
  let jwksFetchCount = 0;
  globalThis.fetch = async (url, init) => {
    jwksFetchCount += 1;
    assert.equal(String(url), IDENTITY_SUPABASE_ISSUER + "/.well-known/jwks.json");
    assert.equal(init?.redirect, "error");
    return {
      ok: true,
      headers: new Headers({ "content-type": "application/json", "content-length": "0" }),
      body: null,
    };
  };
  try {
    for (const [name, path, body] of [
      ["create", "/internal/v1/identity-links/challenges", "{}"],
      ["consume", "/internal/v1/identity-links/challenges/challenge-existing/consume",
        JSON.stringify({ challenge: "test-challenge" })],
    ]) {
      const db = new IdentityLinkRouteDB();
      const response = await worker.fetch(await request({
        "x-nova-request-id": "identity-jwks-empty-body-" + name,
        "x-nova-supabase-access-token": identitySupabaseToken(),
      }, "https://private.internal" + path, "POST", body), env(db));
      assert.equal(response.status, 503, name);
      assert.equal((await response.json()).error, "supabase_identity_provider_unavailable", name);
      assert.equal(db.identityChallengeRow, null, name + " must not create or consume a challenge");
      assert.equal(db.batchCalls.length, 0, name + " must not charge rate limits or persist a challenge");
    }
    assert.equal(jwksFetchCount, 2, "one JWKS fetch per empty-provider response");
  } finally { globalThis.fetch = originalFetch; }
});

test("identity-link HTTP routes cancel chunked JWKS bodies that exceed the byte limit", async () => {
  const originalFetch = globalThis.fetch;
  let jwksFetchCount = 0;
  let cancelCount = 0;
  globalThis.fetch = async (url, init) => {
    jwksFetchCount += 1;
    assert.equal(String(url), IDENTITY_SUPABASE_ISSUER + "/.well-known/jwks.json");
    assert.equal(init?.redirect, "error");
    return {
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(65_536));
          controller.enqueue(new Uint8Array(1));
        },
        cancel() { cancelCount += 1; },
      }),
    };
  };
  try {
    for (const [name, path, body] of [
      ["create", "/internal/v1/identity-links/challenges", "{}"],
      ["consume", "/internal/v1/identity-links/challenges/challenge-existing/consume",
        JSON.stringify({ challenge: "test-challenge" })],
    ]) {
      const db = new IdentityLinkRouteDB();
      const response = await worker.fetch(await request({
        "x-nova-request-id": "identity-jwks-chunked-overflow-" + name,
        "x-nova-supabase-access-token": identitySupabaseToken(),
      }, "https://private.internal" + path, "POST", body), env(db));
      assert.equal(response.status, 503, name);
      assert.equal((await response.json()).error, "supabase_identity_provider_unavailable", name);
      assert.equal(db.identityChallengeRow, null, name + " must not create or consume a challenge");
      assert.equal(db.batchCalls.length, 0, name + " must not charge rate limits or persist a challenge");
    }
    assert.equal(jwksFetchCount, 2, "one JWKS fetch per invalid-provider response");
    assert.equal(cancelCount, 2, "oversized streaming bodies must be cancelled");
  } finally { globalThis.fetch = originalFetch; }
});

test("identity-link HTTP routes reject JWKS key sets above the configured count limit", async () => {
  const originalFetch = globalThis.fetch;
  let jwksFetchCount = 0;
  globalThis.fetch = async (url, init) => {
    jwksFetchCount += 1;
    assert.equal(String(url), IDENTITY_SUPABASE_ISSUER + "/.well-known/jwks.json");
    assert.equal(init?.redirect, "error");
    return Response.json({ keys: Array.from({ length: 33 }, (_, index) => ({
      kid: "bounded-key-" + index,
      kty: "RSA",
      n: "not-used",
      e: "AQAB",
      use: "sig",
      alg: "RS256",
    })) });
  };
  try {
    for (const [name, path, body] of [
      ["create", "/internal/v1/identity-links/challenges", "{}"],
      ["consume", "/internal/v1/identity-links/challenges/challenge-existing/consume",
        JSON.stringify({ challenge: "test-challenge" })],
    ]) {
      const db = new IdentityLinkRouteDB();
      const response = await worker.fetch(await request({
        "x-nova-request-id": "identity-jwks-key-count-" + name,
        "x-nova-supabase-access-token": identitySupabaseToken(),
      }, "https://private.internal" + path, "POST", body), env(db));
      assert.equal(response.status, 503, name);
      assert.equal((await response.json()).error, "supabase_identity_provider_unavailable", name);
      assert.equal(db.identityChallengeRow, null, name + " must not create or consume a challenge");
      assert.equal(db.batchCalls.length, 0, name + " must not charge rate limits or persist a challenge");
    }
    assert.equal(jwksFetchCount, 2, "one JWKS fetch per oversized key-set response");
  } finally { globalThis.fetch = originalFetch; }
});

test("identity-link HTTP routes reject redirected Supabase JWKS responses without writes", async () => {
  const originalFetch = globalThis.fetch;
  let jwksFetchCount = 0;
  globalThis.fetch = async (url, init) => {
    jwksFetchCount += 1;
    assert.equal(String(url), IDENTITY_SUPABASE_ISSUER + "/.well-known/jwks.json");
    assert.equal(init?.redirect, "error", "JWKS fetch must not follow redirects");
    return new Response(null, { status: 302, headers: { location: "https://attacker.example/jwks.json" } });
  };
  try {
    for (const [name, path, body] of [
      ["create", "/internal/v1/identity-links/challenges", "{}"],
      ["consume", "/internal/v1/identity-links/challenges/challenge-existing/consume",
        JSON.stringify({ challenge: "test-challenge" })],
    ]) {
      const db = new IdentityLinkRouteDB();
      const response = await worker.fetch(await request({
        "x-nova-request-id": "identity-jwks-redirect-" + name,
        "x-nova-supabase-access-token": identitySupabaseToken(),
      }, "https://private.internal" + path, "POST", body), env(db));
      assert.equal(response.status, 503, name);
      assert.equal((await response.json()).error, "supabase_identity_provider_unavailable", name);
      assert.equal(db.identityChallengeRow, null, name + " must not create or consume a challenge");
      assert.equal(db.batchCalls.length, 0, name + " must not charge rate limits or persist a challenge");
    }
    assert.equal(jwksFetchCount, 2, "one JWKS fetch per invalid-provider response");
  } finally { globalThis.fetch = originalFetch; }
});

test("identity-link HTTP routes reject duplicate key IDs in successful Supabase JWKS responses", async () => {
  const originalFetch = globalThis.fetch;
  let jwksFetchCount = 0;
  globalThis.fetch = async url => {
    jwksFetchCount += 1;
    assert.equal(String(url), IDENTITY_SUPABASE_ISSUER + "/.well-known/jwks.json");
    return new Response(JSON.stringify({ keys: [identityJwk, { ...identityJwk }] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  try {
    for (const [name, path, body] of [
      ["create", "/internal/v1/identity-links/challenges", "{}"],
      ["consume", "/internal/v1/identity-links/challenges/challenge-existing/consume",
        JSON.stringify({ challenge: "test-challenge" })],
    ]) {
      const db = new IdentityLinkRouteDB();
      const response = await worker.fetch(await request({
        "x-nova-request-id": "identity-duplicate-jwks-kid-" + name,
        "x-nova-supabase-access-token": identitySupabaseToken(),
      }, "https://private.internal" + path, "POST", body), env(db));
      assert.equal(response.status, 503, name);
      assert.equal((await response.json()).error, "supabase_identity_provider_unavailable", name);
      assert.equal(db.identityChallengeRow, null, name + " must not create or consume a challenge");
      assert.equal(db.batchCalls.length, 0, name + " must not charge rate limits or persist a challenge");
    }
    assert.equal(jwksFetchCount, 2, "one JWKS fetch per invalid-provider response");
  } finally { globalThis.fetch = originalFetch; }
});

test("identity-link challenge route enforces verified-identity rate limits before challenge persistence", async () => {
  const db = new IdentityLinkRouteDB({ rateLimitDefaultCount: 5 });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    assert.equal(String(url), IDENTITY_SUPABASE_ISSUER + "/.well-known/jwks.json");
    return new Response(JSON.stringify({ keys: [identityJwk] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  try {
    const response = await worker.fetch(await request({
      "x-nova-request-id": "identity-rate-limit-001",
      "x-nova-supabase-access-token": identitySupabaseToken(),
    }, "https://private.internal/internal/v1/identity-links/challenges", "POST", "{}"), env(db));
    assert.equal(response.status, 429);
    assert.equal((await response.json()).error, "identity_link_rate_limited");
    assert.ok(Number(response.headers.get("retry-after")) > 0);
    assert.equal(db.identityChallengeRow, null, "blocked requests must not create challenge records");
    assert.equal(db.batchCalls.length, 1, "only rate-limit storage is touched");
  } finally { globalThis.fetch = originalFetch; }
});


test("a valid linked Supabase JWT cannot substitute for the verified Cloudflare subject on tenant resource reads", async () => {
  const db = new DB();
  // Deliberately give the Supabase JWT subject membership and a grant, but
  // not the independently verified Cloudflare subject from the gateway.
  db.membershipRows = [{
    subject: "supabase-user-1", tenant_id: "tenant-a", role: "viewer",
    membership_status: "active", tenant_status: "active",
  }];
  db.grantRows = [{
    subject: "supabase-user-1", tenant_id: "tenant-a",
    resource_type: "site", resource_id: "site-a", action: "read",
  }];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    assert.equal(String(url), IDENTITY_SUPABASE_ISSUER + "/.well-known/jwks.json");
    return new Response(JSON.stringify({ keys: [identityJwk] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  try {
    const response = await worker.fetch(await request({
      "x-nova-supabase-access-token": identitySupabaseToken(),
    }), env(db));
    assert.equal(response.status, 404);
    const membershipRead = db.calls.find(call => call.sql.includes("FROM tenant_memberships"));
    assert.ok(membershipRead);
    assert.deepEqual(membershipRead.args, ["operator@example.test", "tenant-a"]);
    assert.equal(db.calls.some(call => call.sql.includes("FROM tenant_identity_link_requests")), false,
      "tenant resource authorization must not translate the Access subject through an identity-link record");
    assert.equal(db.calls.some(call => /FROM (sites|assets|sources|observations|audit_events)/.test(call.sql)), false,
      "resource data must not be read when the Access subject lacks active membership");
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("approved identity-link inventory requires an active tenant owner and exact Access issuer", async () => {
  const db = new DB();
  db.membershipRows = [{
    subject: "operator@example.test", tenant_id: "tenant-a",
    role: "tenant_owner", membership_status: "active", tenant_status: "active",
  }];
  db.identityLinkRows = [{
    id: "approved-link-a",
    supabase_issuer: "https://project.example.test/auth/v1",
    supabase_subject: "supabase-user-a",
    cloudflare_issuer: "https://example.cloudflareaccess.com",
    cloudflare_subject: "operator-a",
    created_at: "2026-11-15T10:00:00.000Z",
    decided_at: "2026-11-15T10:05:00.000Z",
    decided_by_cloudflare_subject: "operator@example.test",
    reason: "Owner approved after independent review",
  }];
  const response = await worker.fetch(await request({},
    "https://private.internal/internal/v1/tenants/tenant-a/identity-links/approved"), env(db));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.data.length, 1);
  assert.equal(payload.data[0].id, "approved-link-a");
  const ownerQuery = db.calls.find(call => call.sql.includes("FROM tenant_memberships m JOIN tenants t"));
  assert.deepEqual(ownerQuery.args, ["tenant-a", "operator@example.test"]);
  const approvedQuery = db.calls.find(call => call.sql.includes("WHERE r.tenant_id = ? AND r.status = 'approved'"));
  assert.deepEqual(approvedQuery.args, ["tenant-a", "https://example.cloudflareaccess.com", 20]);
  assert.match(approvedQuery.sql, /r\.cloudflare_issuer = \?/);
});

test("approved identity-link inventory returns not-found for inactive or non-owner membership", async () => {
  const db = new DB();
  db.membershipRows = [{
    subject: "operator@example.test", tenant_id: "tenant-a",
    role: "viewer", membership_status: "active", tenant_status: "active",
  }];
  const response = await worker.fetch(await request({},
    "https://private.internal/internal/v1/tenants/tenant-a/identity-links/approved"), env(db));
  assert.equal(response.status, 404);
  assert.equal(db.calls.some(call => call.sql.includes("WHERE r.tenant_id = ? AND r.status = 'approved'")), false);
});


test("lists only active sites with exact tenant membership and site-read grant after identity link approval", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    assert.equal(String(url), IDENTITY_SUPABASE_ISSUER + "/.well-known/jwks.json");
    return new Response(JSON.stringify({ keys: [identityJwk] }), { status: 200 });
  };
  try {
    const db = new DB();
    db.identityLinkRows = [{ id: "approved-link-1" }];
    db.siteListRows = [{ id: "site-a", name: "North Farm", timezone: "Africa/Tunis" }];
    const response = await worker.fetch(await request({
      "x-nova-supabase-access-token": identitySupabaseToken(),
    }, "https://private.internal/internal/v1/tenants/tenant-a/sites"), env(db));
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.limit, 100);
    assert.deepEqual(payload.data, db.siteListRows);
    const link = db.calls.find(call => call.sql.includes("tenant_identity_link_requests WHERE tenant_id = ? AND status = 'approved'"));
    assert.deepEqual(link.args, ["tenant-a", IDENTITY_SUPABASE_ISSUER, "supabase-user-1",
      "https://example.cloudflareaccess.com", "operator@example.test"]);
    const list = db.calls.find(call => call.sql.includes("SELECT s.id, s.name, s.timezone FROM sites s JOIN tenant_memberships"));
    assert.deepEqual(list.args, ["operator@example.test", "tenant-a", IDENTITY_SUPABASE_ISSUER, "supabase-user-1",
      "https://example.cloudflareaccess.com", "operator@example.test"]);
    assert.match(list.sql, /EXISTS \(SELECT 1 FROM tenant_identity_link_requests il/);
    assert.match(list.sql, /g\.resource_type = 'site'/);
    assert.match(list.sql, /g\.action = 'read'/);
    assert.match(list.sql, /s\.status = 'active'/);
    assert.match(list.sql, /LIMIT 100/);
  } finally { globalThis.fetch = originalFetch; }
});

test("site list rechecks the approved identity link in the protected data query", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [identityJwk] }), { status: 200 });
  try {
    const db = new DB();
    db.identityLinkRows = [{ id: "approved-link-1" }];
    db.revokeIdentityLinkAfterCheck = true;
    db.siteListRows = [{ id: "site-a", name: "North Farm", timezone: "Africa/Tunis" }];
    const response = await worker.fetch(await request({
      "x-nova-supabase-access-token": identitySupabaseToken(),
    }, "https://private.internal/internal/v1/tenants/tenant-a/sites"), env(db));
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, [],
      "a link revoked after preliminary verification must not disclose sites");
    const protectedRead = db.calls.find(call => call.sql.includes("SELECT s.id, s.name, s.timezone FROM sites s JOIN tenant_memberships"));
    assert.ok(protectedRead);
    assert.match(protectedRead.sql, /EXISTS \(SELECT 1 FROM tenant_identity_link_requests il/);
  } finally { globalThis.fetch = originalFetch; }
});

test("does not list tenant sites without an approved dual-identity link", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [identityJwk] }), { status: 200 });
  try {
    const db = new DB();
    db.identityLinkRows = [];
    const response = await worker.fetch(await request({
      "x-nova-supabase-access-token": identitySupabaseToken(),
    }, "https://private.internal/internal/v1/tenants/tenant-a/sites"), env(db));
    assert.equal(response.status, 404);
    assert.equal(db.calls.some(call => call.sql.includes("SELECT s.id, s.name, s.timezone FROM sites s JOIN tenant_memberships")), false);
  } finally { globalThis.fetch = originalFetch; }
});

test("requires a verified Supabase identity before site observation reads", async () => {
  const db = new DB();
  const response = await worker.fetch(await request({},
    "https://private.internal/internal/v1/tenants/tenant-a/sites/site-a/observations"), env(db));
  assert.equal(response.status, 401);
  assert.equal(db.calls.some(call => call.sql.includes("SELECT o.id, o.tenant_id, o.site_id")), false);
});

test("lists bounded observations only after approved dual-identity and exact site grant checks", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [identityJwk] }), { status: 200 });
  try {
    const db = new DB();
    db.identityLinkRows = [{ id: "approved-link-1" }];
    db.siteObservationRows = [
      { id: "obs-2", tenant_id: "tenant-a", site_id: "site-a", metric: "soil_moisture", value: 24, unit: "%" },
      { id: "obs-1", tenant_id: "tenant-a", site_id: "site-a", metric: "air_temperature", value: 21, unit: "Cel" },
    ];
    const response = await worker.fetch(await request({
      "x-nova-supabase-access-token": identitySupabaseToken(),
    }, "https://private.internal/internal/v1/tenants/tenant-a/sites/site-a/observations"), env(db));
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.limit, 100);
    assert.deepEqual(payload.data, db.siteObservationRows);
    const link = db.calls.find(call => call.sql.includes("tenant_identity_link_requests WHERE tenant_id = ? AND status = 'approved'"));
    assert.deepEqual(link.args, ["tenant-a", IDENTITY_SUPABASE_ISSUER, "supabase-user-1",
      "https://example.cloudflareaccess.com", "operator@example.test"]);
    const authorization = db.calls.find(call => call.sql.includes("SELECT s.id FROM sites s JOIN tenant_memberships"));
    assert.deepEqual(authorization.args, ["operator@example.test", "tenant-a", "site-a"]);
    const read = db.calls.find(call => call.sql.includes("SELECT o.id, o.tenant_id, o.site_id"));
    assert.deepEqual(read.args, ["tenant-a", "site-a", "operator@example.test", IDENTITY_SUPABASE_ISSUER, "supabase-user-1",
      "https://example.cloudflareaccess.com", "operator@example.test"]);
    assert.match(read.sql, /EXISTS \(SELECT 1 FROM tenant_memberships m JOIN tenants t/);
    assert.match(read.sql, /g\.resource_type = 'site'/);
    assert.match(read.sql, /EXISTS \(SELECT 1 FROM tenant_identity_link_requests il/);
    assert.match(read.sql, /ORDER BY o\.observed_at DESC, o\.id DESC LIMIT 100/);
    assert.match(read.sql, /src\.verification_status = 'verified'/);
  } finally { globalThis.fetch = originalFetch; }
});

test("observation feed rechecks the approved identity link in the protected data query", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [identityJwk] }), { status: 200 });
  try {
    const db = new DB();
    db.identityLinkRows = [{ id: "approved-link-1" }];
    db.revokeIdentityLinkAfterCheck = true;
    db.siteObservationRows = [
      { id: "obs-private", tenant_id: "tenant-a", site_id: "site-a", metric: "soil_moisture", value: 24, unit: "%" },
    ];
    const response = await worker.fetch(await request({
      "x-nova-supabase-access-token": identitySupabaseToken(),
    }, "https://private.internal/internal/v1/tenants/tenant-a/sites/site-a/observations"), env(db));
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, [],
      "a link revoked after preliminary verification must not disclose observations");
    const protectedRead = db.calls.find(call => call.sql.includes("SELECT o.id, o.tenant_id, o.site_id"));
    assert.ok(protectedRead);
    assert.match(protectedRead.sql, /EXISTS \(SELECT 1 FROM tenant_identity_link_requests il/);
  } finally { globalThis.fetch = originalFetch; }
});

test("observation feed rechecks membership and site grant in the protected data query", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [identityJwk] }), { status: 200 });
  try {
    for (const revoked of ["membership", "site grant"]) {
      const db = new DB();
      db.identityLinkRows = [{ id: "approved-link-1" }];
      db.siteObservationRows = [
        { id: "obs-private", tenant_id: "tenant-a", site_id: "site-a", metric: "soil_moisture", value: 24, unit: "%" },
      ];
      if (revoked === "membership") db.revokeMembershipAfterAuthorization = true;
      else db.revokeSiteGrantAfterAuthorization = true;
      const response = await worker.fetch(await request({
        "x-nova-supabase-access-token": identitySupabaseToken(),
      }, "https://private.internal/internal/v1/tenants/tenant-a/sites/site-a/observations"), env(db));
      assert.equal(response.status, 200, revoked);
      assert.deepEqual((await response.json()).data, [],
        revoked + " revoked after preliminary authorization must not disclose observations");
      const protectedRead = db.calls.find(call => call.sql.includes("SELECT o.id, o.tenant_id, o.site_id"));
      assert.ok(protectedRead);
      assert.match(protectedRead.sql, /EXISTS \(SELECT 1 FROM tenant_memberships m JOIN tenants t/);
      assert.match(protectedRead.sql, /g\.action = 'read'/);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("does not read site observations without the exact active site grant", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [identityJwk] }), { status: 200 });
  try {
    const db = new DB({ grant: false });
    db.identityLinkRows = [{ id: "approved-link-1" }];
    const response = await worker.fetch(await request({
      "x-nova-supabase-access-token": identitySupabaseToken(),
    }, "https://private.internal/internal/v1/tenants/tenant-a/sites/site-a/observations"), env(db));
    assert.equal(response.status, 404);
    assert.equal(db.calls.some(call => call.sql.includes("SELECT o.id, o.tenant_id, o.site_id")), false);
  } finally { globalThis.fetch = originalFetch; }
});

test("does not read observations when Supabase and Access identities are not owner-linked", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [identityJwk] }), { status: 200 });
  try {
    const db = new DB();
    db.identityLinkRows = [];
    const response = await worker.fetch(await request({
      "x-nova-supabase-access-token": identitySupabaseToken(),
    }, "https://private.internal/internal/v1/tenants/tenant-a/sites/site-a/observations"), env(db));
    assert.equal(response.status, 404);
    assert.equal(db.calls.some(call => call.sql.includes("SELECT s.id FROM sites s JOIN tenant_memberships")), false);
    assert.equal(db.calls.some(call => call.sql.includes("SELECT o.id, o.tenant_id, o.site_id")), false);
  } finally { globalThis.fetch = originalFetch; }
});

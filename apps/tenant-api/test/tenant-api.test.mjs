import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import worker from "../src/index.mjs";

const now = Math.floor(Date.now() / 1000);
class DB {
  constructor({ membership = true, grant = true, resource = true } = {}) {
    this.membership = membership; this.grant = grant; this.resource = resource; this.calls = []; this.nonces = new Set();
    this.membershipRows = null; this.grantRows = null; this.resourceRows = null; this.criteriaRows = null; this.batchCalls = []; this.batchResult = null;
  }
  async batch(statements) {
    this.batchCalls.push(statements);
    return this.batchResult ?? [{ meta: { changes: 1 } }, { meta: { changes: 1 } }];
  }
  prepare(sql) {
    const db = this;
    return { bind(...args) { return { sql, args,
      async all() {
        db.calls.push({ sql, args });
        if (sql.includes("FROM tenant_memberships")) return { results: db.membershipRows ?? (db.membership ? [{
          subject: "operator@example.test", tenant_id: "tenant-a", role: "viewer",
          membership_status: "active", tenant_status: "active",
        }] : []) };
        if (sql.includes("FROM tenant_resource_grants")) return { results: db.grantRows ?? (db.grant ? [{
          subject: "operator@example.test", tenant_id: "tenant-a", resource_type: args[2],
          resource_id: args[3], action: "read",
        }] : []) };
        if (sql.includes("FROM water_quality_criteria_entries")) return { results: db.criteriaRows ?? [] };
        if (sql.includes("FROM water_quality_criteria_reviewers")) return { results: db.reviewerRows ?? [] };
        if (sql.includes("FROM water_quality_criteria_reviewer_events")) return { results: db.reviewerEventRows ?? [] };
        if (/FROM (sites|assets|sources|observations|audit_events)/.test(sql)) return { results: db.resourceRows ?? (db.resource ? [{
          id: args[1], tenant_id: args[0], name: "Test resource",
        }] : []) };
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
  const path = new URL(url).pathname;
  const canonical = JSON.stringify([method, path, headers.get("x-nova-verified-subject"),
    headers.get("x-nova-verified-issuer"), headers.get("x-nova-verified-audience"),
    headers.get("x-nova-gateway-issued-at"), headers.get("x-nova-request-id")]);
  headers.set("x-nova-internal-signature",
    createHmac("sha256", SECRET).update(canonical).digest("hex"));
  return new Request(url, { method, headers, body });
}
const env = db => ({ ACCESS_ISSUER: "https://example.cloudflareaccess.com",
  ACCESS_AUDIENCE: "aud", INTERNAL_AUTH_SECRET: SECRET, DB: db });

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
  assert.deepEqual(db.calls[3].args, ["tenant-a", "site-a"]);
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
  assert.deepEqual(db.calls[2].args, ["tenant-a"]);
});

test("reads one criteria version with tenant, entry and version selectors bound in SQL", async () => {
  const db = new DB();
  db.criteriaRows = [{
    id: "criteria-tn-1", tenant_id: "tenant-a", version: "1.0",
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

test("does not return criteria belonging to another tenant or unknown versions", async () => {
  const db = new DB(); db.criteriaRows = [];
  const response = await worker.fetch(await request({}, "https://private.internal/internal/v1/tenants/tenant-a/water-quality-criteria/criteria-tn-1/9.9"), env(db));
  assert.equal(response.status, 404);
  assert.deepEqual(db.calls[2].args, ["tenant-a", "criteria-tn-1", "9.9"]);
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

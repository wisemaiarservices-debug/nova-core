import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, webcrypto } from "node:crypto";
globalThis.crypto ??= webcrypto;
import worker from "../src/index.mjs";

const SECRET = "test-only-internal-secret-with-32-bytes-minimum";
const NOW = Math.floor(Date.now() / 1000);

class MembershipIsolationDB {
  constructor() {
    this.calls = [];
    this.nonces = new Set();
  }
  prepare(sql) {
    const db = this;
    return {
      bind(...args) {
        return {
          sql, args,
          async all() {
            db.calls.push({ operation: "all", sql, args });
            if (sql.includes("FROM tenant_memberships")) {
              // The Supabase subject has a tenant membership; the Access
              // subject does not. Only the latter is an authorization actor.
              return { results: [{
                subject: "supabase-user-1",
                tenant_id: "tenant-a",
                role: "tenant_owner",
                membership_status: "active",
                tenant_status: "active",
              }] };
            }
            throw new Error("unexpected SQL read: " + sql);
          },
          async run() {
            db.calls.push({ operation: "run", sql, args });
            if (sql.includes("INSERT INTO internal_request_nonces")) {
              if (db.nonces.has(args[0])) return { meta: { changes: 0 } };
              db.nonces.add(args[0]);
              return { meta: { changes: 1 } };
            }
            throw new Error("unexpected SQL write: " + sql);
          },
        };
      },
    };
  }
}

async function signedRequest(path, requestId) {
  const method = "POST";
  const body = "{}";
  const headers = new Headers({
    "content-type": "application/json",
    "x-nova-verified-subject": "operator@example.test",
    "x-nova-verified-issuer": "https://example.cloudflareaccess.com",
    "x-nova-verified-audience": "aud",
    "x-nova-gateway-issued-at": String(NOW),
    "x-nova-request-id": requestId,
  });
  const bodyDigest = createHash("sha256").update(body).digest("hex");
  headers.set("x-nova-body-sha256", bodyDigest);
  const canonical = JSON.stringify([
    method, path, headers.get("x-nova-verified-subject"),
    headers.get("x-nova-verified-issuer"), headers.get("x-nova-verified-audience"),
    headers.get("x-nova-gateway-issued-at"), headers.get("x-nova-request-id"),
    headers.get("x-nova-body-sha256"), null,
  ]);
  headers.set("x-nova-internal-signature",
    createHmac("sha256", SECRET).update(canonical).digest("hex"));
  return new Request("https://private.internal" + path, { method, headers, body });
}

const routes = [
  "/internal/v1/tenants/tenant-a/sites/site-a/laboratory-reports",
  "/internal/v1/tenants/tenant-a/sites/site-a/assets/asset-a/calibrations",
  "/internal/v1/tenants/tenant-a/sites/site-a/assets/asset-a/calibration-reviewers/assign",
  "/internal/v1/tenants/tenant-a/sites/site-a/assets/asset-a/calibrations/cal-1/verification",
  "/internal/v1/tenants/tenant-a/sites/site-a/assets/asset-a/sensor-source-mappings",
  "/internal/v1/tenants/tenant-a/sites/site-a/assets/asset-a/sensor-source-mappings/mapping-1/verification",
  "/internal/v1/tenants/tenant-a/sites/site-a/sensor-source-mapping-reviewers/assign",
  "/internal/v1/tenants/tenant-a/sites/site-a/assets/asset-a/measurement-quality-policies",
  "/internal/v1/tenants/tenant-a/sites/site-a/assets/asset-a/measurement-quality-policies/policy-1/verification",
  "/internal/v1/tenants/tenant-a/observations/observation-1/measurement-quality-assessment",
  "/internal/v1/tenants/tenant-a/observations/reviewers/assign",
  "/internal/v1/tenants/tenant-a/observations/observation-1/verification",
];

test("governance POST routes authorize the Cloudflare Access subject, never a separate Supabase subject", async () => {
  for (const [index, path] of routes.entries()) {
    const db = new MembershipIsolationDB();
    const request = await signedRequest(path, "governance-subject-isolation-" + index);
    const response = await worker.fetch(request, {
      ACCESS_ISSUER: "https://example.cloudflareaccess.com",
      ACCESS_AUDIENCE: "aud",
      INTERNAL_AUTH_SECRET: SECRET,
      DB: db,
    });

    assert.equal(response.status, 404, path);
    const membershipReads = db.calls.filter(call =>
      call.operation === "all" && call.sql.includes("FROM tenant_memberships"));
    assert.equal(membershipReads.length, 1, path);
    assert.deepEqual(membershipReads[0].args, ["operator@example.test", "tenant-a"], path);
    assert.equal(db.calls.filter(call => call.operation === "all").length, 1,
      "must stop before governance data reads: " + path);
    assert.equal(db.calls.filter(call => call.operation === "run" &&
      !call.sql.includes("INSERT INTO internal_request_nonces")).length, 0,
      "must stop before governance writes: " + path);
  }
});


class CriteriaDetailAuthorizationDB {
  constructor() { this.calls = []; }
  prepare(sql) {
    const db = this;
    return { bind(...args) {
      return {
        sql, args,
        async all() {
          db.calls.push({ operation: "all", sql, args });
          if (sql.includes("FROM water_quality_criteria_entries e")) {
            // The Access subject has no membership or reviewer assignment.
            // The authorization-scoped query must therefore return no row.
            return { results: [] };
          }
          throw new Error("unexpected criteria detail read: " + sql);
        },
        async run() {
          db.calls.push({ operation: "run", sql, args });
          if (sql.includes("INSERT INTO internal_request_nonces")) return { meta: { changes: 1 } };
          throw new Error("unexpected criteria detail write: " + sql);
        },
      };
    } };
  }
}

async function signedGetRequest(path, requestId) {
  const method = "GET";
  const headers = new Headers({
    "x-nova-verified-subject": "operator@example.test",
    "x-nova-verified-issuer": "https://example.cloudflareaccess.com",
    "x-nova-verified-audience": "aud",
    "x-nova-gateway-issued-at": String(NOW),
    "x-nova-request-id": requestId,
  });
  const bodyDigest = createHash("sha256").update("").digest("hex");
  headers.set("x-nova-body-sha256", bodyDigest);
  const canonical = JSON.stringify([
    method, path, headers.get("x-nova-verified-subject"),
    headers.get("x-nova-verified-issuer"), headers.get("x-nova-verified-audience"),
    headers.get("x-nova-gateway-issued-at"), headers.get("x-nova-request-id"),
    headers.get("x-nova-body-sha256"), null,
  ]);
  headers.set("x-nova-internal-signature",
    createHmac("sha256", SECRET).update(canonical).digest("hex"));
  return new Request("https://private.internal" + path, { method, headers });
}

test("water-quality criteria detail is authorization-scoped before entry, event, or approval reads", async () => {
  const db = new CriteriaDetailAuthorizationDB();
  const path = "/internal/v1/tenants/tenant-a/water-quality-criteria/criteria-1/v1";
  const request = await signedGetRequest(path, "criteria-detail-auth-before-read");
  const response = await worker.fetch(request, {
    ACCESS_ISSUER: "https://example.cloudflareaccess.com",
    ACCESS_AUDIENCE: "aud",
    INTERNAL_AUTH_SECRET: SECRET,
    DB: db,
  });

  assert.equal(response.status, 404);
  const reads = db.calls.filter(call => call.operation === "all");
  assert.equal(reads.length, 1);
  assert.match(reads[0].sql, /FROM water_quality_criteria_entries e/);
  assert.match(reads[0].sql, /FROM tenant_memberships/);
  assert.match(reads[0].sql, /FROM tenant_resource_grants/);
  assert.match(reads[0].sql, /FROM water_quality_criteria_reviewers/);
  assert.deepEqual(reads[0].args,
    ["tenant-a", "criteria-1", "v1", "operator@example.test", "operator@example.test"]);
  assert.equal(reads.some(call => /water_quality_criteria_(events|approvals)/.test(call.sql)), false);
  assert.equal(db.calls.filter(call => call.operation === "run" &&
    !call.sql.includes("INSERT INTO internal_request_nonces")).length, 0);
});

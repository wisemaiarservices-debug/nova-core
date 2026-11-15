import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, webcrypto } from "node:crypto";
globalThis.crypto ??= webcrypto;
import worker from "../src/index.mjs";

const SECRET = "test-only-internal-secret-with-32-bytes-minimum";
const NOW = Math.floor(Date.now() / 1000);

class UnauthorizedCriteriaDB {
  constructor() { this.calls = []; }
  prepare(sql) {
    const db = this;
    return {
      bind(...args) {
        return {
          async all() {
            db.calls.push({ operation: "all", sql, args });
            if (sql.includes("FROM tenant_memberships")) return { results: [] };
            if (sql.includes("FROM water_quality_criteria_reviewers")) return { results: [] };
            // If the handler directly reads the criteria record before
            // authorization, return a plausible row so the test detects it.
            if (sql.includes("FROM water_quality_criteria_entries")) {
              return { results: [{ id: "entry-1", site_id: "site-a", jurisdiction: "J-1",
                version: "v1", entry_json: JSON.stringify({ criteria: [] }),
                authority_name: "Test authority", source_evidence_ref: "evidence-1" }] };
            }
            throw new Error("unexpected SQL read: " + sql);
          },
          async run() {
            db.calls.push({ operation: "run", sql, args });
            if (sql.includes("INSERT INTO internal_request_nonces")) return { meta: { changes: 1 } };
            throw new Error("unexpected SQL write: " + sql);
          },
        };
      },
    };
  }
}

function signedGet(path) {
  const method = "GET";
  const bodyDigest = createHash("sha256").update("").digest("hex");
  const headers = new Headers({
    "x-nova-verified-subject": "operator@example.test",
    "x-nova-verified-issuer": "https://example.cloudflareaccess.com",
    "x-nova-verified-audience": "aud",
    "x-nova-gateway-issued-at": String(NOW),
    "x-nova-request-id": "criteria-detail-auth-before-read",
    "x-nova-body-sha256": bodyDigest,
  });
  const canonical = JSON.stringify([
    method, path, headers.get("x-nova-verified-subject"),
    headers.get("x-nova-verified-issuer"), headers.get("x-nova-verified-audience"),
    headers.get("x-nova-gateway-issued-at"), headers.get("x-nova-request-id"),
    bodyDigest, null,
  ]);
  headers.set("x-nova-internal-signature",
    createHmac("sha256", SECRET).update(canonical).digest("hex"));
  return new Request("https://private.internal" + path, { method, headers });
}

test("criteria detail denies non-members before querying criteria records", async () => {
  const db = new UnauthorizedCriteriaDB();
  const path = "/internal/v1/tenants/tenant-a/water-quality-criteria/entry-1/v1";
  const response = await worker.fetch(signedGet(path), {
    ACCESS_ISSUER: "https://example.cloudflareaccess.com",
    ACCESS_AUDIENCE: "aud",
    INTERNAL_AUTH_SECRET: SECRET,
    DB: db,
  });

  assert.equal(response.status, 404);
  const membershipIndex = db.calls.findIndex(call =>
    call.operation === "all" && call.sql.includes("FROM tenant_memberships"));
  const criteriaReads = db.calls.filter(call =>
    call.operation === "all" && call.sql.includes("FROM water_quality_criteria_entries"));
  assert.notEqual(membershipIndex, -1, "must check Access-subject membership");
  assert.deepEqual(criteriaReads, [], "must not query criteria metadata or content for a non-member");
  assert.equal(db.calls.filter(call => call.operation === "run" &&
    !call.sql.includes("INSERT INTO internal_request_nonces")).length, 0);
});

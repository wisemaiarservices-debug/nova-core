import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, webcrypto } from "node:crypto";
globalThis.crypto ??= webcrypto;
import worker from "../src/index.mjs";

const SECRET = "test-only-internal-secret-with-32-bytes-minimum";
const NOW = Math.floor(Date.now() / 1000);

class SpecializedReadDB {
  constructor() { this.calls = []; }
  prepare(sql) {
    const db = this;
    return {
      bind(...args) {
        return {
          async all() {
            db.calls.push({ operation: "all", sql, args });
            if (sql.includes("FROM tenant_memberships")) {
              return { results: args[0] === "supabase-user-1" ? [{
                subject: "supabase-user-1", tenant_id: "tenant-a",
                role: "tenant_owner", membership_status: "active", tenant_status: "active",
              }] : [] };
            }
            throw new Error("unexpected protected read: " + sql);
          },
          async run() {
            db.calls.push({ operation: "run", sql, args });
            if (sql.includes("INSERT INTO internal_request_nonces")) return { meta: { changes: 1 } };
            throw new Error("unexpected write: " + sql);
          },
        };
      },
    };
  }
}

function signedGet(path, requestId) {
  const bodyDigest = createHash("sha256").update("").digest("hex");
  const headers = new Headers({
    "x-nova-verified-subject": "operator@example.test",
    "x-nova-verified-issuer": "https://example.cloudflareaccess.com",
    "x-nova-verified-audience": "aud",
    "x-nova-gateway-issued-at": String(NOW),
    "x-nova-request-id": requestId,
    "x-nova-body-sha256": bodyDigest,
  });
  const canonical = JSON.stringify([
    "GET", path, headers.get("x-nova-verified-subject"),
    headers.get("x-nova-verified-issuer"), headers.get("x-nova-verified-audience"),
    headers.get("x-nova-gateway-issued-at"), headers.get("x-nova-request-id"),
    bodyDigest, null,
  ]);
  headers.set("x-nova-internal-signature",
    createHmac("sha256", SECRET).update(canonical).digest("hex"));
  return new Request("https://private.internal" + path, { method: "GET", headers });
}

const protectedReads = [
  ["/internal/v1/tenants/tenant-a/sites/site-a/laboratory-reports/report-1", "lab-report-detail"],
  ["/internal/v1/tenants/tenant-a/water-quality-criteria", "criteria-list"],
  ["/internal/v1/tenants/tenant-a/water-quality-criteria/reviewers", "criteria-reviewer-list"],
];

test("specialized governance GET routes never substitute Supabase subject for Access membership", async () => {
  for (const [path, suffix] of protectedReads) {
    const db = new SpecializedReadDB();
    const response = await worker.fetch(signedGet(path, "specialized-get-" + suffix), {
      ACCESS_ISSUER: "https://example.cloudflareaccess.com",
      ACCESS_AUDIENCE: "aud",
      INTERNAL_AUTH_SECRET: SECRET,
      DB: db,
    });
    assert.equal(response.status, 404, path);
    const membership = db.calls.find(call =>
      call.operation === "all" && call.sql.includes("FROM tenant_memberships"));
    assert.ok(membership, "must check tenant membership for " + path);
    assert.deepEqual(membership.args, ["operator@example.test", "tenant-a"], path);
    assert.equal(db.calls.filter(call => call.operation === "all").length, 1,
      "must stop before protected evidence/criteria reads: " + path);
    assert.equal(db.calls.filter(call => call.operation === "run" &&
      !call.sql.includes("INSERT INTO internal_request_nonces")).length, 0);
  }
});

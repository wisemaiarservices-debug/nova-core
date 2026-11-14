import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync, sign, webcrypto } from "node:crypto";
import worker from "../src/index.mjs";

globalThis.crypto ??= webcrypto;

const ACCESS_ISSUER = "https://example.cloudflareaccess.com";
const SUPABASE_ISSUER = "https://project.example.test/auth/v1";
const AUDIENCE = "authenticated";
const SECRET = "test-only-internal-secret-with-32-bytes-minimum";
const now = Math.floor(Date.now() / 1000);
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "supabase-test-key",
  alg: "RS256", use: "sig", key_ops: ["verify"] };
function b64(value) { return Buffer.from(value).toString("base64url"); }
function supabaseToken() {
  const header = b64(JSON.stringify({ alg: "RS256", typ: "JWT", kid: jwk.kid }));
  const claims = b64(JSON.stringify({ iss: SUPABASE_ISSUER, aud: AUDIENCE,
    sub: "supabase-user-should-not-authorize", role: "authenticated",
    iat: now - 5, exp: now + 300 }));
  const input = header + "." + claims;
  return input + "." + sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url");
}
class ReadOnlyTenantDb {
  constructor() { this.calls = []; this.nonces = new Set(); }
  prepare(sql) {
    const db = this;
    return { bind(...args) { return { sql, args,
      async all() {
        db.calls.push({ sql, args });
        if (sql.includes("FROM tenant_memberships")) return { results: [{
          subject: "cloudflare-access-user", tenant_id: "tenant-a", role: "viewer",
          membership_status: "active", tenant_status: "active",
        }] };
        if (sql.includes("FROM tenant_resource_grants")) return { results: [{
          subject: "cloudflare-access-user", tenant_id: "tenant-a",
          resource_type: "site", resource_id: "site-a", action: "read",
        }] };
        if (sql.includes("FROM sites")) return { results: [{
          id: "site-a", tenant_id: "tenant-a", name: "Authorized site",
        }] };
        throw new Error("unexpected SQL: " + sql);
      },
      async run() {
        db.calls.push({ sql, args });
        if (sql.includes("INSERT INTO internal_request_nonces")) {
          if (db.nonces.has(args[0])) return { meta: { changes: 0 } };
          db.nonces.add(args[0]);
          return { meta: { changes: 1 } };
        }
        throw new Error("unexpected write SQL: " + sql);
      },
    }; } };
  }
}
test("a valid Supabase identity is verified but never substitutes for the Access tenant principal", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    assert.equal(String(url), SUPABASE_ISSUER + "/.well-known/jwks.json");
    return new Response(JSON.stringify({ keys: [jwk] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  try {
    const token = supabaseToken();
    const path = "/internal/v1/tenants/tenant-a/sites/site-a";
    const headers = new Headers({
      "x-nova-verified-subject": "cloudflare-access-user",
      "x-nova-verified-issuer": ACCESS_ISSUER,
      "x-nova-verified-audience": "access-app-audience",
      "x-nova-gateway-issued-at": String(now),
      "x-nova-request-id": "dual-identity-test-request",
      "x-nova-supabase-access-token": token,
      "x-nova-supabase-token-sha256": createHash("sha256").update(token).digest("hex"),
      "x-nova-body-sha256": createHash("sha256").update("").digest("hex"),
    });
    const canonical = JSON.stringify(["GET", path,
      headers.get("x-nova-verified-subject"), headers.get("x-nova-verified-issuer"),
      headers.get("x-nova-verified-audience"), headers.get("x-nova-gateway-issued-at"),
      headers.get("x-nova-request-id"), headers.get("x-nova-body-sha256"),
      headers.get("x-nova-supabase-token-sha256")]);
    headers.set("x-nova-internal-signature", createHmac("sha256", SECRET)
      .update(canonical).digest("hex"));

    const db = new ReadOnlyTenantDb();
    const response = await worker.fetch(new Request("https://private.internal" + path, { headers }), {
      ACCESS_ISSUER, ACCESS_AUDIENCE: "access-app-audience",
      INTERNAL_AUTH_SECRET: SECRET, SUPABASE_AUTH_ISSUER: SUPABASE_ISSUER,
      SUPABASE_AUTH_AUDIENCE: AUDIENCE, DB: db,
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.name, "Authorized site");
    const membershipRead = db.calls.find(call => call.sql.includes("FROM tenant_memberships"));
    assert.ok(membershipRead);
    assert.equal(membershipRead.args[0], "cloudflare-access-user");
    assert.notEqual(membershipRead.args[0], "supabase-user-should-not-authorize");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

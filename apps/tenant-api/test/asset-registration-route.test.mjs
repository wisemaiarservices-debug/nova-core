import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync, sign, webcrypto } from "node:crypto";
import worker from "../src/index.mjs";

globalThis.crypto ??= webcrypto;
const ACCESS_ISSUER = "https://nova-ci.cloudflareaccess.com";
const ACCESS_AUDIENCE = "nova-ci-test-audience";
const SUPABASE_ISSUER = "https://project-ci.supabase.co/auth/v1";
const SECRET = "asset-registration-route-test-secret-minimum-32-bytes";
const b64 = value => Buffer.from(value).toString("base64url");
const digest = value => createHash("sha256").update(value).digest("hex");
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "asset-ci-key",
  use: "sig", alg: "RS256", key_ops: ["verify"] };
function supabaseToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = b64(JSON.stringify({ alg: "RS256", typ: "JWT", kid: jwk.kid }));
  const claims = b64(JSON.stringify({ iss: SUPABASE_ISSUER, aud: "authenticated",
    sub: "supabase-owner", role: "authenticated", iat: now - 2, exp: now + 300 }));
  const input = header + "." + claims;
  return input + "." + sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url");
}
function canonical(method, path, headers) {
  return JSON.stringify([method, path, headers.get("x-nova-verified-subject"),
    headers.get("x-nova-verified-issuer"), headers.get("x-nova-verified-audience"),
    headers.get("x-nova-gateway-issued-at"), headers.get("x-nova-request-id"),
    headers.get("x-nova-body-sha256"), headers.get("x-nova-supabase-token-sha256"),
    headers.get("x-nova-idempotency-key")]);
}
class AssetDB {
  constructor({ role = "tenant_owner", link = true, siteGrant = true } = {}) {
    this.role = role; this.link = link; this.siteGrant = siteGrant; this.batchStatements = [];
  }
  prepare(sql) {
    const db = this;
    return { bind(...args) { return { sql, args,
      async all() {
        if (sql.includes("tenant_identity_link_requests")) return { results: db.link ? [{ id: "link-1" }] : [] };
        if (sql.includes("FROM tenant_memberships m JOIN tenants t")) return { results: [{
          subject: "cloudflare-owner", tenant_id: "tenant-a", role: db.role,
          membership_status: "active", tenant_status: "active",
        }] };
        if (sql.includes("FROM tenant_resource_grants")) return { results: db.siteGrant ? [{
          subject: "cloudflare-owner", tenant_id: "tenant-a", resource_type: "site",
          resource_id: "site-a", action: "read",
        }] : [] };
        if (sql.includes("tenant_asset_creation_requests")) return { results: [] };
        throw new Error("unexpected asset route query: " + sql);
      },
      async run() {
        if (sql.includes("internal_request_nonces")) return { meta: { changes: 1 } };
        throw new Error("unexpected asset route write: " + sql);
      },
    }; } };
  }
  async batch(statements) {
    this.batchStatements = statements;
    return statements.map(() => ({ meta: { changes: 1 } }));
  }
}
async function invoke(db) {
  const token = supabaseToken();
  const raw = Buffer.from(JSON.stringify({ name: "Pump 01", asset_type: "pump" }));
  const headers = new Headers({
    "content-type": "application/json",
    "x-nova-verified-subject": "cloudflare-owner",
    "x-nova-verified-issuer": ACCESS_ISSUER,
    "x-nova-verified-audience": ACCESS_AUDIENCE,
    "x-nova-gateway-issued-at": String(Math.floor(Date.now() / 1000)),
    "x-nova-request-id": "asset-request-1",
    "x-nova-body-sha256": digest(raw),
    "x-nova-supabase-token-sha256": digest(token),
    "x-nova-idempotency-key": "asset-onboarding-1",
    "x-nova-supabase-access-token": token,
  });
  headers.set("x-nova-internal-signature", createHmac("sha256", SECRET)
    .update(canonical("POST", "/internal/v1/tenants/tenant-a/sites/site-a/assets", headers)).digest("hex"));
  return worker.fetch(new Request("https://tenant.internal/internal/v1/tenants/tenant-a/sites/site-a/assets",
    { method: "POST", headers, body: raw }), {
    DB: db, ACCESS_ISSUER, ACCESS_AUDIENCE, INTERNAL_AUTH_SECRET: SECRET,
    SUPABASE_AUTH_ISSUER: SUPABASE_ISSUER, SUPABASE_AUTH_AUDIENCE: "authenticated",
  });
}

test("private API creates assets only for linked active tenant owners with exact site read grant", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }), {
    status: 200, headers: { "content-type": "application/json" },
  });
  try {
    const db = new AssetDB();
    const response = await invoke(db);
    const payload = await response.json();
    assert.equal(response.status, 201, JSON.stringify(payload));
    assert.equal(payload.data.status, "unconfigured");
    assert.equal(payload.data.site_id, "site-a");
    assert.equal(db.batchStatements.length, 5);
  } finally { globalThis.fetch = oldFetch; }
});

test("private API denies admin, unlinked identity and missing site grant before writes", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }), {
    status: 200, headers: { "content-type": "application/json" },
  });
  try {
    for (const options of [{ role: "tenant_admin" }, { link: false }, { siteGrant: false }]) {
      const db = new AssetDB(options);
      const response = await invoke(db);
      assert.equal(response.status, 404);
      assert.equal(db.batchStatements.length, 0);
    }
  } finally { globalThis.fetch = oldFetch; }
});

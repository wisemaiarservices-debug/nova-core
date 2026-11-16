import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync, sign, webcrypto } from "node:crypto";
import worker from "../src/index.mjs";

globalThis.crypto ??= webcrypto;

const ACCESS_ISSUER = "https://nova-ci.cloudflareaccess.com";
const ACCESS_AUDIENCE = "nova-ci-test-audience";
const SUPABASE_ISSUER = "https://project-ci.supabase.co/auth/v1";
const SECRET = "site-creation-route-test-secret-minimum-32-bytes";
const b64 = value => Buffer.from(value).toString("base64url");
const digest = value => createHash("sha256").update(value).digest("hex");
const { privateKey: supabasePrivateKey, publicKey: supabasePublicKey } =
  generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...supabasePublicKey.export({ format: "jwk" }),
  kid: "site-creation-supabase-key", use: "sig", alg: "RS256", key_ops: ["verify"] };

function supabaseToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = b64(JSON.stringify({ alg: "RS256", typ: "JWT", kid: jwk.kid }));
  const claims = b64(JSON.stringify({ iss: SUPABASE_ISSUER, aud: "authenticated",
    sub: "supabase-owner", role: "authenticated", iat: now - 2, exp: now + 300 }));
  const input = header + "." + claims;
  return input + "." + sign("RSA-SHA256", Buffer.from(input), supabasePrivateKey).toString("base64url");
}
function envelope(method, path, headers) {
  return JSON.stringify([method, path, headers.get("x-nova-verified-subject"),
    headers.get("x-nova-verified-issuer"), headers.get("x-nova-verified-audience"),
    headers.get("x-nova-gateway-issued-at"), headers.get("x-nova-request-id"),
    headers.get("x-nova-body-sha256"), headers.get("x-nova-supabase-token-sha256"),
    headers.get("x-nova-idempotency-key")]);
}
class SiteDB {
  constructor({ role = "tenant_owner", link = true, existing = [] } = {}) {
    this.role = role; this.link = link; this.existing = existing;
    this.batchStatements = []; this.calls = [];
  }
  prepare(sql) {
    const db = this;
    return { bind(...args) { return { sql, args,
      async all() {
        db.calls.push({ sql, args });
        if (sql.includes("tenant_identity_link_requests")) return {
          results: db.link ? [{ id: "approved-identity-link" }] : [],
        };
        if (sql.includes("FROM tenant_memberships m JOIN tenants t")) return {
          results: [{ subject: "cloudflare-owner", tenant_id: "tenant-a", role: db.role,
            membership_status: "active", tenant_status: "active" }],
        };
        if (sql.includes("tenant_site_creation_requests")) return { results: db.existing };
        throw new Error("unexpected site creation route query: " + sql);
      },
      async run() {
        db.calls.push({ sql, args });
        if (sql.includes("internal_request_nonces")) return { meta: { changes: 1 } };
        throw new Error("unexpected site creation route write: " + sql);
      },
    }; } };
  }
  async batch(statements) {
    this.batchStatements = statements;
    return statements.map(() => ({ meta: { changes: 1 } }));
  }
}
async function invoke(db, { body = { name: "North Farm" }, idempotencyKey = "site-onboarding-1" } = {}) {
  const token = supabaseToken();
  const raw = Buffer.from(JSON.stringify(body));
  const now = String(Math.floor(Date.now() / 1000));
  const headers = new Headers({
    "content-type": "application/json",
    "x-nova-verified-subject": "cloudflare-owner",
    "x-nova-verified-issuer": ACCESS_ISSUER,
    "x-nova-verified-audience": ACCESS_AUDIENCE,
    "x-nova-gateway-issued-at": now,
    "x-nova-request-id": "site-request-" + Math.random().toString(36).slice(2, 12),
    "x-nova-body-sha256": digest(raw),
    "x-nova-supabase-token-sha256": digest(token),
    "x-nova-idempotency-key": idempotencyKey,
    "x-nova-supabase-access-token": token,
  });
  headers.set("x-nova-internal-signature",
    createHmac("sha256", SECRET).update(envelope("POST", "/internal/v1/tenants/tenant-a/sites", headers)).digest("hex"));
  return worker.fetch(new Request("https://tenant.internal/internal/v1/tenants/tenant-a/sites", {
    method: "POST", headers, body: raw,
  }), {
    DB: db, ACCESS_ISSUER, ACCESS_AUDIENCE, INTERNAL_AUTH_SECRET: SECRET,
    SUPABASE_AUTH_ISSUER: SUPABASE_ISSUER, SUPABASE_AUTH_AUDIENCE: "authenticated",
  });
}

test("private Tenant API creates a site only for the linked active tenant owner", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }), {
    status: 200, headers: { "content-type": "application/json" },
  });
  try {
    const db = new SiteDB();
    const response = await invoke(db);
    const payload = await response.json();
    assert.equal(response.status, 201, JSON.stringify(payload));
    assert.equal(payload.data.name, "North Farm");
    assert.equal(payload.data.created, true);
    assert.equal(db.batchStatements.length, 5);
    assert.match(db.batchStatements[0].sql, /role = 'tenant_owner'/);
    assert.match(db.batchStatements[1].sql, /'site', \?, 'read'/);
  } finally { globalThis.fetch = originalFetch; }
});

test("private Tenant API denies non-owner roles before any site write", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }), {
    status: 200, headers: { "content-type": "application/json" },
  });
  try {
    const db = new SiteDB({ role: "tenant_admin" });
    const response = await invoke(db);
    assert.equal(response.status, 404);
    assert.equal(db.batchStatements.length, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("private Tenant API denies an unapproved identity pair before any site write", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }), {
    status: 200, headers: { "content-type": "application/json" },
  });
  try {
    const db = new SiteDB({ link: false });
    const response = await invoke(db);
    assert.equal(response.status, 404);
    assert.equal(db.batchStatements.length, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("private Tenant API rejects caller-supplied site or tenant fields", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }), {
    status: 200, headers: { "content-type": "application/json" },
  });
  try {
    const db = new SiteDB();
    const response = await invoke(db, { body: { name: "North Farm", tenant_id: "tenant-b" } });
    assert.equal(response.status, 400);
    assert.equal(db.batchStatements.length, 0);
  } finally { globalThis.fetch = originalFetch; }
});

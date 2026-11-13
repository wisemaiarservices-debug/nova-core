import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.mjs";
import { generateKeyPairSync, sign, webcrypto } from "node:crypto";
globalThis.crypto ??= webcrypto;

function env(overrides = {}) {
  return { ACCESS_ISSUER: "https://example.cloudflareaccess.com", ACCESS_AUDIENCE: "aud", INTERNAL_AUTH_SECRET: "test-only-internal-secret-with-32-bytes-minimum",
    TENANT_API: { fetch: async request => new Response(JSON.stringify({
      path: new URL(request.url).pathname, subject: request.headers.get("x-nova-verified-subject"),
      cookie: request.headers.get("cookie"), forged: request.headers.get("x-nova-verified-issuer"),
    }), { status: 200, headers: { "content-type": "application/json" } }) }, ...overrides };
}
test("rejects methods and unallowlisted paths before identity lookup", async () => {
  assert.equal((await worker.fetch(new Request("https://gateway.test/api/v1/tenants/t/sites/s", { method: "POST" }), env())).status, 404);
  assert.equal((await worker.fetch(new Request("https://gateway.test/proxy?url=https://evil.test"), env())).status, 404);
  assert.equal((await worker.fetch(new Request("https://gateway.test/api/v1/tenants/t/sites/s?x=1"), env())).status, 404);
});
test("requires configured private binding and identity configuration", async () => {
  assert.equal((await worker.fetch(new Request("https://gateway.test/api/v1/tenants/t/sites/s"), env({ TENANT_API: null }))).status, 503);
});
test("validates bounded path selectors", async () => {
  assert.equal((await worker.fetch(new Request("https://gateway.test/api/v1/tenants/%2e%2e/sites/s"), env())).status, 404);
});

test("verifies Access JWT and forwards only a fresh minimal identity envelope", async () => {
  const issuer = "https://gateway-integration.cloudflareaccess.com";
  const audience = "gateway-integration-audience";
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  Object.assign(jwk, { kid: "gateway-integration-key", use: "sig", alg: "RS256" });
  const enc = value => Buffer.from(value).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = enc(JSON.stringify({ alg: "RS256", typ: "JWT", kid: jwk.kid }));
  const claims = enc(JSON.stringify({ iss: issuer, aud: [audience], sub: "verified-human-subject",
    iat: now - 5, exp: now + 300 }));
  const input = head + "." + claims;
  const token = input + "." + sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url");
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    assert.equal(String(url), issuer + "/cdn-cgi/access/certs");
    return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
  };
  let captured;
  try {
    const response = await worker.fetch(new Request(
      "https://gateway.test/api/v1/tenants/tenant-a/sites/site-a",
      { headers: { "Cf-Access-Jwt-Assertion": token, cookie: "session=secret",
        "x-nova-verified-subject": "attacker", "x-nova-verified-issuer": "https://attacker.test" } }),
      { ACCESS_ISSUER: issuer, ACCESS_AUDIENCE: audience, INTERNAL_AUTH_SECRET: "test-only-internal-secret-with-32-bytes-minimum",
        TENANT_API: { fetch: async request => {
          captured = request;
          return new Response(JSON.stringify({ data: "ok" }), { headers: { "content-type": "application/json" } });
        } } });
    assert.equal(response.status, 200);
    assert.equal(captured.method, "GET");
    assert.equal(new URL(captured.url).pathname, "/internal/v1/tenants/tenant-a/sites/site-a");
    assert.equal(captured.headers.get("x-nova-verified-subject"), "verified-human-subject");
    assert.equal(captured.headers.get("x-nova-verified-issuer"), issuer);
    assert.equal(captured.headers.get("cookie"), null);
    assert.notEqual(captured.headers.get("x-nova-request-id"), null);
    assert.match(captured.headers.get("x-nova-internal-signature"), /^[a-f0-9]{64}$/);
  } finally { globalThis.fetch = oldFetch; }
});


test("routes tenant water-quality criteria list and version reads through the verified gateway", async () => {
  const issuer = "https://criteria-gateway.cloudflareaccess.com";
  const audience = "criteria-gateway-audience";
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  Object.assign(jwk, { kid: "criteria-gateway-key", use: "sig", alg: "RS256" });
  const enc = value => Buffer.from(value).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = enc(JSON.stringify({ alg: "RS256", typ: "JWT", kid: jwk.kid }));
  const claims = enc(JSON.stringify({ iss: issuer, aud: [audience], sub: "criteria-reader", iat: now - 5, exp: now + 300 }));
  const input = head + "." + claims;
  const token = input + "." + sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url");
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    assert.equal(String(url), issuer + "/cdn-cgi/access/certs");
    return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
  };
  try {
    for (const [publicPath, internalPath] of [
      ["/api/v1/tenants/tenant-a/water-quality-criteria", "/internal/v1/tenants/tenant-a/water-quality-criteria"],
      ["/api/v1/tenants/tenant-a/water-quality-criteria/criteria-1/1.0", "/internal/v1/tenants/tenant-a/water-quality-criteria/criteria-1/1.0"],
      ["/api/v1/tenants/tenant-a/water-quality-criteria/reviewers", "/internal/v1/tenants/tenant-a/water-quality-criteria/reviewers"],
    ]) {
      let captured;
      const response = await worker.fetch(new Request("https://gateway.test" + publicPath, {
        headers: { "Cf-Access-Jwt-Assertion": token, cookie: "session=secret", "x-nova-verified-subject": "attacker" },
      }), {
        ACCESS_ISSUER: issuer, ACCESS_AUDIENCE: audience,
        INTERNAL_AUTH_SECRET: "test-only-internal-secret-with-32-bytes-minimum",
        TENANT_API: { fetch: async request => {
          captured = request;
          return new Response(JSON.stringify({ data: [] }), { headers: { "content-type": "application/json" } });
        } },
      });
      assert.equal(response.status, 200);
      assert.equal(new URL(captured.url).pathname, internalPath);
      assert.equal(captured.headers.get("x-nova-verified-subject"), "criteria-reader");
      assert.equal(captured.headers.get("cookie"), null);
      assert.match(captured.headers.get("x-nova-internal-signature"), /^[a-f0-9]{64}$/);
    }
    const draftPayload = JSON.stringify({ entry: { id: "criteria-draft" } });
    let capturedPost;
    const postResponse = await worker.fetch(new Request(
      "https://gateway.test/api/v1/tenants/tenant-a/water-quality-criteria",
      { method: "POST", body: draftPayload, headers: {
        "content-type": "application/json", "Cf-Access-Jwt-Assertion": token,
        cookie: "session=secret", "x-nova-verified-subject": "attacker",
      } }), {
      ACCESS_ISSUER: issuer, ACCESS_AUDIENCE: audience,
      INTERNAL_AUTH_SECRET: "test-only-internal-secret-with-32-bytes-minimum",
      TENANT_API: { fetch: async request => {
        capturedPost = request;
        return new Response(JSON.stringify({ data: { status: "draft" } }), {
          status: 201, headers: { "content-type": "application/json" },
        });
      } },
    });
    assert.equal(postResponse.status, 201);
    assert.equal(capturedPost.method, "POST");
    assert.equal(await capturedPost.text(), draftPayload);
    assert.equal(capturedPost.headers.get("x-nova-verified-subject"), "criteria-reader");
    assert.equal(capturedPost.headers.get("cookie"), null);
    assert.match(capturedPost.headers.get("x-nova-internal-signature"), /^[a-f0-9]{64}$/);
    for (const action of ["assign", "revoke"]) {
      let forwarded;
      const payload = JSON.stringify({ reviewer_subject: "independent-reviewer", reviewer_role: "domain_expert",
        jurisdiction: "TN", evidence_ref: "evidence:" + action, ...(action === "revoke" ? { reason: "Appointment ended" } : {}) });
      const response = await worker.fetch(new Request(
        "https://gateway.test/api/v1/tenants/tenant-a/water-quality-criteria/reviewers/" + action,
        { method: "POST", body: payload, headers: { "content-type": "application/json", "Cf-Access-Jwt-Assertion": token } }), {
        ACCESS_ISSUER: issuer, ACCESS_AUDIENCE: audience,
        INTERNAL_AUTH_SECRET: "test-only-internal-secret-with-32-bytes-minimum",
        TENANT_API: { fetch: async request => {
          forwarded = request;
          return new Response(JSON.stringify({ data: { status: action === "assign" ? "active" : "revoked" } }), {
            status: action === "assign" ? 201 : 200, headers: { "content-type": "application/json" },
          });
        } },
      });
      assert.equal(response.status, action === "assign" ? 201 : 200);
      assert.equal(new URL(forwarded.url).pathname, "/internal/v1/tenants/tenant-a/water-quality-criteria/reviewers/" + action);
      assert.equal(forwarded.method, "POST");
      assert.equal(await forwarded.text(), payload);
      assert.equal(forwarded.headers.get("x-nova-verified-subject"), "criteria-reader");
    }
    for (const action of ["submit", "review", "resolve", "assess"]) {
      let forwarded;
      const payload = action === "submit" ? "{}" : action === "review" ? JSON.stringify({
        reviewer_role: "domain_expert", decision: "approve", evidence_ref: "evidence:review",
      }) : action === "resolve" ? JSON.stringify({
        context: { tenant_id: "tenant-a", site_id: "site-a", jurisdiction: "TN",
          crop_id: "olive", irrigation_method: "drip", intended_use: "agricultural_irrigation" },
        sampled_at: "2026-05-10T10:00:00Z",
      }) : JSON.stringify({
        context: { tenant_id: "tenant-a", site_id: "site-a", jurisdiction: "TN",
          crop_id: "olive", irrigation_method: "drip", intended_use: "agricultural_irrigation" },
        samples: [{ id: "sample-1", parameter: "ec", value: 1.5, unit: "dS/m", sampled_at: "2026-05-10T10:00:00Z" }],
      });
      const response = await worker.fetch(new Request(
        "https://gateway.test/api/v1/tenants/tenant-a/water-quality-criteria/criteria-1/1.0/" + action,
        { method: "POST", body: payload, headers: { "content-type": "application/json", "Cf-Access-Jwt-Assertion": token } }), {
        ACCESS_ISSUER: issuer, ACCESS_AUDIENCE: audience,
        INTERNAL_AUTH_SECRET: "test-only-internal-secret-with-32-bytes-minimum",
        TENANT_API: { fetch: async request => {
          forwarded = request;
          return new Response(JSON.stringify({ data: { status: "ok" } }), {
            status: 200, headers: { "content-type": "application/json" },
          });
        } },
      });
      assert.equal(response.status, 200);
      assert.equal(new URL(forwarded.url).pathname,
        "/internal/v1/tenants/tenant-a/water-quality-criteria/criteria-1/1.0/" + action);
      assert.equal(forwarded.method, "POST");
      assert.equal(await forwarded.text(), payload);
      assert.equal(forwarded.headers.get("x-nova-verified-subject"), "criteria-reader");
    }
  } finally { globalThis.fetch = oldFetch; }
});

test("rejects malformed criteria selectors and query-string expansion", async () => {
  const env = { TENANT_API: { fetch: async () => { throw new Error("must not reach upstream"); } },
    ACCESS_ISSUER: "https://example.cloudflareaccess.com", ACCESS_AUDIENCE: "aud" };
  for (const path of [
    "/api/v1/tenants/tenant-a/water-quality-criteria?tenant=tenant-b",
    "/api/v1/tenants/tenant-a/water-quality-criteria/../1.0",
    "/api/v1/tenants/tenant-a/water-quality-criteria/criteria-1/1.0?site=site-b",
  ]) {
    const response = await worker.fetch(new Request("https://gateway.test" + path), env);
    assert.equal(response.status, 404);
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.mjs";
import { createPublicKey, generateKeyPairSync, sign, webcrypto } from "node:crypto";
globalThis.crypto ??= webcrypto;

function env(overrides = {}) {
  return { ACCESS_ISSUER: "https://example.cloudflareaccess.com", ACCESS_AUDIENCE: "aud",
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
  const jwk = createPublicKey(publicKey).export({ format: "jwk" });
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
      { ACCESS_ISSUER: issuer, ACCESS_AUDIENCE: audience,
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
  } finally { globalThis.fetch = oldFetch; }
});

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.mjs";

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

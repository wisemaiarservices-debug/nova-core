import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createHmac, createPrivateKey, randomUUID, sign } from "node:crypto";
import { readFile } from "node:fs/promises";

const base = "http://127.0.0.1:8787";
const secret = "local-ci-only-secret-not-for-any-deployment";
const issuer = "https://nova-ci.cloudflareaccess.com";
const audience = "nova-ci-test-audience";
const privateKey = createPrivateKey(await readFile("../tenant-gateway/test/fixtures/nova-local-ci-private.pem"));
const child = spawn("npx", ["--yes", "wrangler@4.13.2", "dev", "--local",
  "-c", "../tenant-gateway/wrangler.local-test.toml",
  "-c", "wrangler.d1-test.toml",
  "--ip", "127.0.0.1", "--port", "8787",
  "--persist-to", "./.wrangler-d1-test"], { stdio: "ignore" });

function b64url(value) { return Buffer.from(value).toString("base64url"); }
function accessToken(subject = "ci-human-subject") {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "nova-local-ci-key" }));
  const claims = b64url(JSON.stringify({ iss: issuer, aud: [audience], sub: subject, iat: now - 2, exp: now + 300 }));
  const input = head + "." + claims;
  return input + "." + sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url");
}
async function throughGateway(path, token = accessToken(), extraHeaders = {}) {
  const response = await fetch(base + path, {
    method: "GET", headers: { "Cf-Access-Jwt-Assertion": token, ...extraHeaders },
  });
  return { response, body: await response.json() };
}
async function ready() {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error("Wrangler multi-Worker local runtime exited before readiness");
    try {
      const result = await fetch(base + "/not-a-route");
      if (result.status === 404) return;
    } catch {}
    await delay(500);
  }
  throw new Error("Wrangler multi-Worker local runtime did not become ready");
}
try {
  await ready();
  const sitePath = "/api/v1/tenants/tenant-http-a/sites/site-http-a";
  const allowed = await throughGateway(sitePath);
  assert.equal(allowed.response.status, 200, JSON.stringify(allowed.body));
  assert.equal(allowed.body.data.id, "site-http-a");
  assert.equal(allowed.body.data.tenant_id, "tenant-http-a");

  const deniedGrant = await throughGateway("/api/v1/tenants/tenant-http-a/sites/site-http-b");
  assert.equal(deniedGrant.response.status, 404);

  const deniedTenant = await throughGateway("/api/v1/tenants/tenant-http-b/sites/site-http-b");
  assert.equal(deniedTenant.response.status, 404);

  const invalidIdentity = await throughGateway(sitePath, "not.a.valid.jwt");
  assert.equal(invalidIdentity.response.status, 401);

  const forgedHeaders = await throughGateway(sitePath, accessToken(), {
    "x-nova-verified-subject": "attacker-subject",
    "x-nova-verified-issuer": "https://attacker.example",
    cookie: "session=must-not-cross-trust-boundary",
  });
  assert.equal(forgedHeaders.response.status, 200);
  assert.equal(forgedHeaders.body.data.id, "site-http-a");

  console.log("Wrangler multi-Worker Service Binding + local D1 integration passed: signed RS256 JWT via test-only JWKS fixture, actual gateway-to-private-Worker Service Binding, authorized read, missing grant, cross-tenant denial, invalid JWT rejection, caller trust-header/cookie isolation");
} finally {
  child.kill("SIGTERM");
  await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(5000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

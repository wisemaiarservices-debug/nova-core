import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createHmac, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import gateway from "../../tenant-gateway/src/index.mjs";

const base = "http://127.0.0.1:8787";
const secret = "local-ci-only-secret-not-for-any-deployment";
const issuer = "https://nova-ci.cloudflareaccess.com";
const audience = "nova-ci-test-audience";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "local-ci-access-key", use: "sig", alg: "RS256" };
const originalFetch = globalThis.fetch;
const child = spawn("npx", ["--yes", "wrangler@4.13.2", "dev", "--local",
  "--config", "wrangler.d1-test.toml", "--ip", "127.0.0.1", "--port", "8787",
  "--persist-to", "./.wrangler-d1-test"], { stdio: "ignore" });

function b64url(value) { return Buffer.from(value).toString("base64url"); }
function accessToken(subject = "ci-human-subject") {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: jwk.kid }));
  const claims = b64url(JSON.stringify({ iss: issuer, aud: [audience], sub: subject, iat: now - 2, exp: now + 300 }));
  const input = head + "." + claims;
  return input + "." + sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url");
}
function signedHeaders(path, requestId = randomUUID(), subject = "ci-human-subject") {
  const issuedAt = String(Math.floor(Date.now() / 1000));
  const values = ["GET", path, subject, issuer, audience, issuedAt, requestId];
  const signature = createHmac("sha256", secret).update(JSON.stringify(values)).digest("hex");
  return { requestId, headers: {
    "x-nova-verified-subject": subject,
    "x-nova-verified-issuer": issuer,
    "x-nova-verified-audience": audience,
    "x-nova-gateway-issued-at": issuedAt,
    "x-nova-request-id": requestId,
    "x-nova-internal-signature": signature,
  }};
}
async function privateApiRequest(path, signed = signedHeaders(path)) {
  const response = await originalFetch(base + path, { headers: signed.headers });
  return { response, body: await response.json() };
}
async function ready() {
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error("Wrangler local Worker exited before readiness");
    try {
      const result = await originalFetch(base + "/not-a-route");
      if (result.status === 404) return;
    } catch {}
    await delay(500);
  }
  throw new Error("Wrangler local Worker did not become ready");
}
try {
  await ready();

  // Drive the real Access gateway module. Its Service Binding is represented by
  // a local HTTP bridge to the real Wrangler-hosted private API Worker + D1.
  globalThis.fetch = async (input, init) => {
    if (String(input) === issuer + "/cdn-cgi/access/certs") {
      return new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return originalFetch(input, init);
  };
  const gatewayEnv = {
    ACCESS_ISSUER: issuer,
    ACCESS_AUDIENCE: audience,
    INTERNAL_AUTH_SECRET: secret,
    TENANT_API: {
      fetch: request => originalFetch(base + new URL(request.url).pathname, {
        method: request.method, headers: request.headers,
      }),
    },
  };
  async function throughGateway(path, token = accessToken(), extraHeaders = {}) {
    const request = new Request("https://gateway.local" + path, {
      method: "GET", headers: { "Cf-Access-Jwt-Assertion": token, ...extraHeaders },
    });
    const response = await gateway.fetch(request, gatewayEnv);
    return { response, body: await response.json() };
  }

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

  // Verify the private Worker independently rejects replayed HMAC envelopes
  // and forged identity headers, even if a caller bypasses the gateway boundary.
  const internalPath = "/internal/v1/tenants/tenant-http-a/sites/site-http-a";
  const replayEnvelope = signedHeaders(internalPath);
  const firstUse = await privateApiRequest(internalPath, replayEnvelope);
  const replay = await privateApiRequest(internalPath, replayEnvelope);
  assert.equal(firstUse.response.status, 200);
  assert.equal(replay.response.status, 401);

  const tampered = signedHeaders(internalPath);
  tampered.headers["x-nova-verified-subject"] = "attacker-subject";
  const forged = await privateApiRequest(internalPath, tampered);
  assert.equal(forged.response.status, 401);

  console.log("Gateway-to-private-Worker + local D1 integration passed: signed Access JWT, HMAC Service Binding envelope, authorized read, missing grant, cross-tenant denial, invalid JWT rejection, nonce replay rejection, forged envelope rejection");
} finally {
  globalThis.fetch = originalFetch;
  child.kill("SIGTERM");
  await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(5000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

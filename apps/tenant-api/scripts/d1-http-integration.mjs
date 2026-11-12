import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createHmac, randomUUID } from "node:crypto";

const base = "http://127.0.0.1:8787";
const secret = "local-ci-only-secret-not-for-any-deployment";
const issuer = "https://nova-ci.cloudflareaccess.com";
const audience = "nova-ci-test-audience";
const child = spawn("npx", ["--yes", "wrangler@4.13.2", "dev", "--local",
  "--config", "wrangler.d1-test.toml", "--ip", "127.0.0.1", "--port", "8787",
  "--persist-to", "./.wrangler-d1-test"], { stdio: "ignore" });

function signedHeaders(path, requestId = randomUUID()) {
  const issuedAt = String(Math.floor(Date.now() / 1000));
  const values = ["GET", path, "ci-human-subject", issuer, audience, issuedAt, requestId];
  const canonical = JSON.stringify(values);
  const signature = createHmac("sha256", secret).update(canonical).digest("hex");
  return { requestId, headers: {
    "x-nova-verified-subject": "ci-human-subject",
    "x-nova-verified-issuer": issuer,
    "x-nova-verified-audience": audience,
    "x-nova-gateway-issued-at": issuedAt,
    "x-nova-request-id": requestId,
    "x-nova-internal-signature": signature,
  }};
}
async function request(path, signed = signedHeaders(path)) {
  const response = await fetch(base + path, { headers: signed.headers });
  return { response, body: await response.json() };
}
async function ready() {
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error("Wrangler local Worker exited before readiness");
    try {
      const result = await fetch(base + "/not-a-route");
      if (result.status === 404) return;
    } catch {}
    await delay(500);
  }
  throw new Error("Wrangler local Worker did not become ready");
}
try {
  await ready();
  const sitePath = "/internal/v1/tenants/tenant-http-a/sites/site-http-a";

  const allowed = await request(sitePath);
  assert.equal(allowed.response.status, 200, JSON.stringify(allowed.body));
  assert.equal(allowed.body.data.id, "site-http-a");
  assert.equal(allowed.body.data.tenant_id, "tenant-http-a");

  const deniedGrant = await request("/internal/v1/tenants/tenant-http-a/sites/site-http-b");
  assert.equal(deniedGrant.response.status, 404);

  const deniedTenant = await request("/internal/v1/tenants/tenant-http-b/sites/site-http-b");
  assert.equal(deniedTenant.response.status, 404);

  const replayEnvelope = signedHeaders(sitePath);
  const firstUse = await request(sitePath, replayEnvelope);
  const replay = await request(sitePath, replayEnvelope);
  assert.equal(firstUse.response.status, 200);
  assert.equal(replay.response.status, 401);

  const tampered = signedHeaders(sitePath);
  tampered.headers["x-nova-verified-subject"] = "attacker-subject";
  const forged = await request(sitePath, tampered);
  assert.equal(forged.response.status, 401);

  console.log("D1 HTTP integration passed: authorized read, missing grant, cross-tenant denial, replay rejection, forged envelope rejection");
} finally {
  child.kill("SIGTERM");
  await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(5000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

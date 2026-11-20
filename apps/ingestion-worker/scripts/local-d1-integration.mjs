import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

const base = "http://127.0.0.1:8788";
const issuer = "https://ci-ingestion.cloudflareaccess.com";
const audience = "nova-ingestion-local-d1-audience";
const serviceId = "neoagro-ingestion-service";
const keyId = "nova-ingestion-local-d1-key";
const persistTo = "../tenant-api/.wrangler-d1-test";

function b64url(value) {
  return Buffer.from(value).toString("base64url");
}

function createSignedAccessFixture() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const jwk = createPublicKey(publicKey).export({ format: "jwk" });
  Object.assign(jwk, { kid: keyId, use: "sig", alg: "RS256" });
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: keyId }));
  const claims = b64url(JSON.stringify({
    iss: issuer,
    aud: [audience],
    type: "app",
    sub: "",
    common_name: serviceId,
    service_token_status: true,
    iat: now - 5,
    exp: now + 300,
    jti: "nova-ingestion-local-d1-" + now,
  }));
  const signingInput = header + "." + claims;
  const token = signingInput + "." + sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url");
  return { token, jwks: JSON.stringify({ keys: [jwk] }) };
}

const fixture = createSignedAccessFixture();
const child = spawn("npx", [
  "--yes", "wrangler@4.13.2", "dev", "--local",
  "--config", "wrangler.local-d1-test.toml", "--ip", "127.0.0.1", "--port", "8788",
  "--persist-to", persistTo, "--var", "CI_TEST_JWKS_JSON:" + fixture.jwks,
], { stdio: "ignore" });

async function ready() {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error("Local ingestion Worker exited before readiness");
    try {
      const response = await fetch(base + "/not-a-route");
      if (response.status === 404) return;
    } catch {}
    await delay(500);
  }
  throw new Error("Local ingestion Worker did not become ready");
}

async function submit(observation, extraHeaders = {}) {
  const response = await fetch(base + "/api/v1/observations", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Cf-Access-Jwt-Assertion": fixture.token,
      ...extraHeaders,
    },
    body: JSON.stringify(observation),
  });
  return { response, body: await response.json() };
}

async function state(source, key) {
  const response = await fetch(base + "/__ci/ingestion/state?source=" +
    encodeURIComponent(source) + "&key=" + encodeURIComponent(key));
  assert.equal(response.status, 200);
  return response.json();
}

function observation(overrides = {}) {
  return {
    site_id: "site-http-a",
    asset_id: "asset-http-grant",
    module: "neoagro",
    source_id: "source-http-grant",
    metric: "soil_moisture",
    value: 0.24,
    unit: "m3/m3",
    observed_at: new Date(Date.now() - 60_000).toISOString(),
    idempotency_key: "ci-authenticated-local-d1-retry-001",
    provenance: { provider: "CI synthetic station", acquisition_method: "sensor" },
    quality_flags: [],
    ...overrides,
  };
}

try {
  await ready();

  // The same production handler verifies RS256/JWKS, issuer, audience,
  // service identity and exact source grant before touching the real local D1.
  const firstPayload = observation();
  const first = await submit(firstPayload, {\n    "x-tenant-id": "tenant-http-b",\n    "x-service-id": "untrusted-caller-service",\n    "x-authenticated-subject": "spoofed-subject",\n    cookie: "session=untrusted-caller-cookie",\n  });
  assert.equal(first.response.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.status, "accepted");
  assert.equal(first.body.accepted, true);
  assert.equal(first.body.verification_status, "unverified");

  const persisted = await state(firstPayload.source_id, firstPayload.idempotency_key);
  assert.equal(persisted.observation.id, first.body.observation_id);
  assert.equal(persisted.observation.tenant_id, "tenant-http-a");
  assert.equal(persisted.observation.site_id, "site-http-a");
  assert.equal(persisted.observation.verification_status, "unverified");
  assert.equal(persisted.audit.length, 1);
  assert.equal(persisted.audit[0].tenant_id, "tenant-http-a");
  assert.equal(persisted.audit[0].actor_id, serviceId);

  const retry = await submit(firstPayload);
  assert.equal(retry.response.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.status, "already_accepted");
  assert.equal(retry.body.idempotent, true);
  assert.equal(retry.body.observation_id, first.body.observation_id);
  assert.equal((await state(firstPayload.source_id, firstPayload.idempotency_key)).audit.length, 1);

  const conflictPayload = observation({ value: 0.25 });
  const conflict = await submit(conflictPayload);
  assert.equal(conflict.response.status, 409, JSON.stringify(conflict.body));
  assert.equal(conflict.body.accepted, false);
  const afterConflict = await state(firstPayload.source_id, firstPayload.idempotency_key);
  assert.equal(afterConflict.observation.value, 0.24);
  assert.equal(afterConflict.audit.length, 1);

  const invalidSignaturePayload = observation({\n    idempotency_key: "ci-authenticated-local-d1-invalid-signature-001",\n  });\n  const tokenParts = fixture.token.split(".");\n  tokenParts[2] = (tokenParts[2][0] === "A" ? "B" : "A") + tokenParts[2].slice(1);\n  const invalidSignature = await submit(invalidSignaturePayload, {\n    "Cf-Access-Jwt-Assertion": tokenParts.join("."),\n  });\n  assert.equal(invalidSignature.response.status, 401);\n  assert.equal((await state(invalidSignaturePayload.source_id, invalidSignaturePayload.idempotency_key)).observation, null);\n\n  const deniedGrantPayload = observation({
    source_id: "source-http-a",
    idempotency_key: "ci-authenticated-local-d1-wrong-grant-001",
  });
  const deniedGrant = await submit(deniedGrantPayload);
  assert.equal(deniedGrant.response.status, 403);
  assert.equal((await state(deniedGrantPayload.source_id, deniedGrantPayload.idempotency_key)).observation, null);

  const crossTenantPayload = observation({
    site_id: "site-http-b",
    asset_id: null,
    idempotency_key: "ci-authenticated-local-d1-cross-tenant-001",
  });
  const deniedTenant = await submit(crossTenantPayload);
  assert.equal(deniedTenant.response.status, 403);
  assert.equal((await state(crossTenantPayload.source_id, crossTenantPayload.idempotency_key)).observation, null);

  const crossTenantAssetPayload = observation({
    asset_id: "asset-http-b",
    idempotency_key: "ci-authenticated-local-d1-cross-asset-001",
  });
  const deniedAsset = await submit(crossTenantAssetPayload);
  assert.equal(deniedAsset.response.status, 403);
  assert.equal((await state(crossTenantAssetPayload.source_id, crossTenantAssetPayload.idempotency_key)).observation, null);

  const auditFailurePayload = observation({
    idempotency_key: "ci-authenticated-local-d1-audit-failure-001",
  });
  const auditFailure = await submit(auditFailurePayload, { "x-ci-request-id": "req-fail" });
  assert.equal(auditFailure.response.status, 503, JSON.stringify(auditFailure.body));
  assert.equal(auditFailure.body.accepted, false);
  const rolledBack = await state(auditFailurePayload.source_id, auditFailurePayload.idempotency_key);
  assert.equal(rolledBack.observation, null, "failed audit must roll back the observation insert");
  assert.equal(rolledBack.audit.length, 0);\n\n  console.log("Authenticated ingestion-to-local-D1 integration passed: RS256/JWKS, exact service grant, spoofed-header isolation, tenant ownership, acceptance, retry, conflict and audit rollback");
} finally {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
}

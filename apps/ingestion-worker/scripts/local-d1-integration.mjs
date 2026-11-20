import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

const base = "http://127.0.0.1:8788";
const persistTo = "../tenant-api/.wrangler-d1-test";
const child = spawn("npx", ["--yes", "wrangler@4.13.2", "dev", "--local",
  "--config", "wrangler.local-d1-test.toml", "--ip", "127.0.0.1", "--port", "8788",
  "--persist-to", persistTo], { stdio: "ignore" });

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
async function submit(observation, request_id = "ci-local-ingestion") {
  const response = await fetch(base + "/__ci/ingestion/accept", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ observation, request_id }),
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
    site_id: "site-http-a", asset_id: "asset-http-grant", module: "neoagro",
    source_id: "source-http-grant", metric: "soil_moisture", value: 0.24,
    unit: "m3/m3", observed_at: "2026-11-19T10:00:00.000Z",
    idempotency_key: "ci-real-d1-ingestion-retry-001",
    provenance: { provider: "CI synthetic station", acquisition_method: "sensor" },
    quality_flags: [],
    ...overrides,
  };
}
try {
  await ready();

  const firstPayload = observation();
  const first = await submit(firstPayload);
  assert.equal(first.response.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.status, "accepted");
  assert.equal(first.body.verification_status, "unverified");

  const retry = await submit(firstPayload);
  assert.equal(retry.response.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.status, "already_accepted");
  assert.equal(retry.body.observation_id, first.body.observation_id);

  const persisted = await state(firstPayload.source_id, firstPayload.idempotency_key);
  assert.equal(persisted.observation.id, first.body.observation_id);
  assert.equal(persisted.observation.tenant_id, "tenant-http-a");
  assert.equal(persisted.observation.site_id, "site-http-a");
  assert.equal(persisted.observation.verification_status, "unverified");
  assert.equal(persisted.audit.length, 1);
  assert.equal(persisted.audit[0].tenant_id, "tenant-http-a");

  const conflictPayload = observation({ value: 0.25 });
  const conflict = await submit(conflictPayload);
  assert.equal(conflict.response.status, 409, JSON.stringify(conflict.body));
  assert.equal(conflict.body.accepted, false);
  const afterConflict = await state(firstPayload.source_id, firstPayload.idempotency_key);
  assert.equal(afterConflict.observation.value, 0.24);
  assert.equal(afterConflict.audit.length, 1);

  const crossTenant = observation({
    site_id: "site-http-b", asset_id: null,
    idempotency_key: "ci-real-d1-cross-tenant-001",
  });
  const deniedTenant = await submit(crossTenant);
  assert.equal(deniedTenant.response.status, 403);
  assert.equal((await state(crossTenant.source_id, crossTenant.idempotency_key)).observation, null);

  const crossTenantAsset = observation({
    asset_id: "asset-http-b", idempotency_key: "ci-real-d1-cross-asset-001",
  });
  const deniedAsset = await submit(crossTenantAsset);
  assert.equal(deniedAsset.response.status, 403);
  assert.equal((await state(crossTenantAsset.source_id, crossTenantAsset.idempotency_key)).observation, null);

  const auditFailurePayload = observation({
    idempotency_key: "ci-real-d1-audit-failure-001",
  });
  const auditFailure = await submit(auditFailurePayload, "req-fail");
  assert.equal(auditFailure.response.status, 503, JSON.stringify(auditFailure.body));
  assert.equal(auditFailure.body.accepted, false);
  const rolledBack = await state(auditFailurePayload.source_id, auditFailurePayload.idempotency_key);
  assert.equal(rolledBack.observation, null, "failed audit must roll back observation insert");
  assert.equal(rolledBack.audit.length, 0);
} finally {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
}

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.mjs";

test("health identifies the separate ingestion Worker and disabled state", async () => {
  const response = await worker.fetch(new Request("https://ingest.example/health"), {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.service, "nova-core-ingest-api");
  assert.equal(body.mode, "authenticated-ingestion-disabled");
});

test("observation route fails closed when server auth configuration is absent", async () => {
  const response = await worker.fetch(new Request("https://ingest.example/api/v1/observations", {
    method: "POST",
    body: JSON.stringify({ module: "neoagro", source_id: "source-1" }),
  }), {});
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "ingestion_auth_not_configured" });
});

test("oversized declared payload is rejected before authentication or body parsing", async () => {
  const response = await worker.fetch(new Request("https://ingest.example/api/v1/observations", {
    method: "POST",
    headers: { "content-length": String(32 * 1024 + 1) },
    body: "{}",
  }), {});
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "payload_too_large" });
});

test("observation route rejects absent Access JWT", async () => {
  const response = await worker.fetch(new Request("https://ingest.example/api/v1/observations", {
    method: "POST",
    body: JSON.stringify({ module: "neoagro", source_id: "source-1" }),
  }), {
    ACCESS_ISSUER: "https://example.cloudflareaccess.com",
    ACCESS_AUDIENCE: "nova-ingestion-audience",
    NOVA_SERVICE_GRANTS_JSON: '{"neoagro-ingestor":{"neoagro":["source-1"]}}',
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "request_not_authorized" });
});

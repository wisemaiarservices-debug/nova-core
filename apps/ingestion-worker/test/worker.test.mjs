import test from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, sign, webcrypto } from "node:crypto";
import worker from "../src/index.mjs";

globalThis.crypto ??= webcrypto;
const originalFetch = globalThis.fetch;

function b64url(value) {
  return Buffer.from(value).toString("base64url");
}

function makeAccessFixture(issuer) {
  const audience = "nova-ingestion-audience";
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const jwk = createPublicKey(publicKey).export({ format: "jwk" });
  Object.assign(jwk, { kid: "worker-route-test-key", use: "sig", alg: "RS256" });
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: jwk.kid }));
  const claims = b64url(JSON.stringify({
    iss: issuer,
    aud: [audience],
    type: "app",
    sub: "",
    common_name: "neoagro-ingestor",
    iat: now - 5,
    exp: now + 300,
    jti: "worker-route-test",
  }));
  const input = header + "." + claims;
  const token = input + "." + sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url");
  return { audience, token, jwk };
}


function ownershipDb({ siteStatus = "active", sourceSiteId = "site-001", sourceModule = "neoagro",
  sourceStatus = "unverified", assetSiteId = "site-001", assetStatus = "active" } = {}) {
  const state = { observation: null, audit: [] };
  return {
    state,
    prepare(sql) {
      return {
        sql,
        values: [],
        bind(...values) { this.values = values; return this; },
        async first() {
          if (sql.includes("FROM sites")) return { id: this.values[0], status: siteStatus, tenant_id: "tenant-a", tenant_status: "active" };
          if (sql.includes("FROM sources")) return {
            id: this.values[0], site_id: sourceSiteId, module: sourceModule,
            verification_status: sourceStatus, tenant_id: "tenant-a",
          };
          if (sql.includes("FROM assets")) return {
            id: this.values[0], site_id: assetSiteId, status: assetStatus, tenant_id: "tenant-a",
          };
          if (sql.includes("FROM observations WHERE source_id")) return state.observation;
          throw new Error("unexpected_query");
        },
      };
    },
    async batch(statements) {
      assert.equal(statements.length, 2);
      const v = statements[0].values;
      let inserted = false;
      if (!state.observation) {
        state.observation = {
          id: v[0], site_id: v[1], asset_id: v[2], source_id: v[3],
          module: v[4], metric: v[5], value: v[6], unit: v[7],
          observed_at: v[8], idempotency_key: v[9],
          verification_status: "unverified", provenance_json: v[10],
          quality_flags_json: v[11],
        };
        state.audit.push({ id: statements[1].values[0], actor_id: statements[1].values[1] });
        inserted = true;
      }
      return [{ success: true, meta: { changes: inserted ? 1 : 0 } }, { success: true }];
    },
  };
}

function envFor(issuer, audience, grants = '{"neoagro-ingestor":{"neoagro":["source-weather-01"]}}') {
  return {
    ACCESS_ISSUER: issuer,
    ACCESS_AUDIENCE: audience,
    NOVA_SERVICE_GRANTS_JSON: grants,
  };
}

test.after(() => {
  globalThis.fetch = originalFetch;
});

test("health identifies the separate ingestion Worker and disabled state", async () => {
  const response = await worker.fetch(new Request("https://ingest.example/health"), {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.service, "nova-core-ingest-api");
  assert.equal(body.mode, "guarded-auth-required");
});

test("observation route fails closed when server auth configuration is absent", async () => {
  const response = await worker.fetch(new Request("https://ingest.example/api/v1/observations", {
    method: "POST",
    body: JSON.stringify({ module: "neoagro", source_id: "source-weather-01" }),
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
  const issuer = "https://missing-token.cloudflareaccess.com";
  const response = await worker.fetch(new Request("https://ingest.example/api/v1/observations", {
    method: "POST",
    body: JSON.stringify({ module: "neoagro", source_id: "source-weather-01" }),
  }), envFor(issuer, "nova-ingestion-audience"));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "request_not_authorized" });
});

test("valid Access service identity and exact source grant reach the storage gate but are not accepted", async () => {
  const issuer = "https://valid-route.cloudflareaccess.com";
  const fixture = makeAccessFixture(issuer);
  globalThis.fetch = async (url) => {
    assert.equal(String(url), issuer + "/cdn-cgi/access/certs");
    return new Response(JSON.stringify({ keys: [fixture.jwk] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const response = await worker.fetch(new Request("https://ingest.example/api/v1/observations", {
    method: "POST",
    headers: { "Cf-Access-Jwt-Assertion": fixture.token, "content-type": "application/json" },
    body: JSON.stringify({
      site_id: "site-001",
      asset_id: "asset-001",
      module: "neoagro",
      source_id: "source-weather-01",
      metric: "air_temperature",
      value: 18.5,
      unit: "degC",
      observed_at: new Date().toISOString(),
      idempotency_key: "test-observation-001",
      provenance: { provider: "test station", acquisition_method: "sensor" },
      quality_flags: [],
    }),
  }), envFor(issuer, fixture.audience));

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "storage_not_configured",
    status: "authenticated_but_not_accepted",
  });
});


test("valid service identity and D1 ownership checks persist an unverified observation and audit event", async () => {
  const issuer = "https://owned-records.cloudflareaccess.com";
  const fixture = makeAccessFixture(issuer);
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [fixture.jwk] }), {
    status: 200, headers: { "content-type": "application/json" },
  });
  const response = await worker.fetch(new Request("https://ingest.example/api/v1/observations", {
    method: "POST",
    headers: { "Cf-Access-Jwt-Assertion": fixture.token, "content-type": "application/json" },
    body: JSON.stringify({
      site_id: "site-001", asset_id: "asset-001", module: "neoagro",
      source_id: "source-weather-01", metric: "air_temperature", value: 18.5,
      unit: "degC", observed_at: new Date().toISOString(),
      idempotency_key: "test-observation-owned-001",
      provenance: { provider: "test station", acquisition_method: "sensor" },
    }),
  }), { ...envFor(issuer, fixture.audience), DB: ownershipDb() });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.status, "accepted");
  assert.equal(body.accepted, true);
  assert.equal(body.verification_status, "unverified");
  assert.equal(body.idempotent, false);
  assert.equal(body.verification_status, "unverified");
});

test("D1 ownership mismatch is denied without revealing which record failed", async () => {
  const issuer = "https://ownership-denied.cloudflareaccess.com";
  const fixture = makeAccessFixture(issuer);
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [fixture.jwk] }), {
    status: 200, headers: { "content-type": "application/json" },
  });
  const response = await worker.fetch(new Request("https://ingest.example/api/v1/observations", {
    method: "POST",
    headers: { "Cf-Access-Jwt-Assertion": fixture.token, "content-type": "application/json" },
    body: JSON.stringify({
      site_id: "site-001", asset_id: "asset-001", module: "neoagro",
      source_id: "source-weather-01", metric: "air_temperature", value: 18.5,
      unit: "degC", observed_at: new Date().toISOString(),
      idempotency_key: "test-observation-owned-002",
      provenance: { provider: "test station", acquisition_method: "sensor" },
    }),
  }), { ...envFor(issuer, fixture.audience), DB: ownershipDb({ assetSiteId: "site-elsewhere" }) });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "request_not_authorized" });
});

test("valid service identity cannot submit a source outside its exact grant", async () => {
  const issuer = "https://wrong-grant.cloudflareaccess.com";
  const fixture = makeAccessFixture(issuer);
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [fixture.jwk] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

  const response = await worker.fetch(new Request("https://ingest.example/api/v1/observations", {
    method: "POST",
    headers: { "Cf-Access-Jwt-Assertion": fixture.token, "content-type": "application/json" },
    body: JSON.stringify({
      site_id: "site-001", module: "neoagro", source_id: "source-unapproved",
      metric: "air_temperature", value: 18.5, unit: "degC",
      observed_at: new Date().toISOString(), idempotency_key: "test-observation-002",
      provenance: { provider: "test station", acquisition_method: "sensor" },
    }),
  }), envFor(issuer, fixture.audience));

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "request_not_authorized" });
});

test("JWKS outage fails closed with a service-unavailable response", async () => {
  const issuer = "https://jwks-outage.cloudflareaccess.com";
  const fixture = makeAccessFixture(issuer);
  globalThis.fetch = async () => new Response("unavailable", { status: 503 });

  const response = await worker.fetch(new Request("https://ingest.example/api/v1/observations", {
    method: "POST",
    headers: { "Cf-Access-Jwt-Assertion": fixture.token, "content-type": "application/json" },
    body: JSON.stringify({ module: "neoagro", source_id: "source-weather-01" }),
  }), envFor(issuer, fixture.audience));

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "identity_provider_unavailable" });
});

test("invalid server-side source grants are reported as configuration failures", async () => {
  const issuer = "https://invalid-grants.cloudflareaccess.com";
  const response = await worker.fetch(new Request("https://ingest.example/api/v1/observations", {
    method: "POST",
    body: JSON.stringify({ module: "neoagro", source_id: "source-weather-01" }),
  }), envFor(issuer, "nova-ingestion-audience", '{"neoagro-ingestor":{"neoagro":["*"]}}'));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "ingestion_configuration_invalid" });
});


test("authenticated request rejects non-JSON media types", async () => {
  const issuer = "https://wrong-media-type.cloudflareaccess.com";
  const fixture = makeAccessFixture(issuer);
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [fixture.jwk] }), {
    status: 200, headers: { "content-type": "application/json" },
  });
  const response = await worker.fetch(new Request("https://ingest.example/api/v1/observations", {
    method: "POST",
    headers: { "Cf-Access-Jwt-Assertion": fixture.token, "content-type": "text/plain" },
    body: "{}",
  }), envFor(issuer, fixture.audience));
  assert.equal(response.status, 415);
  assert.deepEqual(await response.json(), { error: "application_json_required" });
});

test("authenticated request rejects incomplete observation fields before storage", async () => {
  const issuer = "https://incomplete-payload.cloudflareaccess.com";
  const fixture = makeAccessFixture(issuer);
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [fixture.jwk] }), {
    status: 200, headers: { "content-type": "application/json" },
  });
  const response = await worker.fetch(new Request("https://ingest.example/api/v1/observations", {
    method: "POST",
    headers: { "Cf-Access-Jwt-Assertion": fixture.token, "content-type": "application/json" },
    body: JSON.stringify({ module: "neoagro", source_id: "source-weather-01" }),
  }), envFor(issuer, fixture.audience));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_observation_payload" });
});
test("valid service token with malformed JSON is rejected before storage", async () => {
  const issuer = "https://malformed-body.cloudflareaccess.com";
  const fixture = makeAccessFixture(issuer);
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [fixture.jwk] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

  const response = await worker.fetch(new Request("https://ingest.example/api/v1/observations", {
    method: "POST",
    headers: { "Cf-Access-Jwt-Assertion": fixture.token, "content-type": "application/json" },
    body: "{not-json",
  }), envFor(issuer, fixture.audience));

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_json" });
});

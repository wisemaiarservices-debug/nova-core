import test from "node:test";
import assert from "node:assert/strict";
import worker, { createGateway } from "../src/index.mjs";
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

test("routes site-scoped observation reviewer assignment and verification through the signed private API", async () => {
  const calls = [];
  const gateway = createGateway({ verifyAccessToken: async token => ({
    subject: token, issuer: "https://example.cloudflareaccess.com", audience: "aud",
  }) });
  for (const [publicPath, internalPath, subject, payload] of [
    ["/api/v1/tenants/tenant-a/observations/reviewers/assign",
      "/internal/v1/tenants/tenant-a/observations/reviewers/assign", "tenant-admin",
      { site_id: "site-a", reviewer_subject: "reviewer-a", evidence_ref: "appointment:1" }],
    ["/api/v1/tenants/tenant-a/observations/reviewers/revoke",
      "/internal/v1/tenants/tenant-a/observations/reviewers/revoke", "tenant-admin",
      { site_id: "site-a", reviewer_subject: "reviewer-a", evidence_ref: "appointment:2", reason: "Appointment ended" }],
    ["/api/v1/tenants/tenant-a/observations/obs-1/verification",
      "/internal/v1/tenants/tenant-a/observations/obs-1/verification", "reviewer-a",
      { decision: "verify", evidence_ref: "inspection:1" }],
  ]) {
    const body = JSON.stringify(payload);
    const response = await gateway.fetch(new Request("https://gateway.test" + publicPath, {
      method: "POST", body, headers: { "content-type": "application/json", "Cf-Access-Jwt-Assertion": subject },
    }), {
      ACCESS_ISSUER: "https://example.cloudflareaccess.com", ACCESS_AUDIENCE: "aud",
      INTERNAL_AUTH_SECRET: "test-only-internal-secret-with-32-bytes-minimum",
      TENANT_API: { fetch: async request => {
        calls.push(request);
        return new Response(JSON.stringify({ data: { ok: true } }), {
          status: 201, headers: { "content-type": "application/json" },
        });
      } },
    });
    assert.equal(response.status, 201);
    const forwarded = calls.at(-1);
    assert.equal(new URL(forwarded.url).pathname, internalPath);
    assert.equal(forwarded.method, "POST");
    assert.equal(await forwarded.text(), body);
    assert.equal(forwarded.headers.get("x-nova-verified-subject"), subject);
    assert.match(forwarded.headers.get("x-nova-internal-signature"), /^[a-f0-9]{64}$/);
    assert.equal(forwarded.headers.get("cookie"), null);
  }
  const forbiddenMethod = await gateway.fetch(new Request(
    "https://gateway.test/api/v1/tenants/tenant-a/observations/obs-1/verification",
    { headers: { "Cf-Access-Jwt-Assertion": "reviewer-a" } }), {
    ACCESS_ISSUER: "https://example.cloudflareaccess.com", ACCESS_AUDIENCE: "aud",
    INTERNAL_AUTH_SECRET: "test-only-internal-secret-with-32-bytes-minimum",
    TENANT_API: { fetch: async () => { throw new Error("must not forward GET"); } },
  });
  assert.equal(forbiddenMethod.status, 404);
});


test("routes bounded laboratory report uploads and larger evidence reads through Access", async () => {
  let captured;
  const gateway = createGateway({ verifyAccessToken: async () => ({
    subject: "lab-admin", issuer: "https://example.cloudflareaccess.com", audience: "aud",
  }) });
  const payload = JSON.stringify({ document_base64: "A".repeat(90000) });
  const upload = await gateway.fetch(new Request(
    "https://gateway.test/api/v1/tenants/tenant-a/sites/site-a/laboratory-reports",
    { method: "POST", headers: { "content-type": "application/json", "Cf-Access-Jwt-Assertion": "valid" },
      body: payload }), {
    ACCESS_ISSUER: "https://example.cloudflareaccess.com", ACCESS_AUDIENCE: "aud",
    INTERNAL_AUTH_SECRET: "test-only-internal-secret-with-32-bytes-minimum",
    TENANT_API: { fetch: async request => {
      captured = request;
      return new Response(JSON.stringify({ data: { id: "lab-1" } }), {
        status: 201, headers: { "content-type": "application/json" },
      });
    } },
  });
  assert.equal(upload.status, 201);
  assert.equal(captured.method, "POST");
  assert.equal(new URL(captured.url).pathname,
    "/internal/v1/tenants/tenant-a/sites/site-a/laboratory-reports");
  assert.equal(await captured.text(), payload);

  const largeJson = JSON.stringify({ data: { document_base64: "A".repeat(90000) } });
  const download = await gateway.fetch(new Request(
    "https://gateway.test/api/v1/tenants/tenant-a/sites/site-a/laboratory-reports/lab-1",
    { headers: { "Cf-Access-Jwt-Assertion": "valid" } }), {
    ACCESS_ISSUER: "https://example.cloudflareaccess.com", ACCESS_AUDIENCE: "aud",
    INTERNAL_AUTH_SECRET: "test-only-internal-secret-with-32-bytes-minimum",
    TENANT_API: { fetch: async request => {
      captured = request;
      return new Response(largeJson, { headers: { "content-type": "application/json" } });
    } },
  });
  assert.equal(download.status, 200);
  assert.equal(new URL(captured.url).pathname,
    "/internal/v1/tenants/tenant-a/sites/site-a/laboratory-reports/lab-1");
  assert.equal((await download.json()).data.document_base64.length, 90000);
});


test("handles credentialed CORS preflight only for exact configured origins and safe headers", async () => {
  const gateway = createGateway();
  const configured = env({ CORS_ALLOWED_ORIGINS: "https://nova-os-pied.vercel.app,https://nova-command-center-peach.vercel.app" });
  const response = await gateway.fetch(new Request("https://gateway.test/api/v1/tenants/tenant-a/observations/obs-1/measurement-quality-assessment", {
    method: "OPTIONS",
    headers: {
      Origin: "https://nova-os-pied.vercel.app",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "accept,content-type",
    },
  }), configured);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://nova-os-pied.vercel.app");
  assert.equal(response.headers.get("access-control-allow-credentials"), "true");
  assert.equal(response.headers.get("access-control-allow-methods"), "GET, POST, OPTIONS");
  assert.equal(response.headers.get("access-control-allow-headers"), "Accept, Content-Type");
  assert.match(response.headers.get("vary"), /Origin/);
  assert.match(response.headers.get("vary"), /Access-Control-Request-Method/);

  const deniedOrigin = await gateway.fetch(new Request("https://gateway.test/api/v1/tenants/tenant-a/sites/site-a", {
    method: "OPTIONS",
    headers: { Origin: "https://attacker.example", "Access-Control-Request-Method": "GET" },
  }), configured);
  assert.equal(deniedOrigin.status, 403);
  assert.equal(deniedOrigin.headers.get("access-control-allow-origin"), null);

  const deniedHeader = await gateway.fetch(new Request("https://gateway.test/api/v1/tenants/tenant-a/sites/site-a", {
    method: "OPTIONS",
    headers: { Origin: "https://nova-os-pied.vercel.app",
      "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization" },
  }), configured);
  assert.equal(deniedHeader.status, 403);
});

test("adds exact-origin credentialed CORS headers to successful API responses and exposes request ID", async () => {
  const gateway = createGateway({ verifyAccessToken: async () => ({
    subject: "browser-user", issuer: "https://example.cloudflareaccess.com", audience: "aud",
  }) });
  const response = await gateway.fetch(new Request("https://gateway.test/api/v1/tenants/tenant-a/sites/site-a", {
    headers: { Origin: "https://nova-os-pied.vercel.app", "Cf-Access-Jwt-Assertion": "valid" },
  }), env({
    CORS_ALLOWED_ORIGINS: "https://nova-os-pied.vercel.app",
    TENANT_API: { fetch: async () => new Response(JSON.stringify({ data: { ok: true } }), {
      headers: { "content-type": "application/json" },
    }) },
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://nova-os-pied.vercel.app");
  assert.equal(response.headers.get("access-control-allow-credentials"), "true");
  assert.equal(response.headers.get("access-control-expose-headers"), "X-Request-Id");
  assert.ok(response.headers.get("x-request-id"));
});

test("rejects wildcard and malformed origins in CORS configuration", async () => {
  const gateway = createGateway();
  const response = await gateway.fetch(new Request("https://gateway.test/api/v1/tenants/t/sites/s", {
    method: "OPTIONS",
    headers: { Origin: "https://nova-os-pied.vercel.app", "Access-Control-Request-Method": "GET" },
  }), env({ CORS_ALLOWED_ORIGINS: "*,https://nova-os-pied.vercel.app/path" }));
  assert.equal(response.status, 403);
});


test("routes calibration, sensor identity and quality governance through signed private Core paths", async () => {
  const gateway = createGateway({ verifyAccessToken: async () => ({
    subject: "governance-reviewer", issuer: "https://example.cloudflareaccess.com", audience: "aud",
  }) });
  const cases = [
    ["/api/v1/tenants/tenant-a/sites/site-a/assets/asset-a/calibration-reviewers/assign",
      "/internal/v1/tenants/tenant-a/sites/site-a/assets/asset-a/calibration-reviewers/assign"],
    ["/api/v1/tenants/tenant-a/sites/site-a/assets/asset-a/calibration-reviewers/revoke",
      "/internal/v1/tenants/tenant-a/sites/site-a/assets/asset-a/calibration-reviewers/revoke"],
    ["/api/v1/tenants/tenant-a/sites/site-a/assets/asset-a/calibrations",
      "/internal/v1/tenants/tenant-a/sites/site-a/assets/asset-a/calibrations"],
    ["/api/v1/tenants/tenant-a/sites/site-a/assets/asset-a/calibrations/cal-1/verification",
      "/internal/v1/tenants/tenant-a/sites/site-a/assets/asset-a/calibrations/cal-1/verification"],
    ["/api/v1/tenants/tenant-a/sites/site-a/assets/asset-a/sensor-source-mappings",
      "/internal/v1/tenants/tenant-a/sites/site-a/assets/asset-a/sensor-source-mappings"],
    ["/api/v1/tenants/tenant-a/sites/site-a/assets/asset-a/sensor-source-mappings/map-1/verification",
      "/internal/v1/tenants/tenant-a/sites/site-a/assets/asset-a/sensor-source-mappings/map-1/verification"],
    ["/api/v1/tenants/tenant-a/sites/site-a/sensor-source-mapping-reviewers/assign",
      "/internal/v1/tenants/tenant-a/sites/site-a/sensor-source-mapping-reviewers/assign"],
    ["/api/v1/tenants/tenant-a/sites/site-a/sensor-source-mapping-reviewers/revoke",
      "/internal/v1/tenants/tenant-a/sites/site-a/sensor-source-mapping-reviewers/revoke"],
    ["/api/v1/tenants/tenant-a/sites/site-a/assets/asset-a/measurement-quality-policies",
      "/internal/v1/tenants/tenant-a/sites/site-a/assets/asset-a/measurement-quality-policies"],
    ["/api/v1/tenants/tenant-a/sites/site-a/assets/asset-a/measurement-quality-policies/policy-1/verification",
      "/internal/v1/tenants/tenant-a/sites/site-a/assets/asset-a/measurement-quality-policies/policy-1/verification"],
    ["/api/v1/tenants/tenant-a/observations/obs-1/measurement-quality-assessment",
      "/internal/v1/tenants/tenant-a/observations/obs-1/measurement-quality-assessment"],
  ];
  for (const [publicPath, expectedPath] of cases) {
    let forwarded;
    const payload = JSON.stringify({ evidence_ref: "review-record:1" });
    const response = await gateway.fetch(new Request("https://gateway.test" + publicPath, {
      method: "POST",
      headers: { "content-type": "application/json", "Cf-Access-Jwt-Assertion": "valid", cookie: "browser=session" },
      body: payload,
    }), {
      ACCESS_ISSUER: "https://example.cloudflareaccess.com",
      ACCESS_AUDIENCE: "aud",
      INTERNAL_AUTH_SECRET: "test-only-internal-secret-with-32-bytes-minimum",
      TENANT_API: { fetch: async request => {
        forwarded = request;
        return new Response(JSON.stringify({ data: { ok: true } }), {
          status: 201, headers: { "content-type": "application/json" },
        });
      } },
    });
    assert.equal(response.status, 201, publicPath);
    assert.equal(forwarded.method, "POST", publicPath);
    assert.equal(new URL(forwarded.url).pathname, expectedPath, publicPath);
    assert.equal(await forwarded.text(), payload, publicPath);
    assert.equal(forwarded.headers.get("x-nova-verified-subject"), "governance-reviewer");
    assert.equal(forwarded.headers.get("cookie"), null);
    assert.match(forwarded.headers.get("x-nova-internal-signature"), /^[a-f0-9]{64}$/);
  }
});


test("routes tenant creation only for an exact gateway provisioning allowlist subject", async () => {
  const gateway = createGateway({ verifyAccessToken: async () => ({
    subject: "provisioning-principal", issuer: "https://example.cloudflareaccess.com", audience: "aud",
  }) });
  const payload = JSON.stringify({ display_name: "Research tenant", idempotency_key: "bootstrap-001" });
  let forwarded;
  const configured = {
    ACCESS_ISSUER: "https://example.cloudflareaccess.com",
    ACCESS_AUDIENCE: "aud",
    TENANT_PROVISIONING_SUBJECTS: "provisioning-principal",
    INTERNAL_AUTH_SECRET: "test-only-internal-secret-with-32-bytes-minimum",
    TENANT_API: { fetch: async request => {
      forwarded = request;
      return new Response(JSON.stringify({ data: { tenant_status: "active" } }), {
        status: 201, headers: { "content-type": "application/json" },
      });
    } },
  };
  const response = await gateway.fetch(new Request("https://gateway.test/api/v1/tenants", {
    method: "POST", body: payload,
    headers: { "content-type": "application/json", "Cf-Access-Jwt-Assertion": "valid" },
  }), configured);
  assert.equal(response.status, 201);
  assert.equal(new URL(forwarded.url).pathname, "/internal/v1/tenants");
  assert.equal(forwarded.method, "POST");
  assert.equal(await forwarded.text(), payload);
  assert.equal(forwarded.headers.get("x-nova-verified-subject"), "provisioning-principal");
  assert.match(forwarded.headers.get("x-nova-internal-signature"), /^[a-f0-9]{64}$/);

  let called = false;
  const denied = await gateway.fetch(new Request("https://gateway.test/api/v1/tenants", {
    method: "POST", body: payload,
    headers: { "content-type": "application/json", "Cf-Access-Jwt-Assertion": "valid" },
  }), { ...configured, TENANT_PROVISIONING_SUBJECTS: "someone-else",
    TENANT_API: { fetch: async () => { called = true; throw new Error("must not forward"); } } });
  assert.equal(denied.status, 404);
  assert.equal(called, false);
});


test("routes tenant membership audit reads through the signed private API", async () => {
  const gateway = createGateway({ verifyAccessToken: async () => ({
    subject: "tenant-owner", issuer: "https://example.cloudflareaccess.com", audience: "aud",
  }) });
  let forwarded;
  const response = await gateway.fetch(new Request(
    "https://gateway.test/api/v1/tenants/tenant-a/membership-events",
    { headers: { "Cf-Access-Jwt-Assertion": "valid" } }), {
    ACCESS_ISSUER: "https://example.cloudflareaccess.com",
    ACCESS_AUDIENCE: "aud",
    INTERNAL_AUTH_SECRET: "test-only-internal-secret-with-32-bytes-minimum",
    TENANT_API: { fetch: async request => {
      forwarded = request;
      return new Response(JSON.stringify({ data: [] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    } },
  });
  assert.equal(response.status, 200);
  assert.equal(forwarded.method, "GET");
  assert.equal(new URL(forwarded.url).pathname,
    "/internal/v1/tenants/tenant-a/membership-events");
  assert.equal(forwarded.headers.get("x-nova-verified-subject"), "tenant-owner");
  assert.match(forwarded.headers.get("x-nova-internal-signature"), /^[a-f0-9]{64}$/);
});


test("routes owner-issued membership invitations and authenticated acceptance through signed paths", async () => {
  const gateway = createGateway({ verifyAccessToken: async token => ({
    subject: token === "owner-token" ? "tenant-owner" : "invitee-subject",
    issuer: "https://example.cloudflareaccess.com", audience: "aud",
  }) });
  const cases = [
    ["POST", "/api/v1/tenants/tenant-a/membership-invitations",
      "/internal/v1/tenants/tenant-a/membership-invitations", "owner-token",
      { role: "operator", reason: "Field operations access" }],
    ["POST", "/api/v1/tenants/tenant-a/membership-invitations/invite-1/accept",
      "/internal/v1/tenants/tenant-a/membership-invitations/invite-1/accept", "invitee-token",
      { invitation_token: "A".repeat(43) }],
    ["POST", "/api/v1/tenants/tenant-a/membership-invitations/invite-1/revoke",
      "/internal/v1/tenants/tenant-a/membership-invitations/invite-1/revoke", "owner-token",
      { reason: "Invitation withdrawn" }],
  ];
  for (const [method, publicPath, internalPath, token, payload] of cases) {
    let forwarded;
    const body = JSON.stringify(payload);
    const response = await gateway.fetch(new Request("https://gateway.test" + publicPath, {
      method, body, headers: { "content-type": "application/json", "Cf-Access-Jwt-Assertion": token },
    }), {
      ACCESS_ISSUER: "https://example.cloudflareaccess.com",
      ACCESS_AUDIENCE: "aud",
      INTERNAL_AUTH_SECRET: "test-only-internal-secret-with-32-bytes-minimum",
      TENANT_API: { fetch: async request => {
        forwarded = request;
        return new Response(JSON.stringify({ data: { status: "ok" } }), {
          status: 201, headers: { "content-type": "application/json" },
        });
      } },
    });
    assert.equal(response.status, 201, publicPath);
    assert.equal(forwarded.method, method);
    assert.equal(new URL(forwarded.url).pathname, internalPath);
    assert.equal(await forwarded.text(), body);
    assert.equal(forwarded.headers.get("x-nova-verified-subject"),
      token === "owner-token" ? "tenant-owner" : "invitee-subject");
    assert.match(forwarded.headers.get("x-nova-internal-signature"), /^[a-f0-9]{64}$/);
  }
});


test("routes tenant membership lifecycle actions only through the signed private API", async () => {
  const gateway = createGateway({ verifyAccessToken: async () => ({
    subject: "tenant-owner", issuer: "https://example.cloudflareaccess.com", audience: "aud",
  }) });
  let forwarded;
  const payload = JSON.stringify({ membership_id: "member-1", action: "suspend",
    reason: "Temporary access pause" });
  const response = await gateway.fetch(new Request(
    "https://gateway.test/api/v1/tenants/tenant-a/membership-actions", {
      method: "POST",
      headers: { "content-type": "application/json", "Cf-Access-Jwt-Assertion": "valid" },
      body: payload,
    }), {
    ACCESS_ISSUER: "https://example.cloudflareaccess.com",
    ACCESS_AUDIENCE: "aud",
    INTERNAL_AUTH_SECRET: "test-only-internal-secret-with-32-bytes-minimum",
    TENANT_API: { fetch: async request => {
      forwarded = request;
      return new Response(JSON.stringify({ data: { status: "inactive" } }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    } },
  });
  assert.equal(response.status, 200);
  assert.equal(forwarded.method, "POST");
  assert.equal(new URL(forwarded.url).pathname,
    "/internal/v1/tenants/tenant-a/membership-actions");
  assert.equal(await forwarded.text(), payload);
  assert.equal(forwarded.headers.get("x-nova-verified-subject"), "tenant-owner");
  assert.match(forwarded.headers.get("x-nova-internal-signature"), /^[a-f0-9]{64}$/);
});


test("routes exact site-grant mutations through the signed private tenant API", async () => {
  const gateway = createGateway({ verifyAccessToken: async () => ({
    subject: "tenant-owner", issuer: "https://example.cloudflareaccess.com", audience: "aud",
  }) });
  let forwarded;
  const payload = JSON.stringify({ action: "grant", subject: "member-subject",
    site_id: "site-a", grant_action: "read", reason: "Approved site access" });
  const response = await gateway.fetch(new Request(
    "https://gateway.test/api/v1/tenants/tenant-a/site-grants", {
      method: "POST",
      headers: { "content-type": "application/json", "Cf-Access-Jwt-Assertion": "valid" },
      body: payload,
    }), {
    ACCESS_ISSUER: "https://example.cloudflareaccess.com",
    ACCESS_AUDIENCE: "aud",
    INTERNAL_AUTH_SECRET: "test-only-internal-secret-with-32-bytes-minimum",
    TENANT_API: { fetch: async request => {
      forwarded = request;
      return new Response(JSON.stringify({ data: { status: "active" } }), {
        status: 201, headers: { "content-type": "application/json" },
      });
    } },
  });
  assert.equal(response.status, 201);
  assert.equal(forwarded.method, "POST");
  assert.equal(new URL(forwarded.url).pathname,
    "/internal/v1/tenants/tenant-a/site-grants");
  assert.equal(await forwarded.text(), payload);
  assert.equal(forwarded.headers.get("x-nova-verified-subject"), "tenant-owner");
  assert.match(forwarded.headers.get("x-nova-internal-signature"), /^[a-f0-9]{64}$/);
});


test("routes exact tenant resource-grant mutations through the signed private API", async () => {
  const gateway = createGateway({ verifyAccessToken: async () => ({
    subject: "tenant-owner", issuer: "https://example.cloudflareaccess.com", audience: "aud",
  }) });
  let forwarded;
  const payload = JSON.stringify({ action: "grant", subject: "member-subject",
    resource_type: "asset", resource_id: "asset-a", grant_action: "read",
    reason: "Approved asset access" });
  const response = await gateway.fetch(new Request(
    "https://gateway.test/api/v1/tenants/tenant-a/resource-grants", {
      method: "POST",
      headers: { "content-type": "application/json", "Cf-Access-Jwt-Assertion": "valid" },
      body: payload,
    }), {
    ACCESS_ISSUER: "https://example.cloudflareaccess.com",
    ACCESS_AUDIENCE: "aud",
    INTERNAL_AUTH_SECRET: "test-only-internal-secret-with-32-bytes-minimum",
    TENANT_API: { fetch: async request => {
      forwarded = request;
      return new Response(JSON.stringify({ data: { status: "active" } }), {
        status: 201, headers: { "content-type": "application/json" },
      });
    } },
  });
  assert.equal(response.status, 201);
  assert.equal(forwarded.method, "POST");
  assert.equal(new URL(forwarded.url).pathname,
    "/internal/v1/tenants/tenant-a/resource-grants");
  assert.equal(await forwarded.text(), payload);
  assert.equal(forwarded.headers.get("x-nova-verified-subject"), "tenant-owner");
  assert.match(forwarded.headers.get("x-nova-internal-signature"), /^[a-f0-9]{64}$/);
});

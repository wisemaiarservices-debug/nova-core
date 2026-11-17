import test from "node:test";
import assert from "node:assert/strict";
import worker, { createGateway } from "../src/index.mjs";
import { createHash, createHmac, generateKeyPairSync, sign, webcrypto } from "node:crypto";
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
      { headers: { "Cf-Access-Jwt-Assertion": token, Authorization: "Bearer supabase.header.payload",
        cookie: "session=secret", "x-nova-verified-subject": "attacker",
        "x-nova-verified-issuer": "https://attacker.test" } }),
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
    assert.equal(captured.headers.get("x-nova-supabase-access-token"), "supabase.header.payload");
    const expectedTokenDigest = createHash("sha256").update("supabase.header.payload").digest("hex");
    assert.equal(captured.headers.get("x-nova-supabase-token-sha256"), expectedTokenDigest);
    assert.equal(captured.headers.get("x-nova-idempotency-key"), null);
    const canonical = JSON.stringify(["GET", new URL(captured.url).pathname,
      captured.headers.get("x-nova-verified-subject"), captured.headers.get("x-nova-verified-issuer"),
      captured.headers.get("x-nova-verified-audience"), captured.headers.get("x-nova-gateway-issued-at"),
      captured.headers.get("x-nova-request-id"), captured.headers.get("x-nova-body-sha256"), expectedTokenDigest,
      captured.headers.get("x-nova-idempotency-key")]);
    const expectedSignature = createHmac("sha256", "test-only-internal-secret-with-32-bytes-minimum")
      .update(canonical).digest("hex");
    assert.equal(captured.headers.get("x-nova-internal-signature"), expectedSignature);
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
    { method: "POST", headers: { "content-type": "application/json", "Cf-Access-Jwt-Assertion": "valid", "Authorization": "Bearer test.supabase.token" },
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
      "Access-Control-Request-Headers": "accept,authorization,content-type",
    },
  }), configured);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://nova-os-pied.vercel.app");
  assert.equal(response.headers.get("access-control-allow-credentials"), "true");
  assert.equal(response.headers.get("access-control-allow-methods"), "GET, POST, OPTIONS");
  assert.equal(response.headers.get("access-control-allow-headers"), "Accept, Authorization, Content-Type, Idempotency-Key");
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
      "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "x-unapproved-header" },
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
  const payload = JSON.stringify({ display_name: "Research tenant", idempotency_key: "bootstrap-001", nova_os_tenant_id: "nova-tenant-001" });
  let forwarded;
  const configured = {
    ACCESS_ISSUER: "https://example.cloudflareaccess.com",
    ACCESS_AUDIENCE: "aud",
    TENANT_PROVISIONING_SUBJECTS: "provisioning-principal",
    INTERNAL_AUTH_SECRET: "test-only-internal-secret-with-32-bytes-minimum",
    TENANT_API: { fetch: async request => {
      forwarded = request;
      return new Response(JSON.stringify({ data: {
        tenant_id: "tenant-core-001",
        tenant_status: "active",
        mapping_receipt: "signed.core.mapping.receipt",
        mapping_receipt_expires_at: 1_800_000_000,
        mapping_receipt_id: "provisioning-request-001",
      } }), {
        status: 201, headers: { "content-type": "application/json" },
      });
    } },
  };
  const response = await gateway.fetch(new Request("https://gateway.test/api/v1/tenants", {
    method: "POST", body: payload,
    headers: { "content-type": "application/json", "Cf-Access-Jwt-Assertion": "valid",
      "Authorization": "Bearer test.supabase.token" },
  }), configured);
  assert.equal(response.status, 201);
  const publicPayload = await response.json();
  assert.equal(publicPayload.data.mapping_receipt, "signed.core.mapping.receipt");
  assert.equal(publicPayload.data.mapping_receipt_id, "provisioning-request-001");
  assert.equal(publicPayload.data.tenant_id, "tenant-core-001");
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


test("routes ownership transfer through the signed Access gateway", async () => {
  const gateway = createGateway({ verifyAccessToken: async () => ({
    subject: "tenant-owner", issuer: "https://example.cloudflareaccess.com", audience: "aud",
  }) });
  let forwarded;
  const payload = JSON.stringify({ target_membership_id: "membership-target",
    reason: "Designated successor" });
  const response = await gateway.fetch(new Request(
    "https://gateway.test/api/v1/tenants/tenant-a/ownership-transfer", {
      method: "POST",
      headers: { "content-type": "application/json", "Cf-Access-Jwt-Assertion": "valid" },
      body: payload,
    }), {
    ACCESS_ISSUER: "https://example.cloudflareaccess.com",
    ACCESS_AUDIENCE: "aud",
    INTERNAL_AUTH_SECRET: "test-only-internal-secret-with-32-bytes-minimum",
    TENANT_API: { fetch: async request => {
      forwarded = request;
      return new Response(JSON.stringify({ data: { event_type: "ownership_transferred" } }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    } },
  });
  assert.equal(response.status, 200);
  assert.equal(forwarded.method, "POST");
  assert.equal(new URL(forwarded.url).pathname,
    "/internal/v1/tenants/tenant-a/ownership-transfer");
  assert.equal(await forwarded.text(), payload);
  assert.equal(forwarded.headers.get("x-nova-verified-subject"), "tenant-owner");
  assert.match(forwarded.headers.get("x-nova-internal-signature"), /^[a-f0-9]{64}$/);
});


test("routes tenant lifecycle actions and audit reads through signed Access gateway", async () => {
  const gateway = createGateway({ verifyAccessToken: async () => ({
    subject: "tenant-owner", issuer: "https://example.cloudflareaccess.com", audience: "aud",
  }) });
  const forwarded = [];
  const payload = JSON.stringify({ action: "suspend", reason: "Approved security review" });
  const response = await gateway.fetch(new Request(
    "https://gateway.test/api/v1/tenants/tenant-a/lifecycle-actions", {
      method: "POST",
      headers: { "content-type": "application/json", "Cf-Access-Jwt-Assertion": "valid" },
      body: payload,
    }), {
    ACCESS_ISSUER: "https://example.cloudflareaccess.com",
    ACCESS_AUDIENCE: "aud",
    INTERNAL_AUTH_SECRET: "test-only-internal-secret-with-32-bytes-minimum",
    TENANT_API: { fetch: async request => {
      forwarded.push(request);
      return new Response(JSON.stringify({ data: { status: "suspended" } }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    } },
  });
  assert.equal(response.status, 200);
  assert.equal(new URL(forwarded[0].url).pathname,
    "/internal/v1/tenants/tenant-a/lifecycle-actions");
  assert.equal(await forwarded[0].text(), payload);
  assert.equal(forwarded[0].headers.get("x-nova-verified-subject"), "tenant-owner");
  assert.match(forwarded[0].headers.get("x-nova-internal-signature"), /^[a-f0-9]{64}$/);

  const audit = await gateway.fetch(new Request(
    "https://gateway.test/api/v1/tenants/tenant-a/lifecycle-events", {
      method: "GET", headers: { "Cf-Access-Jwt-Assertion": "valid" },
    }), {
    ACCESS_ISSUER: "https://example.cloudflareaccess.com",
    ACCESS_AUDIENCE: "aud",
    INTERNAL_AUTH_SECRET: "test-only-internal-secret-with-32-bytes-minimum",
    TENANT_API: { fetch: async request => {
      forwarded.push(request);
      return new Response(JSON.stringify({ data: [] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    } },
  });
  assert.equal(audit.status, 200);
  assert.equal(new URL(forwarded[1].url).pathname,
    "/internal/v1/tenants/tenant-a/lifecycle-events");
  assert.equal(forwarded[1].method, "GET");
  assert.equal(forwarded[1].headers.get("x-nova-verified-subject"), "tenant-owner");
});


test("routes dual-identity challenge and owner-review endpoints through the signed gateway", async () => {
  const gateway = createGateway({ verifyAccessToken: async () => ({
    subject: "cloudflare-user", issuer: "https://example.cloudflareaccess.com", audience: "aud",
  }) });
  const forwarded = [];
  const token = "header.payload.signature";
  const payloads = [
    ["POST", "https://gateway.test/api/v1/identity-links/challenges", "{}", "/internal/v1/identity-links/challenges", true],
    ["POST", "https://gateway.test/api/v1/identity-links/challenges/challenge-1/consume",
      JSON.stringify({ challenge: "a".repeat(43) }),
      "/internal/v1/identity-links/challenges/challenge-1/consume", true],
    ["GET", "https://gateway.test/api/v1/tenants/tenant-a/identity-links/pending",
      undefined, "/internal/v1/tenants/tenant-a/identity-links/pending", false],
    ["POST", "https://gateway.test/api/v1/tenants/tenant-a/identity-links/request-1/decision",
      JSON.stringify({ decision: "approve", reason: "Independent owner review", idempotency_key: "decision-1" }),
      "/internal/v1/tenants/tenant-a/identity-links/request-1/decision", false],
  ];
  for (const [method, url, body, expectedPath, needsSupabase] of payloads) {
    const response = await gateway.fetch(new Request(url, {
      method,
      headers: {
        "Cf-Access-Jwt-Assertion": "valid",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(needsSupabase ? { authorization: "Bearer " + token } : {}),
      },
      body,
    }), {
      ACCESS_ISSUER: "https://example.cloudflareaccess.com",
      ACCESS_AUDIENCE: "aud",
      INTERNAL_AUTH_SECRET: "test-only-internal-secret-with-32-bytes-minimum",
      TENANT_API: { fetch: async request => {
        forwarded.push(request);
        return new Response(JSON.stringify({ data: { accepted: true } }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      } },
    });
    assert.equal(response.status, 200);
    const request = forwarded.at(-1);
    assert.equal(new URL(request.url).pathname, expectedPath);
    assert.equal(request.headers.get("x-nova-verified-subject"), "cloudflare-user");
    assert.match(request.headers.get("x-nova-internal-signature"), /^[a-f0-9]{64}$/);
    if (needsSupabase) {
      assert.equal(request.headers.get("x-nova-supabase-access-token"), token);
      assert.equal(request.headers.get("x-nova-supabase-token-sha256"),
        createHash("sha256").update(token).digest("hex"));
    } else {
      assert.equal(request.headers.get("x-nova-supabase-access-token"), null);
    }
  }
});

test("rejects Core tenant provisioning without a Supabase bearer token", async () => {
  const gateway = createGateway({ verifyAccessToken: async () => ({
    subject: "cloudflare-user", issuer: "https://example.cloudflareaccess.com", audience: "aud",
  }) });
  let forwarded = false;
  const response = await gateway.fetch(new Request(
    "https://gateway.test/api/v1/tenants", {
      method: "POST",
      headers: { "Cf-Access-Jwt-Assertion": "valid", "content-type": "application/json" },
      body: JSON.stringify({ display_name: "Research tenant", idempotency_key: "bootstrap-001", nova_os_tenant_id: "nova-tenant-001" }),
    }), {
    ACCESS_ISSUER: "https://example.cloudflareaccess.com",
    ACCESS_AUDIENCE: "aud",
    INTERNAL_AUTH_SECRET: "test-only-internal-secret-with-32-bytes-minimum",
    TENANT_PROVISIONING_SUBJECTS: "cloudflare-user",
    TENANT_API: { fetch: async () => { forwarded = true; return new Response(null); } },
  });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "supabase_authorization_required");
  assert.equal(forwarded, false);
});

test("rejects identity-link challenge creation without a Supabase bearer token", async () => {
  const gateway = createGateway({ verifyAccessToken: async () => ({
    subject: "cloudflare-user", issuer: "https://example.cloudflareaccess.com", audience: "aud",
  }) });
  let forwarded = false;
  const response = await gateway.fetch(new Request(
    "https://gateway.test/api/v1/identity-links/challenges", {
      method: "POST",
      headers: { "Cf-Access-Jwt-Assertion": "valid", "content-type": "application/json" },
      body: "{}",
    }), {
    ACCESS_ISSUER: "https://example.cloudflareaccess.com",
    ACCESS_AUDIENCE: "aud",
    INTERNAL_AUTH_SECRET: "test-only-internal-secret-with-32-bytes-minimum",
    TENANT_API: { fetch: async () => { forwarded = true; return new Response(null); } },
  });
  assert.equal(response.status, 401);
  assert.equal(forwarded, false);
});


test("routes approved identity-link inventory through the signed owner-authenticated gateway", async () => {
  let captured;
  const gateway = createGateway({ verifyAccessToken: async () => ({
    subject: "tenant-owner", issuer: "https://example.cloudflareaccess.com", audience: "aud",
  }) });
  const response = await gateway.fetch(new Request(
    "https://gateway.test/api/v1/tenants/tenant-a/identity-links/approved",
    { headers: { "Cf-Access-Jwt-Assertion": "test-access-token" } }),
    env({ TENANT_API: { fetch: async request => {
      captured = request;
      return new Response(JSON.stringify({ data: [] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    } } }));
  assert.equal(response.status, 200);
  assert.equal(new URL(captured.url).pathname,
    "/internal/v1/tenants/tenant-a/identity-links/approved");
  assert.equal(captured.headers.get("x-nova-verified-subject"), "tenant-owner");
  assert.equal(captured.headers.get("x-nova-internal-signature")?.length, 64);
});


test("routes bounded site observation reads through the signed Access gateway", async () => {
  let captured;
  const gateway = createGateway({ verifyAccessToken: async () => ({
    subject: "site-observation-reader", issuer: "https://example.cloudflareaccess.com", audience: "aud",
  }) });
  const response = await gateway.fetch(new Request(
    "https://gateway.test/api/v1/tenants/tenant-a/sites/site-a/observations",
    { headers: { "Cf-Access-Jwt-Assertion": "test-access-token", Authorization: "Bearer test.supabase.token" } }),
    env({ TENANT_API: { fetch: async request => {
      captured = request;
      return new Response(JSON.stringify({ data: [], limit: 100 }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    } } }));
  assert.equal(response.status, 200);
  assert.equal(captured.method, "GET");
  assert.equal(new URL(captured.url).pathname, "/internal/v1/tenants/tenant-a/sites/site-a/observations");
  assert.equal(captured.headers.get("x-nova-verified-subject"), "site-observation-reader");
  assert.equal(captured.headers.get("x-nova-supabase-access-token"), "test.supabase.token");
  assert.equal(captured.headers.get("x-nova-internal-signature")?.length, 64);
});

test("routes tenant site discovery through the signed dual-identity gateway", async () => {
  let captured;
  const gateway = createGateway({ verifyAccessToken: async () => ({
    subject: "site-list-reader", issuer: "https://example.cloudflareaccess.com", audience: "aud",
  }) });
  const response = await gateway.fetch(new Request(
    "https://gateway.test/api/v1/tenants/tenant-a/sites",
    { headers: { "Cf-Access-Jwt-Assertion": "test-access-token", Authorization: "Bearer test.supabase.token" } }),
    env({ TENANT_API: { fetch: async request => {
      captured = request;
      return new Response(JSON.stringify({ data: [{ id: "site-a", name: "North Farm" }], limit: 100 }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    } } }));
  assert.equal(response.status, 200);
  assert.equal(new URL(captured.url).pathname, "/internal/v1/tenants/tenant-a/sites");
  assert.equal(captured.headers.get("x-nova-verified-subject"), "site-list-reader");
  assert.equal(captured.headers.get("x-nova-supabase-access-token"), "test.supabase.token");
  assert.equal(captured.headers.get("x-nova-internal-signature")?.length, 64);
});


// First-site onboarding route regressions merged with the dual-identity provisioning tests.
test("routes owner asset registration through the signed gateway with exact idempotency key", async () => {
  let captured;
  const gateway = createGateway({ verifyAccessToken: async () => ({
    subject: "asset-owner", issuer: "https://example.cloudflareaccess.com", audience: "aud",
  }) });
  const body = JSON.stringify({ name: "Pump 01", asset_type: "pump" });
  const response = await gateway.fetch(new Request(
    "https://gateway.test/api/v1/tenants/tenant-a/sites/site-a/assets",
    { method: "POST", body, headers: {
      "Cf-Access-Jwt-Assertion": "valid-access-token",
      Authorization: "Bearer supabase.header.payload",
      "Content-Type": "application/json",
      "Idempotency-Key": "asset-onboarding-1",
    } }), env({ TENANT_API: { fetch: async request => {
      captured = request;
      return new Response(JSON.stringify({ data: { status: "unconfigured" } }), {
        status: 201, headers: { "content-type": "application/json" },
      });
    } } }));
  assert.equal(response.status, 201);
  assert.equal(captured.method, "POST");
  assert.equal(new URL(captured.url).pathname,
    "/internal/v1/tenants/tenant-a/sites/site-a/assets");
  assert.equal(await captured.text(), body);
  assert.equal(captured.headers.get("x-nova-idempotency-key"), "asset-onboarding-1");
  assert.equal(captured.headers.get("x-nova-supabase-access-token"), "supabase.header.payload");
  assert.match(captured.headers.get("x-nova-internal-signature"), /^[a-f0-9]{64}$/);
})

test("routes tenant source registration through the signed gateway with body digest and idempotency", async () => {
  let captured;
  const gateway = createGateway({ verifyAccessToken: async () => ({
    subject: "source-owner", issuer: "https://example.cloudflareaccess.com", audience: "aud",
  }) });
  const body = JSON.stringify({
    module: "neoagro", provider: "gateway-vendor", source_type: "sensor_gateway",
    display_name: "North greenhouse gateway", evidence_ref: "evidence/source-1",
  });
  const response = await gateway.fetch(new Request(
    "https://gateway.test/api/v1/tenants/tenant-a/sites/site-a/sources",
    { method: "POST", body, headers: {
      "Cf-Access-Jwt-Assertion": "valid-access-token",
      "Content-Type": "application/json",
      "Idempotency-Key": "source-registration-1",
    } }), env({ TENANT_API: { fetch: async request => {
      captured = request;
      return new Response(JSON.stringify({ data: { verification_status: "unverified" } }), {
        status: 201, headers: { "content-type": "application/json" },
      });
    } } }));
  assert.equal(response.status, 201);
  assert.equal(new URL(captured.url).pathname,
    "/internal/v1/tenants/tenant-a/sites/site-a/sources");
  assert.equal(await captured.text(), body);
  assert.equal(captured.headers.get("x-nova-idempotency-key"), "source-registration-1");
  assert.match(captured.headers.get("x-nova-body-sha256"), /^[a-f0-9]{64}$/);
  assert.match(captured.headers.get("x-nova-internal-signature"), /^[a-f0-9]{64}$/);
})

test("routes first-site creation with a signed idempotency key and dual identity", async () => {
  let captured;
  const gateway = createGateway({ verifyAccessToken: async () => ({
    subject: "site-owner", issuer: "https://example.cloudflareaccess.com", audience: "aud",
  }) });
  const response = await gateway.fetch(new Request(
    "https://gateway.test/api/v1/tenants/tenant-a/sites",
    { method: "POST", headers: {
      "Cf-Access-Jwt-Assertion": "test-access-token",
      Authorization: "Bearer test.supabase.token",
      "Content-Type": "application/json",
      "Idempotency-Key": "first-site-request-1",
    }, body: JSON.stringify({ name: "North Farm" }) }),
    env({ TENANT_API: { fetch: async request => {
      captured = request;
      return new Response(JSON.stringify({ data: { id: "site-generated", name: "North Farm", created: true } }), {
        status: 201, headers: { "content-type": "application/json" },
      });
    } } }));
  assert.equal(response.status, 201);
  assert.equal(new URL(captured.url).pathname, "/internal/v1/tenants/tenant-a/sites");
  assert.equal(captured.headers.get("x-nova-idempotency-key"), "first-site-request-1");
  assert.equal(captured.headers.get("x-nova-supabase-access-token"), "test.supabase.token");
  assert.equal(captured.headers.get("x-nova-internal-signature")?.length, 64);
  assert.equal(await captured.text(), JSON.stringify({ name: "North Farm" }));
})

test("requires a valid idempotency key for first-site creation", async () => {
  const gateway = createGateway({ verifyAccessToken: async () => ({
    subject: "site-owner", issuer: "https://example.cloudflareaccess.com", audience: "aud",
  }) });
  const response = await gateway.fetch(new Request(
    "https://gateway.test/api/v1/tenants/tenant-a/sites",
    { method: "POST", headers: {
      "Cf-Access-Jwt-Assertion": "test-access-token",
      Authorization: "Bearer test.supabase.token",
      "Content-Type": "application/json",
      "Idempotency-Key": "bad key",
    }, body: JSON.stringify({ name: "North Farm" }) }), env());
  assert.equal(response.status, 400);
})

test("allows idempotency-key in the exact-origin CORS preflight", async () => {
  const response = await worker.fetch(new Request("https://gateway.test/api/v1/tenants/tenant-a/sites", {
    method: "OPTIONS",
    headers: {
      Origin: "https://operator.example.test",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization, content-type, idempotency-key",
    },
  }), env({ CORS_ALLOWED_ORIGINS: "https://operator.example.test" }));
  assert.equal(response.status, 204);
})


test("forwards stable assessment operation idempotency across fresh signed transport requests", async () => {
  const gateway = createGateway({ verifyAccessToken: async () => ({
    subject: "assessment-reader", issuer: "https://example.cloudflareaccess.com", audience: "aud",
  }) });
  const forwarded = [];
  const testEnv = env({ TENANT_API: { fetch: async request => {
    forwarded.push(request);
    return new Response(JSON.stringify({ data: { status: "not_assessed" } }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  } } });
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await gateway.fetch(new Request(
      "https://gateway.test/api/v1/tenants/tenant-a/observations/observation-a/measurement-quality-assessment",
      { method: "POST", headers: {
        "Cf-Access-Jwt-Assertion": "valid-access-token",
        "Content-Type": "application/json",
        "Idempotency-Key": "assessment-operation-001",
      }, body: "{}" }), testEnv);
    assert.equal(response.status, 200);
  }
  assert.equal(forwarded.length, 2);
  assert.equal(forwarded[0].headers.get("x-nova-idempotency-key"), "assessment-operation-001");
  assert.equal(forwarded[1].headers.get("x-nova-idempotency-key"), "assessment-operation-001");
  assert.notEqual(forwarded[0].headers.get("x-nova-request-id"),
    forwarded[1].headers.get("x-nova-request-id"));
  assert.match(forwarded[0].headers.get("x-nova-internal-signature"), /^[a-f0-9]{64}$/);
  assert.match(forwarded[1].headers.get("x-nova-internal-signature"), /^[a-f0-9]{64}$/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

import gateway from "../src/index.mjs";

globalThis.crypto ??= webcrypto;

const NOW = Math.floor(Date.now() / 1000) * 1000;
const TEAM = "example.cloudflareaccess.com";
const ACCESS_AUDIENCE = "cloudflare-access-app-audience";
const SIGNING_SECRET = "test-only-secret-material-that-is-at-least-32-bytes";
const PATH = "/api/v1/tenants/tenant-a/sites/site-a";

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

function b64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

async function accessToken(overrides = {}, rawSegments = {}) {
  const pair = await webcrypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const jwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  jwk.kid = "access-key-2026-11";
  jwk.use = "sig";
  jwk.alg = "RS256";
  const header = { alg: "RS256", typ: "JWT", kid: jwk.kid };
  const claims = {
    iss: `https://${TEAM}`,
    aud: [ACCESS_AUDIENCE],
    sub: "access-subject-123456",
    iat: NOW / 1000 - 5,
    nbf: NOW / 1000 - 5,
    exp: NOW / 1000 + 300,
    ...overrides,
  };
  const head = rawSegments.header ?? b64url(Buffer.from(JSON.stringify(header)));
  const payload = rawSegments.payload ?? b64url(Buffer.from(JSON.stringify(claims)));
  const input = `${head}.${payload}`;
  const signature = await webcrypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    pair.privateKey,
    new TextEncoder().encode(input),
  );
  return { token: `${input}.${b64url(signature)}`, jwk };
}

function environment(jwk, service = undefined) {
  return {
    NOVA_ACCESS_TEAM_DOMAIN: TEAM,
    NOVA_ACCESS_AUDIENCE: ACCESS_AUDIENCE,
    NOVA_INTERNAL_KEY_ID: "gateway-key-2026-11",
    NOVA_INTERNAL_HMAC_KEY: SIGNING_SECRET,
    NOVA_INTERNAL_ISSUER: "nova-core-tenant-gateway",
    NOVA_INTERNAL_AUDIENCE: "nova-core-private-tenant-api",
    TENANT_API: service,
    __testJwk: jwk,
  };
}

function request({ token, path = PATH, method = "GET" } = {}) {
  const headers = new Headers();
  if (token) headers.set("cf-access-jwt-assertion", token);
  return new Request(`https://tenant-gateway.example${path}`, { method, headers });
}

test("verifies Access JWT, signs exact tenant path and forwards only through Service Binding", async () => {
  const fixture = await accessToken();
  let captured;
  const env = environment(fixture.jwk, {
    fetch: async (internalRequest) => {
      captured = internalRequest;
      return new Response(JSON.stringify({
        id: "site-a", tenant_id: "tenant-a", name: "Research site",
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-cookie": "private=must-not-forward",
          "x-internal-debug": "must-not-forward",
        },
      });
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    return jsonResponse({ keys: [fixture.jwk] });
  };
  try {
    const result = await gateway.fetch(request({ token: fixture.token }), env);
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), {
      id: "site-a", tenant_id: "tenant-a", name: "Research site",
    });
    assert.equal(captured.method, "GET");
    assert.equal(new URL(captured.url).origin, "https://tenant-api.internal");
    assert.equal(new URL(captured.url).pathname, PATH);
    assert.match(captured.headers.get("authorization"), /^Bearer /);
    assert.equal(result.headers.get("set-cookie"), null);
    assert.equal(result.headers.get("x-internal-debug"), null);
    assert.equal(result.headers.get("cache-control"), "no-store");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects requests without a Cloudflare Access JWT", async () => {
  const result = await gateway.fetch(request(), environment({}, { fetch: async () => {
    throw new Error("must not call private API");
  } }));
  assert.equal(result.status, 401);
});

test("rejects invalid Access JWTs without calling the private Service Binding", async () => {
  let called = false;
  const env = environment({}, { fetch: async () => { called = true; } });
  const result = await gateway.fetch(request({ token: "invalid.jwt.token" }), env);
  assert.equal(result.status, 401);
  assert.equal(called, false);
});

test("rejects duplicate JSON members in Access JWT headers and claims", async () => {
  const headerFixture = await accessToken({}, {
    header: b64url(Buffer.from(
      '{"alg":"RS256","alg":"none","typ":"JWT","kid":"access-key-2026-11"}',
    )),
  });
  const claimsFixture = await accessToken({}, {
    header: b64url(Buffer.from(
      '{"alg":"RS256","typ":"JWT","kid":"access-key-claims"}',
    )),
    payload: b64url(Buffer.from(JSON.stringify({
      iss: `https://${TEAM}`,
      aud: ACCESS_AUDIENCE,
      sub: "access-subject-123456",
      iat: NOW / 1000 - 5,
      exp: NOW / 1000 + 300,
    }).replace('"aud":"cloudflare-access-app-audience"', '"aud":"cloudflare-access-app-audience","aud":"other-audience"'))),
  });
  claimsFixture.jwk.kid = "access-key-claims";
  const unsupportedHeaderFixture = await accessToken({}, {
    header: b64url(Buffer.from(
      '{"alg":"RS256","typ":"JWT","kid":"access-key-crit","crit":["custom"]}',
    )),
  });
  unsupportedHeaderFixture.jwk.kid = "access-key-crit";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({
    keys: [headerFixture.jwk, claimsFixture.jwk, unsupportedHeaderFixture.jwk],
  });
  let called = false;
  const env = environment(headerFixture.jwk, { fetch: async () => { called = true; } });
  try {
    const duplicateHeader = await gateway.fetch(
      request({ token: headerFixture.token }), env,
    );
    const duplicateClaims = await gateway.fetch(
      request({ token: claimsFixture.token }), env,
    );
    const unsupportedHeader = await gateway.fetch(
      request({ token: unsupportedHeaderFixture.token }), env,
    );
    assert.equal(duplicateHeader.status, 401);
    assert.equal(duplicateClaims.status, 401);
    assert.equal(unsupportedHeader.status, 401);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects non-GET methods and query strings before authentication or forwarding", async () => {
  let called = false;
  const env = environment({}, { fetch: async () => { called = true; } });
  const post = await gateway.fetch(request({ token: "x", method: "POST" }), env);
  const query = await gateway.fetch(
    request({ token: "x", path: `${PATH}?tenant=tenant-b` }),
    env,
  );
  assert.equal(post.status, 405);
  assert.equal(query.status, 404);
  assert.equal(called, false);
});

test("fails closed when the private Service Binding is missing", async () => {
  const fixture = await accessToken();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ keys: [fixture.jwk] });
  try {
    const result = await gateway.fetch(
      request({ token: fixture.token }),
      environment(fixture.jwk),
    );
    assert.equal(result.status, 503);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not forward non-JSON, oversized or unexpected upstream responses", async () => {
  const fixture = await accessToken();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ keys: [fixture.jwk] });
  try {
    const nonJson = await gateway.fetch(
      request({ token: fixture.token }),
      environment(fixture.jwk, {
        fetch: async () => new Response("private debug", {
          status: 200, headers: { "content-type": "text/plain" },
        }),
      }),
    );
    const unexpected = await gateway.fetch(
      request({ token: fixture.token }),
      environment(fixture.jwk, {
        fetch: async () => new Response("error", { status: 500 }),
      }),
    );
    const oversized = await gateway.fetch(
      request({ token: fixture.token }),
      environment(fixture.jwk, {
        fetch: async () => new Response("x".repeat(1024 * 1024 + 1), {
          status: 200, headers: { "content-type": "application/json" },
        }),
      }),
    );
    const invalidJson = await gateway.fetch(
      request({ token: fixture.token }),
      environment(fixture.jwk, {
        fetch: async () => new Response("not-json", {
          status: 200, headers: { "content-type": "application/json" },
        }),
      }),
    );
    assert.equal(nonJson.status, 503);
    assert.equal(unexpected.status, 503);
    assert.equal(oversized.status, 502);
    assert.equal(invalidJson.status, 502);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not disclose upstream response details on Service Binding failure", async () => {
  const fixture = await accessToken();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ keys: [fixture.jwk] });
  try {
    const result = await gateway.fetch(
      request({ token: fixture.token }),
      environment(fixture.jwk, {
        fetch: async () => { throw new Error("secret internal stack"); },
      }),
    );
    assert.equal(result.status, 503);
    assert.equal(await result.text(), '{"detail":"gateway unavailable"}');
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("stops reading chunked private API responses at the gateway size limit", async () => {
  const fixture = await accessToken();
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () => jsonResponse({ keys: [fixture.jwk] });
  try {
    const oversizedStream = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024 + 1));
      },
      cancel() {
        cancelled = true;
      },
    });
    const result = await gateway.fetch(
      request({ token: fixture.token }),
      environment(fixture.jwk, {
        fetch: async () => new Response(oversizedStream, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      }),
    );
    assert.equal(result.status, 502);
    assert.equal(await result.text(), '{"detail":"upstream response rejected"}');
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects oversized declared private API response before streaming", async () => {
  const fixture = await accessToken();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ keys: [fixture.jwk] });
  try {
    const result = await gateway.fetch(
      request({ token: fixture.token }),
      environment(fixture.jwk, {
        fetch: async () => new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": String(1024 * 1024 + 1),
          },
        }),
      }),
    );
    assert.equal(result.status, 502);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("rejects duplicate JSON members in private API response payloads", async () => {
  const fixture = await accessToken();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ keys: [fixture.jwk] });
  try {
    const result = await gateway.fetch(
      request({ token: fixture.token }),
      environment(fixture.jwk, {
        fetch: async () => new Response(
          '{"id":"site-a","nested":{"tenant_id":"tenant-a","tenant_id":"tenant-b"}}',
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      }),
    );
    assert.equal(result.status, 502);
    assert.equal(await result.text(), '{"detail":"upstream response rejected"}');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("accepts a valid numeric Content-Length on bounded private API responses", async () => {
  const fixture = await accessToken();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ keys: [fixture.jwk] });
  const payload = JSON.stringify({ id: "site-a", tenant_id: "tenant-a" });
  try {
    const result = await gateway.fetch(
      request({ token: fixture.token }),
      environment(fixture.jwk, {
        fetch: async () => new Response(payload, {
          status:  200,
          headers: {
            "content-type": "application/json",
            "content-length": String(new TextEncoder().encode(payload).byteLength),
          },
        }),
      }),
    );
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { id: "site-a", tenant_id: "tenant-a" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});



test("bounds private Service Binding requests with a five-second abort signal", async () => {
  const fixture = await accessToken();
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  const controller = new AbortController();
  let timeoutMs;
  let capturedSignal;
  AbortSignal.timeout = (milliseconds) => {
    timeoutMs = milliseconds;
    return controller.signal;
  };
  globalThis.fetch = async () => jsonResponse({ keys: [fixture.jwk] });
  try {
    const result = await gateway.fetch(
      request({ token: fixture.token }),
      environment(fixture.jwk, {
        fetch: async (internalRequest) => {
          capturedSignal = internalRequest.signal;
          assert.equal(capturedSignal.aborted, false);
          return new Promise((resolve, reject) => {
            capturedSignal.addEventListener(
              "abort",
              () => reject(new DOMException("request timed out", "AbortError")),
              { once: true },
            );
            controller.abort();
          });
        },
      }),
    );
    assert.equal(timeoutMs, 5000);
    assert.equal(capturedSignal.aborted, true);
    assert.equal(result.status, 503);
    assert.equal(await result.text(), '{"detail":"gateway unavailable"}');
  } finally {
    AbortSignal.timeout = originalTimeout;
    globalThis.fetch = originalFetch;
  }
});
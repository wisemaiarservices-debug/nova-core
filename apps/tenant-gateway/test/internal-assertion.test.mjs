import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

import {
  createInternalAssertion,
  verifyCloudflareAccessJwt,
} from "../src/internal-assertion.mjs";

globalThis.crypto ??= webcrypto;

const SECRET = "test-only-secret-material-that-is-at-least-32-bytes";
const NOW = 1_800_000_000_000;
const TEAM = "example.cloudflareaccess.com";
const ACCESS_ISSUER = `https://${TEAM}`;
const ACCESS_AUDIENCE = "cloudflare-access-app-audience";
const PATH = "/api/v1/tenants/tenant-a/sites/site-a";
const SIGNING_KEY_ID = "gateway-key-2026-11";
const SIGNING_ISSUER = "nova-core-tenant-gateway";
const SIGNING_AUDIENCE = "nova-core-private-tenant-api";

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
  });
}

function b64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

async function fixtureAccessToken(overrides = {}) {
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
  const publicJwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  publicJwk.kid = "access-key-2026-11";
  publicJwk.use = "sig";
  publicJwk.alg = "RS256";
  const header = { alg: "RS256", typ: "JWT", kid: publicJwk.kid };
  const claims = {
    iss: ACCESS_ISSUER,
    aud: [ACCESS_AUDIENCE],
    sub: "access-subject-123456",
    iat: NOW / 1000 - 5,
    nbf: NOW / 1000 - 5,
    exp: NOW / 1000 + 300,
    ...overrides,
  };
  const headerPart = b64url(Buffer.from(JSON.stringify(header)));
  const claimsPart = b64url(Buffer.from(JSON.stringify(claims)));
  const signingInput = `${headerPart}.${claimsPart}`;
  const signature = await webcrypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    pair.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return {
    token: `${signingInput}.${b64url(signature)}`,
    jwks: { keys: [publicJwk] },
  };
}

async function verifiedIdentity(overrides = {}) {
  const fixture = await fixtureAccessToken(overrides);
  const identity = await verifyCloudflareAccessJwt(fixture.token, {
    teamDomain: TEAM,
    audience: ACCESS_AUDIENCE,
    now: NOW,
    fetchImpl: async (url, options) => {
      assert.equal(url, `${ACCESS_ISSUER}/cdn-cgi/access/certs`);
      assert.equal(options.method, "GET");
      return jsonResponse(fixture.jwks);
    },
  });
  return identity;
}

function decodeSegment(segment) {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

async function signerArguments(overrides = {}) {
  return {
    verifiedAccessIdentity: await verifiedIdentity(),
    method: "GET",
    path: PATH,
    now: NOW,
    ttlSeconds: 60,
    keyId: SIGNING_KEY_ID,
    secret: SECRET,
    issuer: SIGNING_ISSUER,
    audience: SIGNING_AUDIENCE,
    ...overrides,
  };
}

test("verifies Cloudflare Access RS256 signature and exact issuer/audience before returning identity", async () => {
  const identity = await verifiedIdentity();
  assert.deepEqual(identity, { subject: "access-subject-123456" });
});

test("rejects invalid Access signature and mismatched identity claims", async () => {
  const fixture = await fixtureAccessToken();
  const tampered = fixture.token.slice(0, -1) + (fixture.token.endsWith("A") ? "B" : "A");
  const fetchImpl = async () => jsonResponse(fixture.jwks);
  await assert.rejects(
    verifyCloudflareAccessJwt(tampered, {
      teamDomain: TEAM, audience: ACCESS_AUDIENCE, now: NOW, fetchImpl,
    }),
  );
  for (const claims of [
    { iss: "https://attacker.cloudflareaccess.com" },
    { aud: ["different-application"] },
    { exp: NOW / 1000 },
    { nbf: NOW / 1000 + 30 },
    { iat: undefined },
    { nbf: undefined },
    { iat: NOW / 1000 + 30 },
    { nbf: "not-a-number" },
    { sub: "subject with spaces" },
  ]) {
    const invalid = await fixtureAccessToken(claims);
    await assert.rejects(
      verifyCloudflareAccessJwt(invalid.token, {
        teamDomain: TEAM,
        audience: ACCESS_AUDIENCE,
        now: NOW,
        fetchImpl: async () => jsonResponse(invalid.jwks),
      }),
    );
  }
});

test("fails closed for unavailable, ambiguous or unknown Access signing keys", async () => {
  const fixture = await fixtureAccessToken();
  await assert.rejects(
    verifyCloudflareAccessJwt(fixture.token, {
      teamDomain: TEAM, audience: ACCESS_AUDIENCE, now: NOW,
      fetchImpl: async () => new Response("unavailable", { status: 503 }),
    }),
    /signing keys are unavailable/,
  );
  await assert.rejects(
    verifyCloudflareAccessJwt(fixture.token, {
      teamDomain: TEAM, audience: ACCESS_AUDIENCE, now: NOW,
      fetchImpl: async () => jsonResponse({ keys: [] }),
    }),
    /signing keys are invalid/,
  );
  const ambiguous = { keys: [fixture.jwks.keys[0], fixture.jwks.keys[0]] };
  await assert.rejects(
    verifyCloudflareAccessJwt(fixture.token, {
      teamDomain: TEAM, audience: ACCESS_AUDIENCE, now: NOW,
      fetchImpl: async () => jsonResponse(ambiguous),
    }),
    /unknown or ambiguous/,
  );
});

test("creates an HS256 assertion compatible with the private API verifier contract", async () => {
  const args = await signerArguments();
  const token = await createInternalAssertion(args);
  const [headerPart, claimsPart, signaturePart] = token.split(".");
  assert.equal(token.split(".").length, 3);
  const header = decodeSegment(headerPart);
  const claims = decodeSegment(claimsPart);
  assert.deepEqual(header, {
    alg: "HS256",
    typ: "NOVA-Internal-Request",
    kid: SIGNING_KEY_ID,
  });
  assert.equal(claims.iss, SIGNING_ISSUER);
  assert.equal(claims.aud, SIGNING_AUDIENCE);
  assert.equal(claims.sub, args.verifiedAccessIdentity.subject);
  assert.equal(claims.iat, NOW / 1000);
  assert.equal(claims.exp, NOW / 1000 + 60);
  assert.match(claims.jti, /^[A-Za-z0-9._~-]{16,128}$/);
  assert.equal(claims.method, "GET");
  assert.equal(claims.path, PATH);
  assert.match(signaturePart, /^[A-Za-z0-9_-]{43}$/);

  const key = await webcrypto.subtle.importKey(
    "raw", new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
  );
  const signature = Buffer.from(signaturePart, "base64url");
  assert.equal(
    await webcrypto.subtle.verify(
      "HMAC", key, signature,
      new TextEncoder().encode(`${headerPart}.${claimsPart}`),
    ),
    true,
  );
});

test("generates a unique request identifier for each assertion", async () => {
  const args = await signerArguments();
  const first = decodeSegment((await createInternalAssertion(args)).split(".")[1]);
  const second = decodeSegment((await createInternalAssertion(args)).split(".")[1]);
  assert.notEqual(first.jti, second.jti);
});

test("rejects plain objects and client-supplied identity headers as principals", async () => {
  await assert.rejects(
    createInternalAssertion({
      ...(await signerArguments()),
      verifiedAccessIdentity: { subject: "client-header-subject", verified: true },
    }),
    /verified Access identity/,
  );
});

test("rejects non-GET methods and paths outside the private read allowlist", async () => {
  const args = await signerArguments();
  await assert.rejects(createInternalAssertion({ ...args, method: "POST" }), /GET/);
  for (const path of [
    "/api/v1/tenants/tenant-a/sites",
    "/api/v1/tenants/tenant-a/sites/site-a/",
    "/api/v1/tenants/../sites/site-a",
    "/api/v1/tenants/tenant-a/sites/..",
    "/api/v1/tenants/tenant-a/sites/site-a?tenant=tenant-b",
    "/api/v1/tenants/tenant-a/sites/site%2fa",
    "/api/v1/tenants/tenant-a/memberships/member-a",
  ]) {
    await assert.rejects(createInternalAssertion({ ...args, path }), /path is not allowed/);
  }
});

test("rejects excessive lifetime, malformed key identifiers and short secrets", async () => {
  const args = await signerArguments();
  await assert.rejects(createInternalAssertion({ ...args, ttlSeconds: 121 }), /lifetime/);
  await assert.rejects(createInternalAssertion({ ...args, ttlSeconds: 0 }), /lifetime/);
  await assert.rejects(createInternalAssertion({ ...args, keyId: "../bad" }), /key identifier/);
  await assert.rejects(createInternalAssertion({ ...args, secret: "short" }), /key material/);
});

test("rejects missing issuer or audience configuration and unsafe clock input", async () => {
  const args = await signerArguments();
  await assert.rejects(createInternalAssertion({ ...args, issuer: "" }), /issuer or audience/);
  await assert.rejects(createInternalAssertion({ ...args, audience: "" }), /issuer or audience/);
  await assert.rejects(createInternalAssertion({ ...args, now: Number.NaN }), /current time/);
});

test("rejects malformed Cloudflare Access token and team-domain configuration", async () => {
  await assert.rejects(
    verifyCloudflareAccessJwt("a.b.c", {
      teamDomain: "attacker.example",
      audience: ACCESS_AUDIENCE,
      now: NOW,
      fetchImpl: async () => jsonResponse({ keys: [] }),
    }),
    /configuration is invalid/,
  );
});


test("bounds JWKS fetch time with an AbortSignal", async () => {
  const fixture = await fixtureAccessToken();
  let receivedOptions;
  await verifyCloudflareAccessJwt(fixture.token, {
    teamDomain: TEAM,
    audience: ACCESS_AUDIENCE,
    now: NOW,
    fetchImpl: async (_url, options) => {
      receivedOptions = options;
      return jsonResponse(fixture.jwks);
    },
  });
  assert.ok(receivedOptions.signal instanceof AbortSignal);
  assert.equal(receivedOptions.signal.aborted, false);
});

test("rejects oversized JWKS from Content-Length and streamed bodies", async () => {
  const fixture = await fixtureAccessToken();
  const verifyWith = (response) => verifyCloudflareAccessJwt(fixture.token, {
    teamDomain: TEAM,
    audience: ACCESS_AUDIENCE,
    now: NOW,
    fetchImpl: async () => response,
  });
  await assert.rejects(
    verifyWith(new Response("{}", {
      headers: {
        "content-type": "application/json",
        "content-length": String(64 * 1024 + 1),
      },
    })),
    /response is too large/,
  );
  await assert.rejects(
    verifyWith(new Response("x".repeat(64 * 1024 + 1), {
      headers: { "content-type": "application/json" },
    })),
    /response is too large/,
  );
});

test("rejects invalid JWKS content type and malformed JSON", async () => {
  const fixture = await fixtureAccessToken();
  const verifyWith = (response) => verifyCloudflareAccessJwt(fixture.token, {
    teamDomain: TEAM,
    audience: ACCESS_AUDIENCE,
    now: NOW,
    fetchImpl: async () => response,
  });
  await assert.rejects(
    verifyWith(new Response("{}", {
      headers: { "content-type": "text/html" },
    })),
    /invalid content type/,
  );
  await assert.rejects(
    verifyWith(new Response("{", {
      headers: { "content-type": "application/json" },
    })),
  );
});


test("uses a fixed three-second timeout for JWKS retrieval", async () => {
  const fixture = await fixtureAccessToken();
  const originalTimeout = AbortSignal.timeout;
  let timeoutMs;
  AbortSignal.timeout = (milliseconds) => {
    timeoutMs = milliseconds;
    return new AbortController().signal;
  };
  try {
    await verifyCloudflareAccessJwt(fixture.token, {
      teamDomain: TEAM,
      audience: ACCESS_AUDIENCE,
      now: NOW,
      fetchImpl: async (_url, options) => {
        assert.ok(options.signal instanceof AbortSignal);
        return jsonResponse(fixture.jwks);
      },
    });
    assert.equal(timeoutMs, 3000);
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
});

test("accepts the matching signing key during a multi-key rotation overlap", async () => {
  const fixture = await fixtureAccessToken();
  const overlappingJwks = {
    keys: [
      { ...fixture.jwks.keys[0] },
      { ...fixture.jwks.keys[0], kid: "previous-access-key" },
    ],
  };
  const identity = await verifyCloudflareAccessJwt(fixture.token, {
    teamDomain: TEAM,
    audience: ACCESS_AUDIENCE,
    now: NOW,
    fetchImpl: async () => jsonResponse(overlappingJwks),
  });
  assert.equal(identity.subject, "access-subject-123456");
});

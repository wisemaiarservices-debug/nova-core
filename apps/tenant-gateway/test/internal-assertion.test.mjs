import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

import { createInternalAssertion } from "../src/internal-assertion.mjs";

globalThis.crypto ??= webcrypto;

const SECRET = "test-only-secret-material-that-is-at-least-32-bytes";
const NOW = 1_800_000_000_000;
const PATH = "/api/v1/tenants/tenant-a/sites/site-a";
const BASE = {
  verifiedAccessIdentity: {
    verified: true,
    subject: "access-subject-123456",
  },
  method: "GET",
  path: PATH,
  now: NOW,
  ttlSeconds: 60,
  keyId: "gateway-key-2026-11",
  secret: SECRET,
  issuer: "nova-core-tenant-gateway",
  audience: "nova-core-private-tenant-api",
};

function decodeSegment(segment) {
  const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

test("creates an HS256 assertion compatible with the private API verifier contract", async () => {
  const token = await createInternalAssertion(BASE);
  const [headerPart, claimsPart, signaturePart] = token.split(".");
  assert.equal(token.split(".").length, 3);
  const header = decodeSegment(headerPart);
  const claims = decodeSegment(claimsPart);
  assert.deepEqual(header, {
    alg: "HS256",
    typ: "NOVA-Internal-Request",
    kid: "gateway-key-2026-11",
  });
  assert.equal(claims.iss, BASE.issuer);
  assert.equal(claims.aud, BASE.audience);
  assert.equal(claims.sub, BASE.verifiedAccessIdentity.subject);
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
  const signature = Buffer.from(
    signaturePart.replace(/-/g, "+").replace(/_/g, "/") + "=",
    "base64",
  );
  assert.equal(
    await webcrypto.subtle.verify(
      "HMAC", key, signature,
      new TextEncoder().encode(`${headerPart}.${claimsPart}`),
    ),
    true,
  );
});

test("generates a unique request identifier for each assertion", async () => {
  const first = decodeSegment((await createInternalAssertion(BASE)).split(".")[1]);
  const second = decodeSegment((await createInternalAssertion(BASE)).split(".")[1]);
  assert.notEqual(first.jti, second.jti);
});

test("rejects identity not explicitly marked as verified by the Access verifier", async () => {
  await assert.rejects(
    createInternalAssertion({
      ...BASE,
      verifiedAccessIdentity: { subject: "client-header-subject" },
    }),
    /verified Access identity/,
  );
  await assert.rejects(
    createInternalAssertion({
      ...BASE,
      verifiedAccessIdentity: { verified: false, subject: "subject-123456" },
    }),
    /verified Access identity/,
  );
});

test("rejects non-GET methods and paths outside the private read allowlist", async () => {
  await assert.rejects(createInternalAssertion({ ...BASE, method: "POST" }), /GET/);
  for (const path of [
    "/api/v1/tenants/tenant-a/sites",
    "/api/v1/tenants/tenant-a/sites/site-a/",
    "/api/v1/tenants/../sites/site-a",
    "/api/v1/tenants/tenant-a/sites/..",
    "/api/v1/tenants/tenant-a/sites/site-a?tenant=tenant-b",
    "/api/v1/tenants/tenant-a/sites/site%2fa",
    "/api/v1/tenants/tenant-a/memberships/member-a",
  ]) {
    await assert.rejects(createInternalAssertion({ ...BASE, path }), /path is not allowed/);
  }
});

test("rejects excessive lifetime, malformed key identifiers and short secrets", async () => {
  await assert.rejects(createInternalAssertion({ ...BASE, ttlSeconds: 121 }), /lifetime/);
  await assert.rejects(createInternalAssertion({ ...BASE, ttlSeconds: 0 }), /lifetime/);
  await assert.rejects(createInternalAssertion({ ...BASE, keyId: "../bad" }), /key identifier/);
  await assert.rejects(createInternalAssertion({ ...BASE, secret: "short" }), /key material/);
});

test("rejects missing issuer or audience configuration", async () => {
  await assert.rejects(createInternalAssertion({ ...BASE, issuer: "" }), /issuer or audience/);
  await assert.rejects(createInternalAssertion({ ...BASE, audience: "" }), /issuer or audience/);
});

test("rejects malformed subject and unsafe time input", async () => {
  await assert.rejects(
    createInternalAssertion({
      ...BASE,
      verifiedAccessIdentity: { verified: true, subject: "subject with spaces" },
    }),
    /subject is invalid/,
  );
  await assert.rejects(createInternalAssertion({ ...BASE, now: Number.NaN }), /current time/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import {
  canonicalizeConfiguration, sha256Hex, equalDigest, prepareConfigurationSnapshot,
} from "../src/configuration-write-contract.mjs";

test("canonical JSON is independent of object key insertion order", () => {
  const a = canonicalizeConfiguration({ z: 1, a: { y: true, x: "é" } });
  const b = canonicalizeConfiguration({ a: { x: "é", y: true }, z: 1 });
  assert.equal(a.canonicalJson, b.canonicalJson);
  assert.equal(a.byteLength, new TextEncoder().encode(a.canonicalJson).byteLength);
});

test("normalizes negative zero and preserves JSON numeric semantics", () => {
  assert.equal(canonicalizeConfiguration({ value: -0 }).canonicalJson, '{"value":0}');
});

test("rejects non-object roots, non-finite values and unsupported runtime objects", () => {
  for (const value of [null, [], "x", 3]) {
    assert.throws(() => canonicalizeConfiguration(value), /configuration_must_be_object/);
  }
  assert.throws(() => canonicalizeConfiguration({ value: Number.NaN }), /configuration_non_finite_number/);
  assert.throws(() => canonicalizeConfiguration({ value: Infinity }), /configuration_non_finite_number/);
  assert.throws(() => canonicalizeConfiguration({ value: new Date() }), /configuration_value_not_json/);
});

test("rejects prototype-pollution keys at every nesting level", () => {
  const payload = JSON.parse('{"safe":{"__proto__":{"polluted":true}}}');
  assert.throws(() => canonicalizeConfiguration(payload), /configuration_forbidden_key/);
});

test("bounds byte length, depth, node count and array size", () => {
  assert.throws(() => canonicalizeConfiguration({ value: "x".repeat(100) }, 20), /configuration_too_large/);
  let deep = {};
  let cursor = deep;
  for (let i = 0; i < 26; i += 1) { cursor.next = {}; cursor = cursor.next; }
  assert.throws(() => canonicalizeConfiguration(deep), /configuration_depth_exceeded/);
  assert.throws(() => canonicalizeConfiguration({ values: Array(1001).fill(1) }), /configuration_array_too_large/);
  assert.throws(() => canonicalizeConfiguration({ a: 1 }, 0), /configuration_limit_invalid/);
});

test("computes standard SHA-256 and compares valid digests", async () => {
  const digest = await sha256Hex("abc", webcrypto);
  assert.equal(digest, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(equalDigest(digest, digest), true);
  assert.equal(equalDigest(digest, "a".repeat(64)), false);
  assert.equal(equalDigest("invalid", digest), false);
});

test("prepares a schema-bound canonical snapshot and recomputes digest", async () => {
  const result = await prepareConfigurationSnapshot({
    payload: { site: { name: "Field A" }, crop: ["olive"] },
    schemaId: "nova.client-config.v1",
    expectedSchemaId: "nova.client-config.v1",
    cryptoProvider: webcrypto,
  });
  assert.equal(result.schemaId, "nova.client-config.v1");
  assert.equal(result.contentSha256, await sha256Hex(result.canonicalJson, webcrypto));
  assert.deepEqual(result.payload, { crop: ["olive"], site: { name: "Field A" } });
  assert.equal(Object.isFrozen(result), true);
});

test("rejects unsupported schema IDs and digest mismatch", async () => {
  const base = { payload: { site: {} }, schemaId: "nova.client-config.v1",
    expectedSchemaId: "nova.client-config.v1", cryptoProvider: webcrypto };
  await assert.rejects(() => prepareConfigurationSnapshot({ ...base, expectedSchemaId: "other.v1" }),
    /configuration_schema_not_supported/);
  await assert.rejects(() => prepareConfigurationSnapshot({ ...base, suppliedDigest: "a".repeat(64) }),
    /configuration_digest_mismatch/);
});

test("does not silently accept a caller-selected payload size limit above policy", () => {
  assert.throws(() => canonicalizeConfiguration({ ok: true }, 65_537),
    /configuration_limit_invalid/);
});

const DEFAULT_MAX_BYTES = 64 * 1024;
const MAX_DEPTH = 24;
const MAX_NODES = 5000;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function canonicalValue(value, depth, budget) {
  if (depth > MAX_DEPTH) throw new Error("configuration_depth_exceeded");
  budget.nodes += 1;
  if (budget.nodes > MAX_NODES) throw new Error("configuration_complexity_exceeded");
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("configuration_non_finite_number");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    if (value.length > 1000) throw new Error("configuration_array_too_large");
    return "[" + value.map(item => canonicalValue(item, depth + 1, budget)).join(",") + "]";
  }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("configuration_value_not_json");
  }
  const keys = Object.keys(value).sort();
  for (const key of keys) {
    if (FORBIDDEN_KEYS.has(key)) throw new Error("configuration_forbidden_key");
  }
  return "{" + keys.map(key =>
    JSON.stringify(key) + ":" + canonicalValue(value[key], depth + 1, budget)
  ).join(",") + "}";
}

export function canonicalizeConfiguration(payload, maxBytes = DEFAULT_MAX_BYTES) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      Object.getPrototypeOf(payload) !== Object.prototype) {
    throw new Error("configuration_must_be_object");
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_MAX_BYTES) {
    throw new Error("configuration_limit_invalid");
  }
  const canonicalJson = canonicalValue(payload, 0, { nodes: 0 });
  const byteLength = new TextEncoder().encode(canonicalJson).byteLength;
  if (byteLength > maxBytes) throw new Error("configuration_too_large");
  return Object.freeze({ canonicalJson, byteLength });
}

export async function sha256Hex(value, cryptoProvider = globalThis.crypto) {
  if (!cryptoProvider?.subtle?.digest) throw new Error("configuration_crypto_unavailable");
  const digest = await cryptoProvider.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function equalDigest(left, right) {
  if (typeof left !== "string" || typeof right !== "string" ||
      !/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  let difference = 0;
  for (let i = 0; i < 64; i += 1) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}

export async function prepareConfigurationSnapshot({
  payload, schemaId, expectedSchemaId, suppliedDigest, maxBytes = DEFAULT_MAX_BYTES,
  cryptoProvider = globalThis.crypto,
}) {
  if (typeof schemaId !== "string" || !/^[a-z][a-z0-9._-]{1,119}$/.test(schemaId) ||
      schemaId !== expectedSchemaId) {
    throw new Error("configuration_schema_not_supported");
  }
  const { canonicalJson, byteLength } = canonicalizeConfiguration(payload, maxBytes);
  const contentSha256 = await sha256Hex(canonicalJson, cryptoProvider);
  if (suppliedDigest !== undefined && !equalDigest(suppliedDigest, contentSha256)) {
    throw new Error("configuration_digest_mismatch");
  }
  return Object.freeze({
    schemaId, canonicalJson, contentSha256, byteLength,
    payload: JSON.parse(canonicalJson),
  });
}

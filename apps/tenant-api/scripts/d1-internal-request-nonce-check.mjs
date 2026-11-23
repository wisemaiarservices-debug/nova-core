import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const requestId = "nova-ci-nonce-unique-constraint";
const args = [
  "--yes", "wrangler@4.13.2", "d1", "execute", "DB", "--local",
  "--config", "wrangler.d1-test.toml", "--persist-to", "./.wrangler-d1-test",
  "--command",
];

function execute(sql, json = false) {
  const result = spawnSync("npx", [...args, ...(json ? ["--json"] : []), sql], {
    encoding: "utf8",
  });
  const output = (result.stdout || "") + "\n" + (result.stderr || "");
  assert.equal(result.status, 0, "Local D1 command failed\n" + output);
  return result.stdout.trim();
}

function findNonceCount(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNonceCount(item);
      if (found !== undefined) return found;
    }
  } else if (value && typeof value === "object") {
    if (Object.hasOwn(value, "nonce_count")) return Number(value.nonce_count);
    for (const item of Object.values(value)) {
      const found = findNonceCount(item);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

try {
  execute("DELETE FROM internal_request_nonces WHERE request_id = '" + requestId + "'");
  const insert = "INSERT INTO internal_request_nonces (request_id, issued_at, expires_at) " +
    "VALUES ('" + requestId + "', 1900000000, 1900000600) " +
    "ON CONFLICT(request_id) DO NOTHING";
  execute(insert);
  execute("INSERT INTO internal_request_nonces (request_id, issued_at, expires_at) " +
    "VALUES ('" + requestId + "', 1900000001, 1900000601) " +
    "ON CONFLICT(request_id) DO NOTHING");

  const output = execute(
    "SELECT COUNT(*) AS nonce_count FROM internal_request_nonces WHERE request_id = '" +
      requestId + "'",
    true,
  );
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Wrangler --json output was not valid JSON: " + output);
  }
  assert.equal(findNonceCount(parsed), 1,
    "Duplicate request ID must leave exactly one nonce row; output: " + output);
  console.log("Internal request nonce primary-key uniqueness passed against local D1");
} finally {
  execute("DELETE FROM internal_request_nonces WHERE request_id = '" + requestId + "'");
}

import { authorizeServiceSource, parseServiceGrants, verifyAccessServiceToken } from "./access-auth.mjs";
import { validateObservationPayload } from "./observation-contract.mjs";
import { resolveObservationOwnership } from "./observation-ownership.mjs";
import { persistObservation } from "./observation-persistence.mjs";

const MAX_BODY_BYTES = 32 * 1024;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function readBoundedBody(request, timeoutMs = 10_000) {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(declared)) throw new Error("invalid_content_length");
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length > MAX_BODY_BYTES) {
      throw new Error("payload_too_large");
    }
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("request_body_timeout")), timeoutMs);
  });
  try {
    while (true) {
      const result = await Promise.race([reader.read(), deadline]);
      if (result.done) break;
      const chunk = result.value;
      if (!(chunk instanceof Uint8Array) || chunk.byteLength > MAX_BODY_BYTES - total) {
        throw new Error("payload_too_large");
      }
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  } catch (cause) {
    try { void reader.cancel(cause).catch(() => {}); } catch { /* Preserve the original read failure. */ }
    throw cause;
  } finally {
    clearTimeout(timer);
    try { reader.releaseLock(); } catch { /* Cancellation may still be settling. */ }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ status: "ok", service: "nova-core-ingest-api", mode: "guarded-auth-required" });
    }
    if (request.method !== "POST" || url.pathname !== "/api/v1/observations") {
      return json({ error: "not_found" }, 404);
    }

    const declaredLength = request.headers.get("content-length");
    if (declaredLength !== null) {
      if (!/^(0|[1-9][0-9]*)$/.test(declaredLength) ||
          !Number.isSafeInteger(Number(declaredLength))) {
        return json({ error: "invalid_content_length" }, 400);
      }
      if (Number(declaredLength) > MAX_BODY_BYTES) {
        return json({ error: "payload_too_large" }, 413);
      }
    }
    const issuer = env.ACCESS_ISSUER;
    const audience = env.ACCESS_AUDIENCE;
    const grantsJson = env.NOVA_SERVICE_GRANTS_JSON;
    if (!issuer || !audience || !grantsJson) {
      return json({ error: "ingestion_auth_not_configured" }, 503);
    }

    let grants;
    try {
      grants = parseServiceGrants(grantsJson);
    } catch {
      return json({ error: "ingestion_configuration_invalid" }, 503);
    }

    let principal;
    try {
      principal = await verifyAccessServiceToken(
        request.headers.get("Cf-Access-Jwt-Assertion"),
        { issuer, audience },
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : "";
      if (reason.startsWith("access_jwks_")) {
        return json({ error: "identity_provider_unavailable" }, 503);
      }
      if (reason === "invalid_access_issuer") {
        return json({ error: "ingestion_configuration_invalid" }, 503);
      }
      return json({ error: "request_not_authorized" }, 401);
    }

    const contentType = request.headers.get("content-type") || "";
    if (!/^application\/json(?:\s*;|\s*$)/i.test(contentType)) {
      return json({ error: "application_json_required" }, 415);
    }

    let bytes;
    try {
      bytes = await readBoundedBody(request);
    } catch (error) {
      if (error instanceof Error && error.message === "payload_too_large") {
        return json({ error: "payload_too_large" }, 413);
      }
      if (error instanceof Error && error.message === "request_body_timeout") {
        return json({ error: "request_body_timeout" }, 408);
      }
      if (error instanceof Error && error.message === "invalid_content_length") {
        return json({ error: "invalid_content_length" }, 400);
      }
      return json({ error: "invalid_request_body" }, 400);
    }

    let payload;
    try {
      payload = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    let observation;
    try {
      observation = validateObservationPayload(payload);
    } catch {
      return json({ error: "invalid_observation_payload" }, 400);
    }
    try {
      authorizeServiceSource(principal, observation.module, observation.source_id, grants);
    } catch {
      return json({ error: "request_not_authorized" }, 403);
    }

    if (!env.DB) {
      return json({ error: "storage_not_configured", status: "authenticated_but_not_accepted" }, 503);
    }
    let tenantId;
    try {
      tenantId = await resolveObservationOwnership(env.DB, observation);
      if (!tenantId) return json({ error: "request_not_authorized" }, 403);
    } catch {
      return json({ error: "storage_unavailable" }, 503);
    }

    try {
      const result = await persistObservation(
        env.DB,
        observation,
        principal,
        crypto.randomUUID(),
        tenantId,
      );
      if (result.status === "idempotency_conflict") {
        return json({ error: "idempotency_key_conflict", accepted: false }, 409);
      }
      return json(result, result.idempotent ? 200 : 201);
    } catch {
      // Fail closed. Do not reveal SQL, D1 binding details, or service identity.
      return json({ error: "storage_unavailable", accepted: false }, 503);
    }
  },
};

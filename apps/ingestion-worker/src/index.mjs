import { authorizeServiceSource, parseServiceGrants, verifyAccessServiceToken } from "./access-auth.mjs";

const MAX_BODY_BYTES = 32 * 1024;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ status: "ok", service: "nova-core-ingest-api", mode: "authenticated-ingestion-disabled" });
    }
    if (request.method !== "POST" || url.pathname !== "/api/v1/observations") {
      return json({ error: "not_found" }, 404);
    }

    const declaredLength = Number(request.headers.get("content-length") || "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      return json({ error: "payload_too_large" }, 413);
    }
    const issuer = env.ACCESS_ISSUER;
    const audience = env.ACCESS_AUDIENCE;
    const grantsJson = env.NOVA_SERVICE_GRANTS_JSON;
    if (!issuer || !audience || !grantsJson) return json({ error: "ingestion_auth_not_configured" }, 503);

    try {
      const token = request.headers.get("Cf-Access-Jwt-Assertion");
      const principal = await verifyAccessServiceToken(token, { issuer, audience });
      const grants = parseServiceGrants(grantsJson);
      const body = await request.arrayBuffer();
      if (body.byteLength > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413);

      let payload;
      try { payload = JSON.parse(new TextDecoder().decode(body)); } catch {
        return json({ error: "invalid_json" }, 400);
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return json({ error: "invalid_payload" }, 400);
      }
      authorizeServiceSource(principal, payload.module, payload.source_id, grants);

      // Deliberately no persistence until D1 is provisioned and ownership checks are wired.
      return json({
        error: "storage_not_configured",
        status: "authenticated_but_not_accepted",
        service_id: principal.serviceId,
      }, 503);
    } catch {
      return json({ error: "request_not_authorized" }, 401);
    }
  },
};

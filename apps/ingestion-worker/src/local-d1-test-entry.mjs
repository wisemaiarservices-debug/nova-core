import { createIngestionHandler } from "./ingestion-handler.mjs";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

// This local-only entrypoint delegates ingestion requests to the same handler
// used by the deployed Worker. Only the JWKS document and request ID source
// are injected; the production RS256, issuer, audience, service-grant,
// ownership, validation and persistence code all remain in the request path.
export default {
  async fetch(request, env) {
    if (env.CI_TEST_INGESTION !== "true" || !env.DB) return json({ error: "not_found" }, 404);
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/__ci/ingestion/state") {
      const source = url.searchParams.get("source");
      const key = url.searchParams.get("key");
      if (!source || !key) return json({ error: "invalid_query" }, 400);
      const observation = await env.DB.prepare(
        "SELECT id, tenant_id, site_id, asset_id, source_id, value, verification_status " +
        "FROM observations WHERE source_id = ? AND idempotency_key = ? LIMIT 1",
      ).bind(source, key).first();
      const audit = observation ? await env.DB.prepare(
        "SELECT id, tenant_id, actor_id, action, request_id FROM audit_events " +
        "WHERE entity_type = 'observation' AND entity_id = ?",
      ).bind(observation.id).all() : { results: [] };
      return json({ observation: observation ?? null, audit: audit.results });
    }

    const handler = createIngestionHandler({
      jwksResolver: async (issuer) => {
        if (issuer !== env.ACCESS_ISSUER) throw new Error("access_jwks_unavailable");
        let document;
        try { document = JSON.parse(env.CI_TEST_JWKS_JSON || ""); }
        catch { throw new Error("access_jwks_invalid"); }
        if (!Array.isArray(document.keys) || document.keys.length === 0) {
          throw new Error("access_jwks_invalid");
        }
        return document.keys;
      },
      requestIdFactory: (incoming) => incoming.headers.get("x-ci-request-id") || crypto.randomUUID(),
    });

    if (request.method === "POST" && url.pathname === "/api/v1/observations") {
      return handler(request, env);
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return handler(request, env);
    }
    return json({ error: "not_found" }, 404);
  },
};

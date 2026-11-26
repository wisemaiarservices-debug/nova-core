import { validateObservationPayload } from "./observation-contract.mjs";
import { resolveObservationOwnership } from "./observation-ownership.mjs";
import { persistObservation } from "./observation-persistence.mjs";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

// CI-only local D1 harness. This entrypoint deliberately bypasses Access JWT
// verification; auth/grant behavior is covered by worker.test.mjs. It exercises
// ownership SQL, D1 batch atomicity, idempotency and read-back against real local D1.
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
        "SELECT id, tenant_id, actor_id, action FROM audit_events WHERE entity_type = 'observation' AND entity_id = ?",
      ).bind(observation.id).all() : { results: [] };
      return json({ observation: observation ?? null, audit: audit.results });
    }
    if (request.method !== "POST" || url.pathname !== "/__ci/ingestion/accept") {
      return json({ error: "not_found" }, 404);
    }
    let body;
    try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
    let observation;
    try { observation = validateObservationPayload(body.observation); }
    catch { return json({ error: "invalid_observation_payload" }, 400); }
    try {
      const tenantId = await resolveObservationOwnership(env.DB, observation);
      if (!tenantId) return json({ error: "request_not_authorized" }, 403);
      const result = await persistObservation(
        env.DB, observation, { serviceId: "ci-local-ingestor" },
        typeof body.request_id === "string" ? body.request_id : "ci-local-ingestion",
        tenantId,
      );
      if (result.status === "idempotency_conflict") {
        return json({ error: "idempotency_key_conflict", accepted: false }, 409);
      }
      return json(result, result.idempotent ? 200 : 201);
    } catch {
      return json({ error: "storage_unavailable", accepted: false }, 503);
    }
  },
};

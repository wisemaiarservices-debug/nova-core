import worker from "./index.mjs";
import { createSiteConfiguration } from "./configuration-write-persistence.mjs";

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

// This entrypoint is referenced only by wrangler.d1-test.toml. It is not the
// production Worker entrypoint and exposes no production HTTP write route.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/__ci/configuration-write") {
      if (env.CI_TEST_CONFIGURATION_WRITES !== "true" || request.method !== "POST" || !env.DB) {
        return response({ error: "not_found" }, 404);
      }
      const length = Number(request.headers.get("content-length") || 0);
      if (length > 64 * 1024) return response({ error: "request_too_large" }, 413);
      let body;
      try {
        const bytes = await request.arrayBuffer();
        if (bytes.byteLength > 64 * 1024) return response({ error: "request_too_large" }, 413);
        body = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        return response({ error: "invalid_json" }, 400);
      }
      try {
        const result = await createSiteConfiguration({
          db: env.DB,
          principalSubject: "ci-human-subject",
          tenantId: body.tenantId,
          siteId: body.siteId,
          idempotencyKey: request.headers.get("idempotency-key"),
          requestId: body.requestId,
          payload: body.payload,
          schemaId: body.schemaId,
        });
        return response({ data: result });
      } catch (error) {
        const code = error instanceof Error ? error.message : "configuration_write_failed";
        const status = code === "configuration_idempotency_conflict" ? 409 :
          code === "configuration_authorization_denied" ? 403 : 400;
        return response({ error: code }, status);
      }
    }
    if (url.pathname === "/__ci/configuration-write-state") {
      if (env.CI_TEST_CONFIGURATION_WRITES !== "true" || request.method !== "GET" || !env.DB) {
        return response({ error: "not_found" }, 404);
      }
      const key = url.searchParams.get("key");
      if (!key) return response({ error: "key_required" }, 400);
      const [idem, configs, events, audits] = await Promise.all([
        env.DB.prepare("SELECT status, response_json FROM tenant_site_configuration_idempotency WHERE tenant_id = ? AND subject = ? AND idempotency_key = ?")
          .bind("tenant-http-a", "ci-human-subject", key).all(),
        env.DB.prepare("SELECT id, configuration_version FROM tenant_site_configurations WHERE tenant_id = ? AND site_id = ? ORDER BY CAST(substr(configuration_version, 2) AS INTEGER)")
          .bind("tenant-http-a", "site-http-a").all(),
        env.DB.prepare("SELECT id, event_type FROM tenant_site_configuration_events WHERE tenant_id = ? AND site_id = ?")
          .bind("tenant-http-a", "site-http-a").all(),
        env.DB.prepare("SELECT id, action, request_id FROM audit_events WHERE tenant_id = ? AND entity_type = 'site' AND entity_id = ? AND action = 'configuration.created_for_review'")
          .bind("tenant-http-a", "site-http-a").all(),
      ]);
      return response({
        idempotency: idem.results,
        configurations: configs.results,
        events: events.results,
        audits: audits.results,
      });
    }
    return worker.fetch(request, env);
  },
};

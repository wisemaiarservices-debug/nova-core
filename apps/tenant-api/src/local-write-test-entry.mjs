import { createTenantApi } from "./index.mjs";
import { verifyIdentityLinkIdentityPair } from "./identity-link-dual-verification.mjs";
import { verifySupabaseAccessToken } from "./supabase-access-auth.mjs";
import { createSiteConfiguration } from "./configuration-write-persistence.mjs";

let supabaseJwksDocument = null;
async function fetchLocalSupabaseJwks(url) {
  if (!supabaseJwksDocument || url !== "https://supabase-ci.example.test/auth/v1/.well-known/jwks.json") {
    return new Response("unavailable", { status: 503 });
  }
  return new Response(JSON.stringify(supabaseJwksDocument), {
    status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
const worker = createTenantApi({
  verifyIdentityPair: input => verifyIdentityLinkIdentityPair(input, fetchLocalSupabaseJwks),
  verifySupabaseToken: (token, config) => verifySupabaseAccessToken(token, config,
    undefined, fetchLocalSupabaseJwks),
});

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
    if (url.pathname === "/__ci/supabase-jwks") {
      if (env.CI_TEST_SUPABASE_JWKS !== "true" || request.method !== "POST") {
        return response({ error: "not_found" }, 404);
      }
      let body;
      try {
        const bytes = await request.arrayBuffer();
        if (bytes.byteLength > 8192) return response({ error: "request_too_large" }, 413);
        body = JSON.parse(new TextDecoder().decode(bytes));
      } catch { return response({ error: "invalid_jwks_fixture" }, 400); }
      if (!body || Array.isArray(body) || !Array.isArray(body.keys) || body.keys.length !== 1 ||
          !body.keys[0] || body.keys[0].kty !== "RSA" || typeof body.keys[0].kid !== "string" ||
          typeof body.keys[0].n !== "string" || typeof body.keys[0].e !== "string" ||
          body.keys[0].alg !== "RS256" || body.keys[0].use !== "sig") {
        return response({ error: "invalid_jwks_fixture" }, 400);
      }
      supabaseJwksDocument = body;
      return response({ data: { configured: true } });
    }
    if (url.pathname === "/__ci/identity-link-state") {
      if (env.CI_TEST_SUPABASE_JWKS !== "true" || request.method !== "GET" || !env.DB) {
        return response({ error: "not_found" }, 404);
      }
      const challengeId = url.searchParams.get("challenge_id");
      const requestId = url.searchParams.get("request_id");
      if (!challengeId || !requestId) return response({ error: "invalid_fixture_scope" }, 400);
      const [challenge, linkRequest, challengeColumns, requestColumns, events] = await Promise.all([
        env.DB.prepare("SELECT id, challenge_sha256, status, expires_at FROM tenant_identity_link_challenges WHERE id = ? LIMIT 2")
          .bind(challengeId).all(),
        env.DB.prepare("SELECT id, status, supabase_issuer, supabase_subject, cloudflare_issuer, cloudflare_subject FROM tenant_identity_link_requests WHERE id = ? LIMIT 2")
          .bind(requestId).all(),
        env.DB.prepare("PRAGMA table_info(tenant_identity_link_challenges)").all(),
        env.DB.prepare("PRAGMA table_info(tenant_identity_link_requests)").all(),
        env.DB.prepare("SELECT event_type FROM tenant_identity_link_events WHERE link_request_id = ? ORDER BY rowid")
          .bind(requestId).all(),
      ]);
      return response({
        challenge: challenge.results?.length === 1 ? challenge.results[0] : null,
        request: linkRequest.results?.length === 1 ? linkRequest.results[0] : null,
        challenge_columns: (challengeColumns.results || []).map(row => row.name),
        request_columns: (requestColumns.results || []).map(row => row.name),
        event_types: (events.results || []).map(row => row.event_type),
      });
    }
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
      const tenantId = url.searchParams.get("tenant") || "tenant-http-a";
      const siteId = tenantId === "tenant-http-a" ? "site-http-a" :
        tenantId === "tenant-http-b" ? "site-http-b" : null;
      if (!key || !siteId) return response({ error: "invalid_fixture_scope" }, 400);
      const [idem, configs, events, audits] = await Promise.all([
        env.DB.prepare("SELECT status, response_json FROM tenant_site_configuration_idempotency WHERE tenant_id = ? AND subject = ? AND idempotency_key = ?")
          .bind(tenantId, "ci-human-subject", key).all(),
        env.DB.prepare("SELECT id, configuration_version FROM tenant_site_configurations WHERE tenant_id = ? AND site_id = ? ORDER BY CAST(substr(configuration_version, 2) AS INTEGER)")
          .bind(tenantId, siteId).all(),
        env.DB.prepare("SELECT id, event_type FROM tenant_site_configuration_events WHERE tenant_id = ? AND site_id = ?")
          .bind(tenantId, siteId).all(),
        env.DB.prepare("SELECT id, action, request_id FROM audit_events WHERE tenant_id = ? AND entity_type = 'site' AND entity_id = ? AND action = 'configuration.created_for_review'")
          .bind(tenantId, siteId).all(),
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

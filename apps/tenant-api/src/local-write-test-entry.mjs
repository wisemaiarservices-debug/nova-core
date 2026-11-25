import worker from "./index.mjs";
import { createSiteConfiguration } from "./configuration-write-persistence.mjs";
import {
  createSourceEvidenceDocument,
  createSourceDataRightsDeclaration,
} from "./source-evidence-rights-persistence.mjs";

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
    if (url.pathname === "/__ci/source-evidence-write" || url.pathname === "/__ci/source-rights-write") {
      if (env.CI_TEST_CONFIGURATION_WRITES !== "true" || request.method !== "POST" || !env.DB) {
        return response({ error: "not_found" }, 404);
      }
      let body;
      try {
        const bytes = await request.arrayBuffer();
        if (bytes.byteLength > 64 * 1024) return response({ error: "request_too_large" }, 413);
        body = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        return response({ error: "invalid_json" }, 400);
      }
      try {
        const common = {
          db: env.DB,
          principalSubject: "ci-human-subject",
          tenantId: "tenant-http-a",
          siteId: "site-http-a",
          sourceId: "source-http-a",
          idempotencyKey: body.idempotencyKey,
          requestId: body.requestId,
        };
        const result = url.pathname === "/__ci/source-evidence-write"
          ? await createSourceEvidenceDocument({
              ...common,
              draft: {
                document_type: "data_license",
                file_name: "atomic-rollback.pdf",
                media_type: "application/pdf",
                issuer_name: "CI synthetic provider",
                document_reference: body.requestId,
                issued_at: "2026-01-01T00:00:00Z",
                effective_from: "2026-01-01T00:00:00Z",
                effective_to: "2027-01-01T00:00:00Z",
                document_bytes: new TextEncoder().encode("%PDF-1.7"),
              },
            })
          : await createSourceDataRightsDeclaration({
              ...common,
              draft: {
                asset_id: null,
                supporting_evidence_id: "source-evidence:ci-http-a",
                provider_name: "CI synthetic provider",
                controller_name: "NeoHaven CI tenant controller",
                basis_type: "license",
                instrument_reference: body.requestId,
                permitted_purposes: ["measurement_ingestion", "analytics"],
                restrictions: [],
                effective_from: "2026-01-01T00:00:00Z",
                effective_to: "2027-01-01T00:00:00Z",
              },
            });
        return response({ data: result });
      } catch (error) {
        return response({ error: error instanceof Error ? error.message : "source_write_failed" }, 400);
      }
    }
    if (url.pathname === "/__ci/source-write-state") {
      if (env.CI_TEST_CONFIGURATION_WRITES !== "true" || request.method !== "GET" || !env.DB) {
        return response({ error: "not_found" }, 404);
      }
      const kind = url.searchParams.get("kind");
      const requestId = url.searchParams.get("request");
      const key = url.searchParams.get("key");
      if (!["evidence", "rights"].includes(kind) || !requestId || !key) {
        return response({ error: "invalid_fixture_scope" }, 400);
      }
      const evidence = kind === "evidence";
      const [audit, business, events, ledger] = await Promise.all([
        env.DB.prepare("SELECT id FROM audit_events WHERE tenant_id=? AND request_id=? AND action=?")
          .bind("tenant-http-a", requestId, evidence ? "source_evidence.registered" : "source_data_rights.declared").all(),
        env.DB.prepare(evidence
          ? "SELECT id FROM source_evidence_documents WHERE tenant_id=? AND request_id=?"
          : "SELECT id FROM source_data_rights_declarations WHERE tenant_id=? AND request_id=?")
          .bind("tenant-http-a", requestId).all(),
        env.DB.prepare(evidence
          ? "SELECT id FROM source_evidence_events WHERE tenant_id=? AND request_id=?"
          : "SELECT id FROM source_data_rights_events WHERE tenant_id=? AND request_id=?")
          .bind("tenant-http-a", requestId).all(),
        env.DB.prepare(evidence
          ? "SELECT id FROM source_evidence_document_requests WHERE tenant_id=? AND idempotency_key=?"
          : "SELECT id FROM source_data_rights_declaration_requests WHERE tenant_id=? AND idempotency_key=?")
          .bind("tenant-http-a", key).all(),
      ]);
      return response({
        audit: audit.results,
        business: business.results,
        events: events.results,
        ledger: ledger.results,
      });
    }
    return worker.fetch(request, env);
  },
};

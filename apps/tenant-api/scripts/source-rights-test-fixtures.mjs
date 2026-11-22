export const SOURCE_RIGHTS_FIXTURES = Object.freeze({
  "source-http-a": Object.freeze({
    evidenceId: "source-evidence:ci-http-a",
    evidenceDigest: "bb5b9fc18952747104dadaaf55dd63cb2c0fad40bc4366843aaf1670b5220e82",
    declarationId: "source-rights:ci-http-a",
    declarationDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  }),
  "source-http-grant": Object.freeze({
    evidenceId: "source-evidence:ci-http-grant",
    evidenceDigest: "bb5b9fc18952747104dadaaf55dd63cb2c0fad40bc4366843aaf1670b5220e82",
    declarationId: "source-rights:ci-http-grant",
    declarationDigest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  }),
});

const q = value => "'" + String(value).replaceAll("'", "''") + "'";
const pdfHex = "255044462D43492D53594E544845544943";
const effectiveFrom = "2026-01-01T00:00:00Z";
const effectiveTo = "2027-01-01T00:00:00Z";

/** Return deterministic, synthetic evidence + independently approved rights SQL for a CI source. */
export function sourceRightsFixtureSql(sourceId) {
  const fixture = SOURCE_RIGHTS_FIXTURES[sourceId];
  if (!fixture) throw new Error("unknown_source_rights_fixture");
  const { evidenceId:e, evidenceDigest:d, declarationId:r, declarationDigest:rd } = fixture;
  const p = "ci-human-subject", reviewer = "ci-measurement-reviewer";
  const evidenceRequest = "req-" + sourceId + "-evidence";
  const evidenceVerifyRequest = "req-" + sourceId + "-evidence-verified";
  const rightsRequest = "req-" + sourceId + "-rights";
  const rightsApproveRequest = "req-" + sourceId + "-rights-approved";
  const audit = (id, actor, action, type, entity, request, details) =>
    `INSERT INTO audit_events (id,tenant_id,actor_type,actor_id,action,entity_type,entity_id,occurred_at,request_id,details_json)
     VALUES (${q(id)},'tenant-http-a','operator',${q(actor)},${q(action)},${q(type)},${q(entity)},
     strftime('%Y-%m-%dT%H:%M:%fZ','now'),${q(request)},${q(JSON.stringify(details))});`;
  return [
    audit("audit-"+sourceId+"-evidence",p,"source_evidence.registered","source_evidence_document",e,evidenceRequest,{evidence_id:e,sha256:d}),
    `INSERT INTO source_evidence_documents
      (id,tenant_id,site_id,source_id,document_type,file_name,media_type,byte_length,sha256,document_bytes,
       issuer_name,document_reference,issued_at,effective_from,effective_to,uploaded_by_subject,request_id)
      VALUES (${q(e)},'tenant-http-a','site-http-a',${q(sourceId)},'data_license','ci-license.pdf',
       'application/pdf',17,${q(d)},X'${pdfHex}','Synthetic CI provider','CI-LICENSE-'+${q(sourceId)},
       '2026-01-01T00:00:00Z',${q(effectiveFrom)},${q(effectiveTo)},${q(p)},${q(evidenceRequest)});`,
    audit("audit-"+sourceId+"-evidence-verified",reviewer,"source_evidence.verified","source_evidence_document",e,evidenceVerifyRequest,{evidence_id:e,sha256:d}),
    `INSERT INTO source_evidence_events
      (id,evidence_id,tenant_id,site_id,source_id,actor_subject,event_type,reviewed_sha256,reason,request_id)
      VALUES (${q("event-"+sourceId+"-evidence-registered")},${q(e)},'tenant-http-a','site-http-a',${q(sourceId)},
       ${q(p)},'registered',${q(d)},NULL,${q(evidenceRequest)});`,
    `INSERT INTO source_evidence_events
      (id,evidence_id,tenant_id,site_id,source_id,actor_subject,event_type,reviewed_sha256,reason,request_id)
      VALUES (${q("event-"+sourceId+"-evidence-verified")},${q(e)},'tenant-http-a','site-http-a',${q(sourceId)},
       ${q(reviewer)},'verified',${q(d)},NULL,${q(evidenceVerifyRequest)});`,
    audit("audit-"+sourceId+"-rights",p,"source_data_rights.declared","source_data_rights_declaration",r,rightsRequest,{declaration_id:r,evidence_id:e}),
    `INSERT INTO source_data_rights_declarations
      (id,tenant_id,site_id,source_id,asset_id,supporting_evidence_id,supporting_evidence_sha256,
       provider_name,controller_name,basis_type,instrument_reference,permitted_purposes_json,restrictions_json,
       effective_from,effective_to,declaration_sha256,declared_by_subject,request_id)
      VALUES (${q(r)},'tenant-http-a','site-http-a',${q(sourceId)},NULL,${q(e)},${q(d)},
       'Synthetic CI provider','CI tenant controller','license','CI-LICENSE-'+${q(sourceId)},
       '["measurement_ingestion","storage"]','[]',${q(effectiveFrom)},${q(effectiveTo)},${q(rd)},
       ${q(p)},${q(rightsRequest)});`,
    `INSERT INTO source_data_rights_events
      (id,declaration_id,tenant_id,site_id,source_id,actor_subject,event_type,reviewed_declaration_sha256,
       reviewed_evidence_sha256,reason,request_id)
      VALUES (${q("event-"+sourceId+"-rights-declared")},${q(r)},'tenant-http-a','site-http-a',${q(sourceId)},
       ${q(p)},'declared',${q(rd)},${q(d)},NULL,${q(rightsRequest)});`,
    audit("audit-"+sourceId+"-rights-approved",reviewer,"source_data_rights.approved","source_data_rights_declaration",r,rightsApproveRequest,{declaration_id:r,evidence_id:e}),
    `INSERT INTO source_data_rights_events
      (id,declaration_id,tenant_id,site_id,source_id,actor_subject,event_type,reviewed_declaration_sha256,
       reviewed_evidence_sha256,reason,request_id)
      VALUES (${q("event-"+sourceId+"-rights-approved")},${q(r)},'tenant-http-a','site-http-a',${q(sourceId)},
       ${q(reviewer)},'approved',${q(rd)},${q(d)},NULL,${q(rightsApproveRequest)});`,
  ].join("\n");
}

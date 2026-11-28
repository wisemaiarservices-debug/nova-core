export const SOURCE_RIGHTS_FIXTURES = Object.freeze({
  "source-http-a": Object.freeze({
    sourceId: "source-http-a", assetId: null, pdfHex: "255044462D43492D53594E544845544943", byteLength: 17,
    evidenceId: "source-evidence:ci-http-a",
    evidenceDigest: "bb5b9fc18952747104dadaaf55dd63cb2c0fad40bc4366843aaf1670b5220e82",
    declarationId: "source-rights:ci-http-a",
    declarationDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  }),
  "source-http-a-asset": Object.freeze({
    sourceId: "source-http-a", assetId: "asset-http-grant", pdfHex: "255044462D43492D53594E5448455449432D41", byteLength: 19,
    evidenceId: "source-evidence:ci-http-a-asset",
    evidenceDigest: "4792ef01e3b5a24340d2c12d8739ccf98813afef83fad19b6d37de9e75b806dd",
    declarationId: "source-rights:ci-http-a-asset",
    declarationDigest: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  }),
  "source-http-grant": Object.freeze({
    sourceId: "source-http-grant", assetId: null, pdfHex: "255044462D43492D53594E5448455449432D42", byteLength: 19,
    evidenceId: "source-evidence:ci-http-grant",
    evidenceDigest: "4318c92710ae19a064071f683dd4dd1fabbb1c67be0cce234302fbf8690a63b5",
    declarationId: "source-rights:ci-http-grant",
    declarationDigest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  }),
  "source-http-grant-asset": Object.freeze({
    sourceId: "source-http-grant", assetId: "asset-http-grant", pdfHex: "255044462D43492D53594E5448455449432D43", byteLength: 19,
    evidenceId: "source-evidence:ci-http-grant-asset",
    evidenceDigest: "5df2ee69a0617d6ce6522a0f6e6e66e33d0d56cffc9fcecc95074fbc870620ee",
    declarationId: "source-rights:ci-http-grant-asset",
    declarationDigest: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  }),
});

const q = value => "'" + String(value).replaceAll("'", "''") + "'";
const effectiveFrom = "2026-01-01T00:00:00Z";
const effectiveTo = "2027-01-01T00:00:00Z";

/** Return deterministic, synthetic evidence + independently approved rights SQL for a CI source. */
export function sourceRightsFixtureSql(fixtureKey) {
  const fixture = SOURCE_RIGHTS_FIXTURES[fixtureKey];
  if (!fixture) throw new Error("unknown_source_rights_fixture");
  const { sourceId, assetId, pdfHex, byteLength, evidenceId:e, evidenceDigest:d, declarationId:r, declarationDigest:rd } = fixture;
  const fixtureTag = fixtureKey.replaceAll("-", "_");
  const p = "ci-human-subject", reviewer = "ci-measurement-reviewer";
  const evidenceRequest = "req-" + fixtureTag + "-evidence";
  const evidenceVerifyRequest = "req-" + fixtureTag + "-evidence-verified";
  const rightsRequest = "req-" + fixtureTag + "-rights";
  const rightsApproveRequest = "req-" + fixtureTag + "-rights-approved";
  const audit = (id, actor, action, type, entity, request, details) =>
    `INSERT INTO audit_events (id,tenant_id,actor_type,actor_id,action,entity_type,entity_id,occurred_at,request_id,details_json)
     VALUES (${q(id)},'tenant-http-a','operator',${q(actor)},${q(action)},${q(type)},${q(entity)},
     strftime('%Y-%m-%dT%H:%M:%fZ','now'),${q(request)},${q(JSON.stringify(details))});`;
  return [
    audit("audit-"+fixtureTag+"-evidence",p,"source_evidence.registered","source_evidence_document",e,evidenceRequest,{evidence_id:e,sha256:d}),
    `INSERT INTO source_evidence_documents
      (id,tenant_id,site_id,source_id,document_type,file_name,media_type,byte_length,sha256,document_bytes,
       issuer_name,document_reference,issued_at,effective_from,effective_to,uploaded_by_subject,request_id)
      VALUES (${q(e)},'tenant-http-a','site-http-a',${q(sourceId)},'data_license','ci-license.pdf',
       'application/pdf',${byteLength},${q(d)},X'${pdfHex}','Synthetic CI provider',${q('CI-LICENSE-'+sourceId)},
       '2026-01-01T00:00:00Z',${q(effectiveFrom)},${q(effectiveTo)},${q(p)},${q(evidenceRequest)});`,
    audit("audit-"+fixtureTag+"-evidence-verified",reviewer,"source_evidence.verified","source_evidence_document",e,evidenceVerifyRequest,{evidence_id:e,sha256:d}),
    `INSERT INTO source_evidence_events
      (id,evidence_id,tenant_id,site_id,source_id,actor_subject,event_type,reviewed_sha256,reason,request_id)
      VALUES (${q("event-"+fixtureTag+"-evidence-registered")},${q(e)},'tenant-http-a','site-http-a',${q(sourceId)},
       ${q(p)},'registered',${q(d)},NULL,${q(evidenceRequest)});`,
    `INSERT INTO source_evidence_events
      (id,evidence_id,tenant_id,site_id,source_id,actor_subject,event_type,reviewed_sha256,reason,request_id)
      VALUES (${q("event-"+fixtureTag+"-evidence-verified")},${q(e)},'tenant-http-a','site-http-a',${q(sourceId)},
       ${q(reviewer)},'verified',${q(d)},NULL,${q(evidenceVerifyRequest)});`,
    audit("audit-"+fixtureTag+"-rights",p,"source_data_rights.declared","source_data_rights_declaration",r,rightsRequest,{declaration_id:r,evidence_id:e}),
    `INSERT INTO source_data_rights_declarations
      (id,tenant_id,site_id,source_id,asset_id,supporting_evidence_id,supporting_evidence_sha256,
       provider_name,controller_name,basis_type,instrument_reference,permitted_purposes_json,restrictions_json,
       effective_from,effective_to,declaration_sha256,declared_by_subject,request_id)
      VALUES (${q(r)},'tenant-http-a','site-http-a',${q(sourceId)},${assetId === null ? 'NULL' : q(assetId)},${q(e)},${q(d)},
       'Synthetic CI provider','CI tenant controller','license',${q('CI-LICENSE-'+sourceId)},
       '["measurement_ingestion","storage"]','[]',${q(effectiveFrom)},${q(effectiveTo)},${q(rd)},
       ${q(p)},${q(rightsRequest)});`,
    `INSERT INTO source_data_rights_events
      (id,declaration_id,tenant_id,site_id,source_id,actor_subject,event_type,reviewed_declaration_sha256,
       reviewed_evidence_sha256,reason,request_id)
      VALUES (${q("event-"+fixtureTag+"-rights-declared")},${q(r)},'tenant-http-a','site-http-a',${q(sourceId)},
       ${q(p)},'declared',${q(rd)},${q(d)},NULL,${q(rightsRequest)});`,
    audit("audit-"+fixtureTag+"-rights-approved",reviewer,"source_data_rights.approved","source_data_rights_declaration",r,rightsApproveRequest,{declaration_id:r,evidence_id:e}),
    `INSERT INTO source_data_rights_events
      (id,declaration_id,tenant_id,site_id,source_id,actor_subject,event_type,reviewed_declaration_sha256,
       reviewed_evidence_sha256,reason,request_id)
      VALUES (${q("event-"+fixtureTag+"-rights-approved")},${q(r)},'tenant-http-a','site-http-a',${q(sourceId)},
       ${q(reviewer)},'approved',${q(rd)},${q(d)},NULL,${q(rightsApproveRequest)});`,
  ].join("\n");
}

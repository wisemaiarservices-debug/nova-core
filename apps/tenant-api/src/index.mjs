import { json, error } from "./http.mjs";
import { validateWaterQualityCriteriaRegistryEntry, resolveApprovedWaterQualityCriteria } from "./water-quality-criteria-registry.mjs";
import { assessWaterQualityAgainstDeclaredCriteria } from "./water-quality-criteria-assessment.mjs";
import { resolveWaterQualitySampleEvidence } from "./water-quality-sample-evidence.mjs";
import { assignObservationReviewer, reviewObservation } from "./observation-verification.mjs";
import { registerLaboratoryReportEvidence, readLaboratoryReportEvidence } from "./laboratory-report-evidence.mjs";
import { registerSensorCalibration } from "./sensor-calibration.mjs";
import { assignCalibrationReviewer, reviewSensorCalibration } from "./sensor-calibration-verification.mjs";
import { registerSensorSourceMapping, reviewSensorSourceMapping, assignSensorSourceMappingReviewer } from "./sensor-source-identity.mjs";
import { registerMeasurementQualityPolicy, reviewMeasurementQualityPolicy, assessMeasurementQuality } from "./measurement-quality.mjs";

const ROLE_ACTIONS = {
  tenant_owner: new Set(["read", "create", "update", "delete", "ingest", "manage_members"]),
  tenant_admin: new Set(["read", "create", "update", "delete", "ingest"]),
  operator: new Set(["read", "ingest"]), analyst: new Set(["read"]),
  viewer: new Set(["read"]), service: new Set(["read", "ingest"]),
};
const RESOURCE_SQL = {
  site: "SELECT id, tenant_id, name, description, latitude, longitude, timezone, status, metadata_json, created_at, updated_at FROM sites WHERE tenant_id = ? AND id = ? LIMIT 1",
  asset: "SELECT id, tenant_id, site_id, name, asset_type, external_ref, status, metadata_json, created_at, updated_at FROM assets WHERE tenant_id = ? AND id = ? LIMIT 1",
  source: "SELECT id, tenant_id, site_id, module, provider, source_type, display_name, verification_status, verification_method, license_reference, metadata_json, created_at, updated_at FROM sources WHERE tenant_id = ? AND id = ? LIMIT 1",
  observation: "SELECT id, tenant_id, site_id, asset_id, source_id, module, metric, value, unit, observed_at, ingested_at, verification_status, provenance_json, quality_flags_json, retention_until FROM observations WHERE tenant_id = ? AND id = ? LIMIT 1",
  audit_event: "SELECT id, tenant_id, actor_type, actor_id, action, entity_type, entity_id, occurred_at, request_id, details_json FROM audit_events WHERE tenant_id = ? AND id = ? LIMIT 1",
};
function validSubject(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 200 &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}
function validId(value, max = 160) {
  return typeof value === "string" && value.length > 0 && value.length <= max &&
    value.trim() === value && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}
function canonicalEnvelope(method, path, headers) {
  return JSON.stringify([method, path,
    headers.get("x-nova-verified-subject"),
    headers.get("x-nova-verified-issuer"),
    headers.get("x-nova-verified-audience"),
    headers.get("x-nova-gateway-issued-at"),
    headers.get("x-nova-request-id")]);
}
async function verifyEnvelope(secret, method, path, headers) {
  if (typeof secret !== "string" || secret.length < 32) return false;
  const encoded = headers.get("x-nova-internal-signature");
  if (typeof encoded !== "string" || !/^[a-f0-9]{64}$/.test(encoded)) return false;
  try {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const signature = Uint8Array.from(encoded.match(/.{2}/g), pair => parseInt(pair, 16));
    return await crypto.subtle.verify("HMAC", key, signature,
      new TextEncoder().encode(canonicalEnvelope(method, path, headers)));
  } catch { return false; }
}
async function rows(statement) {
  const result = await statement.all();
  if (!result || !Array.isArray(result.results)) throw new Error("storage_invalid_result");
  return result.results;
}
async function consumeRequestId(db, requestId, issuedAt) {
  const result = await db.prepare(
    "INSERT INTO internal_request_nonces (request_id, issued_at, expires_at) VALUES (?, ?, ?) ON CONFLICT(request_id) DO NOTHING"
  ).bind(requestId, issuedAt, issuedAt + 600).run();
  if (!result || !result.meta || !Number.isInteger(result.meta.changes)) {
    throw new Error("nonce_storage_invalid_result");
  }
  return result.meta.changes === 1;
}
async function readResource(db, subject, tenant, type, id) {
  const membership = await rows(db.prepare(
    "SELECT m.subject, m.tenant_id, m.role, m.status AS membership_status, t.status AS tenant_status FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.subject = ? AND m.tenant_id = ? LIMIT 2"
  ).bind(subject, tenant));
  if (membership.length !== 1) return null;
  const m = membership[0];
  if (m.subject !== subject || m.tenant_id !== tenant || m.membership_status !== "active" ||
      m.tenant_status !== "active" || !ROLE_ACTIONS[m.role]?.has("read")) return null;
  const grantRows = await rows(db.prepare(
    "SELECT subject, tenant_id, resource_type, resource_id, action FROM tenant_resource_grants WHERE tenant_id = ? AND subject = ? AND resource_type = ? AND resource_id = ?"
  ).bind(tenant, subject, type, id));
  if (!grantRows.some(g => g.subject === subject && g.tenant_id === tenant &&
      g.resource_type === type && g.resource_id === id && g.action === "read")) return null;
  const record = await rows(db.prepare(RESOURCE_SQL[type]).bind(tenant, id));
  if (record.length !== 1 || record[0].tenant_id !== tenant || record[0].id !== id) return null;
  return record[0];
}

function onlyKeys(value, allowed) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every(key => allowed.includes(key));
}
async function createCriteriaDraft(db, tenant, subject, requestId, entry) {
  if (!onlyKeys(entry, ["id", "jurisdiction", "title", "version", "published_on",
      "effective_from", "effective_to", "authority", "scope", "criteria", "review",
      "supersedes_id", "supersedes_version"])) {
    return { error: "criteria_entry_invalid", status: 422, details: [{ code: "entry.invalid_type", path: "$" }] };
  }
  if (!validId(entry.id) || !validId(entry.version, 80) ||
      typeof entry.jurisdiction !== "string" || entry.jurisdiction.trim() !== entry.jurisdiction ||
      entry.jurisdiction.length < 1 || entry.jurisdiction.length > 120 ||
      typeof entry.title !== "string" || entry.title.trim() !== entry.title ||
      entry.title.length < 1 || entry.title.length > 300 ||
      !onlyKeys(entry.authority, ["name", "source_evidence_ref", "document_digest"]) ||
      !onlyKeys(entry.scope, ["tenant_id", "site_id", "crop_ids", "irrigation_methods", "intended_uses"]) ||
      !onlyKeys(entry.review, ["status", "approvals"]) ||
      !Array.isArray(entry.criteria) ||
      entry.criteria.some(rule => !onlyKeys(rule, ["parameter", "unit", "operator", "reference_clause",
        "evidence_ref", "value", "minimum", "maximum"])) ||
      entry.scope?.tenant_id !== tenant || entry.review?.status !== "draft" ||
      (entry.review.approvals !== undefined &&
       (!Array.isArray(entry.review.approvals) || entry.review.approvals.length !== 0))) {
    return { error: "criteria_draft_scope_or_state_invalid", status: 400 };
  }
  const siteId = entry.scope.site_id ?? null;
  if (siteId !== null && !validId(siteId)) return { error: "criteria_site_id_invalid", status: 400 };
  const supersedesId = entry.supersedes_id ?? null;
  const supersedesVersion = entry.supersedes_version ?? null;
  if ((supersedesId === null) !== (supersedesVersion === null) ||
      (supersedesId !== null && (!validId(supersedesId) || !validId(supersedesVersion, 80)))) {
    return { error: "criteria_supersession_reference_invalid", status: 400 };
  }
  const validation = validateWaterQualityCriteriaRegistryEntry(entry);
  if (!validation.valid) return { error: "criteria_entry_invalid", status: 422, details: validation.errors };
  const documentDigest = entry.authority.document_digest.slice("sha256:".length).toLowerCase();
  const eventId = crypto.randomUUID();
  const insertEntry = db.prepare(
    "INSERT INTO water_quality_criteria_entries (id, tenant_id, site_id, jurisdiction, version, title, entry_json, source_document_sha256, source_evidence_ref, published_on, effective_from, effective_to, supersedes_entry_id, supersedes_entry_version, created_by_subject) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(entry.id, tenant, siteId, entry.jurisdiction, entry.version, entry.title,
    JSON.stringify(entry), documentDigest, entry.authority.source_evidence_ref,
    entry.published_on, entry.effective_from, entry.effective_to ?? null,
    supersedesId, supersedesVersion, subject);
  const insertEvent = db.prepare(
    "INSERT INTO water_quality_criteria_events (id, tenant_id, entry_id, entry_version, event_type, actor_subject, request_id) VALUES (?, ?, ?, ?, 'draft_created', ?, ?)"
  ).bind(eventId, tenant, entry.id, entry.version, subject, requestId);
  const results = await db.batch([insertEntry, insertEvent]);
  if (!Array.isArray(results) || results.length !== 2 ||
      results.some(result => !result?.meta || result.meta.changes !== 1)) {
    throw new Error("criteria_draft_batch_incomplete");
  }
  return { data: { id: entry.id, version: entry.version, jurisdiction: entry.jurisdiction,
    site_id: siteId, status: "draft", created_by_subject: subject }, status: 201 };
}
 

async function provisionCriteriaReviewer(db, tenant, actor, requestId, body, action) {
  const allowed = action === "assign"
    ? ["reviewer_subject", "reviewer_role", "jurisdiction", "evidence_ref"]
    : ["reviewer_subject", "reviewer_role", "jurisdiction", "evidence_ref", "reason"];
  if (!onlyKeys(body, allowed) || !validSubject(body.reviewer_subject) ||
      body.reviewer_subject === actor ||
      !["regulatory_reviewer", "domain_expert"].includes(body.reviewer_role) ||
      typeof body.jurisdiction !== "string" || body.jurisdiction.trim() !== body.jurisdiction ||
      body.jurisdiction.length < 1 || body.jurisdiction.length > 120 ||
      typeof body.evidence_ref !== "string" || body.evidence_ref.trim() !== body.evidence_ref ||
      body.evidence_ref.length < 1 || body.evidence_ref.length > 500 ||
      (action === "revoke" && (typeof body.reason !== "string" ||
        body.reason.trim() !== body.reason || body.reason.length < 1 || body.reason.length > 2000))) {
    return { error: "reviewer_provisioning_request_invalid", status: 400 };
  }
  const eventId = crypto.randomUUID();
  const first = action === "assign"
    ? db.prepare("INSERT INTO water_quality_criteria_reviewers (tenant_id, reviewer_subject, reviewer_role, jurisdiction, status, assigned_by_subject, assignment_evidence_ref) VALUES (?, ?, ?, ?, 'active', ?, ?) ON CONFLICT(tenant_id, reviewer_subject, reviewer_role) DO NOTHING")
        .bind(tenant, body.reviewer_subject, body.reviewer_role, body.jurisdiction, actor, body.evidence_ref)
    : db.prepare("UPDATE water_quality_criteria_reviewers SET status = 'revoked' WHERE tenant_id = ? AND reviewer_subject = ? AND reviewer_role = ? AND jurisdiction = ? AND status = 'active'")
        .bind(tenant, body.reviewer_subject, body.reviewer_role, body.jurisdiction);
  const second = action === "assign"
    ? db.prepare("INSERT INTO water_quality_criteria_reviewer_events (id, tenant_id, reviewer_subject, reviewer_role, jurisdiction, event_type, actor_subject, evidence_ref, request_id) SELECT ?, ?, ?, ?, ?, 'assigned', ?, ?, ? WHERE changes() = 1")
        .bind(eventId, tenant, body.reviewer_subject, body.reviewer_role, body.jurisdiction, actor, body.evidence_ref, requestId)
    : db.prepare("INSERT INTO water_quality_criteria_reviewer_events (id, tenant_id, reviewer_subject, reviewer_role, jurisdiction, event_type, actor_subject, evidence_ref, reason, request_id) SELECT ?, ?, ?, ?, ?, 'revoked', ?, ?, ?, ? WHERE changes() = 1")
        .bind(eventId, tenant, body.reviewer_subject, body.reviewer_role, body.jurisdiction, actor, body.evidence_ref, body.reason, requestId);
  const results = await db.batch([first, second]);
  if (!Array.isArray(results) || results.length !== 2 ||
      results.some(result => !result?.meta || !Number.isInteger(result.meta.changes))) {
    throw new Error("criteria_reviewer_batch_invalid");
  }
  if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1) {
    return { error: action === "assign" ? "reviewer_assignment_conflict" : "active_reviewer_not_found", status: action === "assign" ? 409 : 404 };
  }
  return { data: { reviewer_subject: body.reviewer_subject, reviewer_role: body.reviewer_role,
    jurisdiction: body.jurisdiction, status: action === "assign" ? "active" : "revoked",
    event_type: action === "assign" ? "assigned" : "revoked", actor_subject: actor },
    status: action === "assign" ? 201 : 200 };
}


async function submitCriteriaForReview(db, tenant, entryId, version, actor, requestId) {
  try {
    const result = await db.batch([db.prepare(
      "INSERT INTO water_quality_criteria_events (id, tenant_id, entry_id, entry_version, event_type, actor_subject, request_id) VALUES (?, ?, ?, ?, 'submitted_for_review', ?, ?)"
    ).bind(crypto.randomUUID(), tenant, entryId, version, actor, requestId)]);
    if (!Array.isArray(result) || result.length !== 1 || result[0]?.meta?.changes !== 1) {
      return { error: "criteria_lifecycle_conflict", status: 409 };
    }
    return { data: { entry_id: entryId, version, status: "submitted_for_review" }, status: 200 };
  } catch {
    return { error: "criteria_lifecycle_conflict", status: 409 };
  }
}

async function recordCriteriaReview(db, tenant, entryId, version, reviewerSubject, requestId, body) {
  if (!onlyKeys(body, ["reviewer_role", "decision", "evidence_ref", "reason"]) ||
      !["regulatory_reviewer", "domain_expert"].includes(body.reviewer_role) ||
      !["approve", "reject"].includes(body.decision) ||
      typeof body.evidence_ref !== "string" || body.evidence_ref.trim() !== body.evidence_ref ||
      body.evidence_ref.length < 1 || body.evidence_ref.length > 500 ||
      (body.reason !== undefined && (typeof body.reason !== "string" ||
        body.reason.trim() !== body.reason || body.reason.length > 2000)) ||
      (body.decision === "reject" && (typeof body.reason !== "string" || body.reason.length < 1))) {
    return { error: "criteria_review_request_invalid", status: 400 };
  }
  const entryRows = await rows(db.prepare(
    "SELECT jurisdiction, created_by_subject FROM water_quality_criteria_entries WHERE tenant_id = ? AND id = ? AND version = ? LIMIT 1"
  ).bind(tenant, entryId, version));
  if (entryRows.length !== 1 || entryRows[0].created_by_subject === reviewerSubject) {
    return { error: "reviewer_assignment_not_found", status: 404 };
  }
  const jurisdiction = entryRows[0].jurisdiction;
  const assignments = await rows(db.prepare(
    "SELECT r.reviewer_subject, r.reviewer_role, r.jurisdiction FROM water_quality_criteria_reviewers r JOIN tenants t ON t.id = r.tenant_id AND t.status = 'active' WHERE r.tenant_id = ? AND r.reviewer_subject = ? AND r.reviewer_role = ? AND r.jurisdiction = ? AND r.status = 'active' LIMIT 2"
  ).bind(tenant, reviewerSubject, body.reviewer_role, jurisdiction));
  if (assignments.length !== 1 || assignments[0].reviewer_subject !== reviewerSubject ||
      assignments[0].reviewer_role !== body.reviewer_role || assignments[0].jurisdiction !== jurisdiction) {
    return { error: "reviewer_assignment_not_found", status: 404 };
  }
  const approvalId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const reviewedAt = new Date().toISOString();
  const approval = db.prepare(
    "INSERT INTO water_quality_criteria_approvals (id, tenant_id, entry_id, entry_version, jurisdiction, reviewer_subject, reviewer_role, decision, evidence_ref, reason, reviewed_at, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(approvalId, tenant, entryId, version, jurisdiction, reviewerSubject,
    body.reviewer_role, body.decision, body.evidence_ref, body.reason ?? null, reviewedAt, requestId);
  const event = body.decision === "reject"
    ? db.prepare("INSERT INTO water_quality_criteria_events (id, tenant_id, entry_id, entry_version, event_type, actor_subject, reason, request_id) SELECT ?, ?, ?, ?, 'rejected', ?, ?, ? WHERE changes() = 1")
        .bind(eventId, tenant, entryId, version, reviewerSubject, body.reason, requestId)
    : db.prepare("INSERT INTO water_quality_criteria_events (id, tenant_id, entry_id, entry_version, event_type, actor_subject, request_id) SELECT ?, ?, ?, ?, 'approved', ?, ? WHERE changes() = 1 AND (SELECT COUNT(DISTINCT a.reviewer_subject) FROM water_quality_criteria_approvals a JOIN water_quality_criteria_reviewers r ON r.tenant_id = a.tenant_id AND r.reviewer_subject = a.reviewer_subject AND r.reviewer_role = a.reviewer_role AND r.status = 'active' WHERE a.tenant_id = ? AND a.entry_id = ? AND a.entry_version = ? AND a.decision = 'approve') >= 2 AND EXISTS (SELECT 1 FROM water_quality_criteria_approvals a JOIN water_quality_criteria_reviewers r ON r.tenant_id = a.tenant_id AND r.reviewer_subject = a.reviewer_subject AND r.reviewer_role = a.reviewer_role AND r.status = 'active' WHERE a.tenant_id = ? AND a.entry_id = ? AND a.entry_version = ? AND a.decision = 'approve' AND a.reviewer_role = 'regulatory_reviewer') AND EXISTS (SELECT 1 FROM water_quality_criteria_approvals a JOIN water_quality_criteria_reviewers r ON r.tenant_id = a.tenant_id AND r.reviewer_subject = a.reviewer_subject AND r.reviewer_role = a.reviewer_role AND r.status = 'active' WHERE a.tenant_id = ? AND a.entry_id = ? AND a.entry_version = ? AND a.decision = 'approve' AND a.reviewer_role = 'domain_expert')")
        .bind(eventId, tenant, entryId, version, reviewerSubject, requestId,
          tenant, entryId, version, tenant, entryId, version, tenant, entryId, version);
  try {
    const results = await db.batch([approval, event]);
    if (!Array.isArray(results) || results.length !== 2 ||
        !results[0]?.meta || results[0].meta.changes !== 1 ||
        !results[1]?.meta || !Number.isInteger(results[1].meta.changes)) {
      return { error: "criteria_lifecycle_conflict", status: 409 };
    }
    return { data: { entry_id: entryId, version, decision: body.decision,
      status: body.decision === "reject" ? "rejected" :
        results[1].meta.changes === 1 ? "approved" : "submitted_for_review",
      approval_id: approvalId }, status: 201 };
  } catch {
    return { error: "criteria_lifecycle_conflict", status: 409 };
  }
}


async function resolveStoredCriteria(db, tenant, entryId, version, context, sampledAt) {
  if (!onlyKeys(context, ["tenant_id", "site_id", "jurisdiction", "crop_id", "irrigation_method", "intended_use"]) ||
      context.tenant_id !== tenant ||
      ["site_id", "jurisdiction", "crop_id", "irrigation_method", "intended_use"].some(key =>
        typeof context[key] !== "string" || context[key].trim() !== context[key] || context[key].length < 1 || context[key].length > 200) ||
      typeof sampledAt !== "string") {
    return { error: "criteria_resolution_context_invalid", status: 400 };
  }
  const siteRows = await rows(db.prepare(
    "SELECT id, tenant_id FROM sites WHERE tenant_id = ? AND id = ? LIMIT 1"
  ).bind(tenant, context.site_id));
  if (siteRows.length !== 1 || siteRows[0].id !== context.site_id || siteRows[0].tenant_id !== tenant) {
    return { error: "criteria_site_not_found", status: 404 };
  }
  const entries = await rows(db.prepare(
    "SELECT id, tenant_id, site_id, jurisdiction, version, title, entry_json, source_document_sha256, source_evidence_ref, published_on, effective_from, effective_to, supersedes_entry_id, supersedes_entry_version, created_by_subject, created_at FROM water_quality_criteria_entries WHERE tenant_id = ? AND id = ? AND version = ? LIMIT 1"
  ).bind(tenant, entryId, version));
  if (entries.length !== 1 || entries[0].tenant_id !== tenant ||
      entries[0].id !== entryId || entries[0].version !== version) {
    return { error: "criteria_entry_not_found", status: 404 };
  }
  const [events, approvals] = await Promise.all([
    rows(db.prepare(
      "SELECT event_type FROM water_quality_criteria_events WHERE tenant_id = ? AND entry_id = ? AND entry_version = ? ORDER BY rowid ASC LIMIT 100"
    ).bind(tenant, entryId, version)),
    rows(db.prepare(
      "SELECT reviewer_subject, reviewer_role, decision, evidence_ref, reviewed_at FROM water_quality_criteria_approvals WHERE tenant_id = ? AND entry_id = ? AND entry_version = ? ORDER BY reviewed_at, id LIMIT 20"
    ).bind(tenant, entryId, version)),
  ]);
  const latest = events.at(-1)?.event_type ?? "unknown";
  const status = latest === "draft_created" ? "draft" :
    latest === "submitted_for_review" ? "review_pending" : latest;
  const entry = JSON.parse(entries[0].entry_json);
  entry.review = {
    status,
    approvals: approvals.filter(item => item.decision === "approve").map(item => ({
      reviewer_id: item.reviewer_subject, role: item.reviewer_role,
      reviewed_at: item.reviewed_at, evidence_ref: item.evidence_ref,
    })),
  };
  const resolution = resolveApprovedWaterQualityCriteria(entry, context, sampledAt);
  return { data: { ...resolution, tenant_id: tenant, site_id: entries[0].site_id,
    title: entries[0].title, authority_name: entry.authority.name,
    lifecycle_status: latest }, status: 200 };
}


async function assessStoredCriteria(db, tenant, entryId, version, context, samples) {
  if (!onlyKeys(context, ["tenant_id", "site_id", "jurisdiction", "crop_id", "irrigation_method", "intended_use"]) ||
      context.tenant_id !== tenant ||
      ["site_id", "jurisdiction", "crop_id", "irrigation_method", "intended_use"].some(key =>
        typeof context[key] !== "string" || context[key].trim() !== context[key] || context[key].length < 1 || context[key].length > 200)) {
    return { error: "criteria_resolution_context_invalid", status: 400 };
  }
  if (!Array.isArray(samples) || samples.length < 1 || samples.length > 50 ||
      samples.some(sample => !onlyKeys(sample, ["id", "parameter", "value", "unit", "sampled_at", "provenance"]))) {
    return { error: "criteria_assessment_samples_invalid", status: 400 };
  }
  const results = [];
  let criteriaMetadata = null;
  for (const sample of samples) {
    if (typeof sample?.sampled_at !== "string") {
      results.push({ sample_id: sample?.id ?? null, status: "not_assessed",
        reason: "sample_value_unit_or_date_invalid" });
      continue;
    }
    const resolved = await resolveStoredCriteria(db, tenant, entryId, version, context, sample.sampled_at);
    if (resolved.error) return resolved;
    const criteria = resolved.data;
    if (criteria.status !== "approved_entry_scope_match") {
      results.push({ sample_id: sample?.id ?? null, parameter: sample?.parameter ?? null,
        status: "not_assessed", reason: criteria.reason ?? "criteria_not_resolved" });
      continue;
    }
    const evidence = await resolveWaterQualitySampleEvidence(db, tenant, context.site_id, sample);
    if (!evidence.eligible) {
      results.push({ sample_id: sample?.id ?? null, parameter: sample?.parameter ?? null,
        status: "not_assessed", reason: evidence.reason });
      continue;
    }
    const criteriaSet = {
      id: criteria.entry_id, authority: criteria.authority_name, title: criteria.title,
      version: criteria.version, effective_from: criteria.effective_from,
      ...(criteria.effective_to ? { effective_to: criteria.effective_to } : {}),
      evidence_ref: criteria.source_evidence_ref,
      criteria: criteria.criteria.map(rule => ({ ...rule,
        jurisdiction: context.jurisdiction, crop_id: context.crop_id,
        irrigation_method: context.irrigation_method, intended_use: context.intended_use,
      })),
    };
    const assessment = assessWaterQualityAgainstDeclaredCriteria([sample], context, criteriaSet);
    if (!Array.isArray(assessment.results) || !assessment.results[0]) {
      results.push({ sample_id: sample.id ?? null, parameter: sample.parameter ?? null,
        status: "not_assessed", reason: assessment.reason ?? "criteria_comparison_result_missing" });
      continue;
    }
    results.push({ ...assessment.results[0],
      sample_provenance: { ...assessment.results[0].sample_provenance,
        verification_status: evidence.verification_status },
    });
    criteriaMetadata = assessment.criteria_set;
  }
  return { data: {
    status: results.every(item => item.status !== "not_assessed")
      ? "declared_criteria_comparison_complete" : "partial_criteria_comparison",
    context, criteria_set: criteriaMetadata,
    results,
    interpretation: "comparison_to_caller_supplied_criteria_only",
    legal_status: "not_verified", scientific_suitability: "not_assessed",
    operational_decision: "not_authorized",
    limitations: [
      "no_default_or_universal_thresholds_are_embedded",
      "no_unit_conversion_or_parameter_aliasing_is_performed",
      "criteria_authority_accuracy_and_current_legal_status_are_not_independently_verified",
      "within_declared_criterion_does_not_mean_safe_or_suitable",
      "outside_declared_criterion_is_not_a_standalone_operational_decision",
      "sampling_representativeness_and_laboratory_accreditation_are_not_established",
      "human_regulatory_and_domain_expert_review_is_required",
    ],
  }, status: 200 };
}

async function readCriteriaReviewers(db, tenant) {
  const reviewers = await rows(db.prepare(
    "SELECT reviewer_subject, reviewer_role, jurisdiction, status, assigned_by_subject, assignment_evidence_ref, created_at FROM water_quality_criteria_reviewers WHERE tenant_id = ? ORDER BY jurisdiction, reviewer_role, reviewer_subject LIMIT 200"
  ).bind(tenant));
  const events = await rows(db.prepare(
    "SELECT reviewer_subject, reviewer_role, jurisdiction, event_type, actor_subject, evidence_ref, reason, request_id, occurred_at FROM water_quality_criteria_reviewer_events WHERE tenant_id = ? ORDER BY occurred_at DESC LIMIT 500"
  ).bind(tenant));
  return { reviewers, events };
}

async function hasSiteReadGrant(db, tenant, subject, siteId) {
  if (typeof siteId !== "string" || !siteId.trim()) return false;
  const grants = await rows(db.prepare(
    "SELECT subject, tenant_id, resource_type, resource_id, action FROM tenant_resource_grants WHERE tenant_id = ? AND subject = ? AND resource_type = 'site' AND resource_id = ? AND action = 'read' LIMIT 2"
  ).bind(tenant, subject, siteId));
  return grants.length === 1 && grants[0].subject === subject && grants[0].tenant_id === tenant &&
    grants[0].resource_type === "site" && grants[0].resource_id === siteId && grants[0].action === "read";
}

async function readCriteriaRegistry(db, tenant, entryId, version, subject) {
  if (entryId === null) {
    const result = await rows(db.prepare(
      "SELECT e.id, e.site_id, e.jurisdiction, e.version, e.title, e.entry_json, e.source_document_sha256, e.source_evidence_ref, e.published_on, e.effective_from, e.effective_to, e.supersedes_entry_id, e.supersedes_entry_version, e.created_by_subject, e.created_at, (SELECT ev.event_type FROM water_quality_criteria_events ev WHERE ev.tenant_id = e.tenant_id AND ev.entry_id = e.id AND ev.entry_version = e.version ORDER BY ev.rowid DESC LIMIT 1) AS lifecycle_status FROM water_quality_criteria_entries e WHERE e.tenant_id = ? AND (e.site_id IS NULL OR EXISTS (SELECT 1 FROM tenant_resource_grants g WHERE g.tenant_id = e.tenant_id AND g.subject = ? AND g.resource_type = 'site' AND g.resource_id = e.site_id AND g.action = 'read') OR EXISTS (SELECT 1 FROM water_quality_criteria_reviewers r WHERE r.tenant_id = e.tenant_id AND r.reviewer_subject = ? AND r.jurisdiction = e.jurisdiction AND r.status = 'active')) ORDER BY e.jurisdiction, e.id, e.version LIMIT 100"
    ).bind(tenant, subject, subject));
    return result.map(row => ({ ...row, entry: JSON.parse(row.entry_json), entry_json: undefined }));
  }
  const result = await rows(db.prepare(
    "SELECT id, site_id, jurisdiction, version, title, entry_json, source_document_sha256, source_evidence_ref, published_on, effective_from, effective_to, supersedes_entry_id, supersedes_entry_version, created_by_subject, created_at FROM water_quality_criteria_entries WHERE tenant_id = ? AND id = ? AND version = ? LIMIT 1"
  ).bind(tenant, entryId, version));
  if (result.length !== 1) return null;
  const row = result[0];
  const [events, approvals] = await Promise.all([
    rows(db.prepare(
      "SELECT event_type, actor_subject, reason, request_id, occurred_at FROM water_quality_criteria_events WHERE tenant_id = ? AND entry_id = ? AND entry_version = ? ORDER BY rowid ASC LIMIT 100"
    ).bind(tenant, entryId, version)),
    rows(db.prepare(
      "SELECT reviewer_subject, reviewer_role, decision, evidence_ref, reason, reviewed_at, request_id FROM water_quality_criteria_approvals WHERE tenant_id = ? AND entry_id = ? AND entry_version = ? ORDER BY reviewed_at, id LIMIT 20"
    ).bind(tenant, entryId, version)),
  ]);
  return { ...row, entry: JSON.parse(row.entry_json), entry_json: undefined,
    lifecycle: { status: events.at(-1)?.event_type ?? "unknown", events },
    approvals,
    legal_status: "not_verified", scientific_suitability: "not_assessed",
    operational_decision: "not_authorized" };
}


function configuredProvisioningSubjects(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 10000) return null;
  const subjects = value.split(",").map(value => value.trim());
  if (subjects.length === 0 || subjects.some(value => !validSubject(value)) ||
      new Set(subjects).size !== subjects.length) return null;
  return new Set(subjects);
}
async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}



async function changeTenantSiteGrant(db, tenant, actor, actorRole, requestId, body) {
  const allowedActions = ["read", "create", "update", "delete", "ingest", "manage_members"];
  if (!onlyKeys(body, ["action", "subject", "site_id", "grant_action", "reason"]) ||
      !["grant", "revoke"].includes(body.action) || !validSubject(body.subject) ||
      !validId(body.site_id, 160) || !allowedActions.includes(body.grant_action) ||
      typeof body.reason !== "string" || body.reason.trim() !== body.reason ||
      body.reason.length < 1 || body.reason.length > 1000) {
    return { error: "site_grant_request_invalid", status: 400 };
  }
  if (actorRole === "tenant_admin" &&
      !["read", "create", "update", "ingest"].includes(body.grant_action)) {
    return { error: "site_grant_not_found", status: 404 };
  }
  const sites = await rows(db.prepare(
    "SELECT id, tenant_id, status FROM sites WHERE id = ? AND tenant_id = ? LIMIT 2"
  ).bind(body.site_id, tenant));
  if (sites.length !== 1 || sites[0].id !== body.site_id ||
      sites[0].tenant_id !== tenant || sites[0].status !== "active") {
    return { error: "site_grant_not_found", status: 404 };
  }
  const targets = await rows(db.prepare(
    "SELECT id, subject, status FROM tenant_memberships WHERE tenant_id = ? AND subject = ? LIMIT 2"
  ).bind(tenant, body.subject));
  if (targets.length !== 1 || targets[0].subject !== body.subject ||
      (body.action === "grant" && targets[0].status !== "active")) return { error: "site_grant_not_found", status: 404 };
  const existing = await rows(db.prepare(
    "SELECT id FROM tenant_resource_grants WHERE tenant_id = ? AND subject = ? AND resource_type = 'site' AND resource_id = ? AND action = ? LIMIT 2"
  ).bind(tenant, body.subject, body.site_id, body.grant_action));
  if (body.action === "grant" && existing.length !== 0) {
    return { error: "site_grant_already_exists", status: 409 };
  }
  if (body.action === "revoke" && existing.length !== 1) {
    return { error: "site_grant_not_found", status: 404 };
  }
  const grantId = body.action === "grant" ? crypto.randomUUID() : existing[0].id;
  const eventId = crypto.randomUUID();
  const statements = body.action === "grant" ? [
    db.prepare("INSERT INTO tenant_resource_grants (id, tenant_id, subject, resource_type, resource_id, action) SELECT ?, ?, ?, 'site', ?, ? WHERE EXISTS (SELECT 1 FROM tenants WHERE id = ? AND status = 'active') AND EXISTS (SELECT 1 FROM sites WHERE id = ? AND tenant_id = ? AND status = 'active') AND EXISTS (SELECT 1 FROM tenant_memberships WHERE id = ? AND tenant_id = ? AND subject = ?)")
      .bind(grantId, tenant, body.subject, body.site_id, body.grant_action,
        tenant, body.site_id, tenant, targets[0].id, tenant, body.subject),
    db.prepare("INSERT INTO tenant_site_grant_events (id, tenant_id, grant_id, subject, site_id, grant_action, event_type, actor_subject, reason, request_id) SELECT ?, ?, ?, ?, ?, ?, 'granted', ?, ?, ? WHERE EXISTS (SELECT 1 FROM tenant_resource_grants WHERE id = ? AND tenant_id = ? AND subject = ? AND resource_type = 'site' AND resource_id = ? AND action = ?)")
      .bind(eventId, tenant, grantId, body.subject, body.site_id, body.grant_action,
        actor, body.reason, requestId, grantId, tenant, body.subject, body.site_id, body.grant_action),
  ] : [
    db.prepare("DELETE FROM tenant_resource_grants WHERE id = ? AND tenant_id = ? AND subject = ? AND resource_type = 'site' AND resource_id = ? AND action = ? AND EXISTS (SELECT 1 FROM tenants WHERE id = ? AND status = 'active') AND EXISTS (SELECT 1 FROM sites WHERE id = ? AND tenant_id = ? AND status = 'active') AND EXISTS (SELECT 1 FROM tenant_memberships WHERE id = ? AND tenant_id = ? AND subject = ? AND status = 'active')")
      .bind(grantId, tenant, body.subject, body.site_id, body.grant_action,
        tenant, body.site_id, tenant, targets[0].id, tenant, body.subject),
    db.prepare("INSERT INTO tenant_site_grant_events (id, tenant_id, grant_id, subject, site_id, grant_action, event_type, actor_subject, reason, request_id) SELECT ?, ?, ?, ?, ?, ?, 'revoked', ?, ?, ? WHERE changes() = 1")
      .bind(eventId, tenant, grantId, body.subject, body.site_id, body.grant_action,
        actor, body.reason, requestId),
  ];
  const results = await db.batch(statements);
  if (!Array.isArray(results) || results.length !== 2 ||
      results.some(result => !result?.meta || !Number.isInteger(result.meta.changes))) {
    throw new Error("site_grant_batch_invalid");
  }
  if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1) {
    return { error: "site_grant_transition_conflict", status: 409 };
  }
  return { data: { grant_id: grantId, tenant_id: tenant, subject: body.subject,
    site_id: body.site_id, resource_type: "site", action: body.grant_action,
    status: body.action === "grant" ? "active" : "revoked",
    event_type: body.action === "grant" ? "granted" : "revoked" },
    status: body.action === "grant" ? 201 : 200 };
}

async function changeTenantMembership(db, tenant, actor, actorRole, requestId, body) {
  if (!onlyKeys(body, ["membership_id", "action", "role", "reason"]) ||
      typeof body.membership_id !== "string" || !validId(body.membership_id, 160) ||
      !["change_role", "suspend", "revoke", "reactivate"].includes(body.action) ||
      typeof body.reason !== "string" || body.reason.trim() !== body.reason ||
      body.reason.length < 1 || body.reason.length > 1000 ||
      (body.action === "change_role"
        ? !["tenant_admin", "operator", "analyst", "viewer"].includes(body.role)
        : body.role !== undefined)) return { error: "membership_change_request_invalid", status: 400 };
  const targets = await rows(db.prepare(
    "SELECT id, tenant_id, subject, role, status FROM tenant_memberships WHERE id = ? AND tenant_id = ? LIMIT 2"
  ).bind(body.membership_id, tenant));
  if (targets.length !== 1 || targets[0].tenant_id !== tenant ||
      targets[0].id !== body.membership_id || targets[0].subject === actor) {
    return { error: "membership_not_found", status: 404 };
  }
  const target = targets[0];
  if (!["active", "inactive", "revoked"].includes(target.status) ||
      !["tenant_owner", "tenant_admin", "operator", "analyst", "viewer", "service"].includes(target.role)) {
    return { error: "membership_not_found", status: 404 };
  }
  if (actorRole === "tenant_admin" &&
      (body.action === "change_role" || !["operator", "analyst", "viewer"].includes(target.role))) {
    return { error: "membership_not_found", status: 404 };
  }
  if (!["tenant_owner", "tenant_admin"].includes(actorRole)) return { error: "membership_not_found", status: 404 };
  let eventType, nextRole = target.role, nextStatus = target.status;
  if (body.action === "change_role") {
    if (actorRole !== "tenant_owner" || target.status !== "active" || target.role === body.role) {
      return { error: "membership_transition_conflict", status: 409 };
    }
    eventType = "role_changed"; nextRole = body.role;
  } else if (body.action === "suspend") {
    if (target.status !== "active") return { error: "membership_transition_conflict", status: 409 };
    eventType = "suspended"; nextStatus = "inactive";
  } else if (body.action === "revoke") {
    if (target.status === "revoked") return { error: "membership_transition_conflict", status: 409 };
    eventType = "revoked"; nextStatus = "revoked";
  } else {
    if (target.status !== "inactive") return { error: "membership_transition_conflict", status: 409 };
    eventType = "reactivated"; nextStatus = "active";
  }
  const eventId = crypto.randomUUID();
  const results = await db.batch([
    db.prepare("INSERT INTO tenant_membership_events (id, tenant_id, membership_id, subject, actor_subject, event_type, previous_role, new_role, previous_status, new_status, reason, request_id) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM tenant_memberships WHERE id = ? AND tenant_id = ? AND subject = ? AND role = ? AND status = ?)")
      .bind(eventId, tenant, target.id, target.subject, actor, eventType, target.role,
        nextRole, target.status, nextStatus, body.reason, requestId, target.id, tenant,
        target.subject, target.role, target.status),
    db.prepare("UPDATE tenant_memberships SET role = ?, status = ? WHERE id = ? AND tenant_id = ? AND subject = ? AND role = ? AND status = ? AND EXISTS (SELECT 1 FROM tenant_membership_events WHERE id = ? AND request_id = ?)")
      .bind(nextRole, nextStatus, target.id, tenant, target.subject, target.role,
        target.status, eventId, requestId),
  ]);
  if (!Array.isArray(results) || results.length !== 2 ||
      results.some(result => !result?.meta || !Number.isInteger(result.meta.changes))) {
    throw new Error("membership_change_batch_invalid");
  }
  if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1) {
    return { error: "membership_transition_conflict", status: 409 };
  }
  return { data: { membership_id: target.id, tenant_id: tenant, subject: target.subject,
    role: nextRole, status: nextStatus, event_type: eventType }, status: 200 };
}

function createInvitationToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
async function createMembershipInvitation(db, tenant, actor, requestId, body) {
  if (!onlyKeys(body, ["role", "reason"]) ||
      !["tenant_admin", "operator", "analyst", "viewer"].includes(body.role) ||
      typeof body.reason !== "string" || body.reason.trim() !== body.reason ||
      body.reason.length < 1 || body.reason.length > 1000) {
    return { error: "membership_invitation_request_invalid", status: 400 };
  }
  const invitationId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const token = createInvitationToken();
  const tokenDigest = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const statements = [
    db.prepare(
      "INSERT INTO tenant_membership_invitations (id, tenant_id, role, token_sha256, created_by_subject, reason, request_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(invitationId, tenant, body.role, tokenDigest, actor, body.reason, requestId, expiresAt),
    db.prepare(
      "INSERT INTO tenant_membership_invitation_events (id, tenant_id, invitation_id, event_type, actor_subject, subject, reason, request_id) SELECT ?, ?, ?, 'created', ?, NULL, ?, ? WHERE EXISTS (SELECT 1 FROM tenant_membership_invitations WHERE id = ? AND tenant_id = ? AND status = 'pending')"
    ).bind(eventId, tenant, invitationId, actor, body.reason, requestId, invitationId, tenant),
  ];
  const results = await db.batch(statements);
  if (!Array.isArray(results) || results.length !== 2 ||
      results.some(result => result?.meta?.changes !== 1)) throw new Error("membership_invitation_batch_incomplete");
  return { data: { invitation_id: invitationId, role: body.role, status: "pending",
    expires_at: expiresAt, invitation_token: token,
    delivery: "Share this one-time token with the intended invitee through a trusted out-of-band channel. It is shown only once." },
    status: 201 };
}
async function acceptMembershipInvitation(db, tenant, invitationId, subject, requestId, body) {
  if (!onlyKeys(body, ["invitation_token"]) ||
      typeof body.invitation_token !== "string" ||
      !/^[A-Za-z0-9_-]{40,60}$/.test(body.invitation_token)) {
    return { error: "membership_invitation_token_invalid", status: 400 };
  }
  const tokenDigest = await sha256Hex(body.invitation_token);
  const invitations = await rows(db.prepare(
    "SELECT id, tenant_id, role, status, reason, expires_at FROM tenant_membership_invitations WHERE id = ? AND tenant_id = ? AND token_sha256 = ? LIMIT 2"
  ).bind(invitationId, tenant, tokenDigest));
  if (invitations.length !== 1 || invitations[0].tenant_id !== tenant ||
      invitations[0].id !== invitationId || invitations[0].status !== "pending") {
    return { error: "membership_invitation_not_found", status: 404 };
  }
  const invitation = invitations[0];
  const now = new Date().toISOString();
  if (typeof invitation.expires_at !== "string" || invitation.expires_at <= now) {
    const eventId = crypto.randomUUID();
    const expiredAt = now;
    const results = await db.batch([
      db.prepare("UPDATE tenant_membership_invitations SET status = 'expired' WHERE id = ? AND tenant_id = ? AND status = 'pending' AND expires_at <= ?")
        .bind(invitationId, tenant, expiredAt),
      db.prepare("INSERT INTO tenant_membership_invitation_events (id, tenant_id, invitation_id, event_type, actor_subject, subject, reason, request_id) SELECT ?, ?, ?, 'expired', ?, NULL, 'Invitation expired before acceptance', ? WHERE changes() = 1")
        .bind(eventId, tenant, invitationId, subject, requestId),
    ]);
    if (!Array.isArray(results) || results.length !== 2) throw new Error("membership_invitation_expiry_batch_invalid");
    return { error: "membership_invitation_expired", status: 410 };
  }
  const existing = await rows(db.prepare(
    "SELECT id, status FROM tenant_memberships WHERE tenant_id = ? AND subject = ? LIMIT 2"
  ).bind(tenant, subject));
  if (existing.length !== 0) return { error: "membership_already_exists", status: 409 };
  const membershipId = crypto.randomUUID();
  const grantId = crypto.randomUUID();
  const membershipEventId = crypto.randomUUID();
  const invitationEventId = crypto.randomUUID();
  const results = await db.batch([
    db.prepare("UPDATE tenant_membership_invitations SET status = 'accepted', accepted_by_subject = ?, accepted_at = ? WHERE id = ? AND tenant_id = ? AND status = 'pending' AND expires_at > ?")
      .bind(subject, now, invitationId, tenant, now),
    db.prepare("INSERT INTO tenant_memberships (id, tenant_id, subject, role, status) SELECT ?, ?, ?, ?, 'active' WHERE changes() = 1")
      .bind(membershipId, tenant, subject, invitation.role),
    db.prepare("INSERT INTO tenant_resource_grants (id, tenant_id, subject, resource_type, resource_id, action) SELECT ?, ?, ?, 'tenant', ?, 'read' WHERE EXISTS (SELECT 1 FROM tenant_memberships WHERE id = ? AND tenant_id = ? AND subject = ?)")
      .bind(grantId, tenant, subject, tenant, membershipId, tenant, subject),
    db.prepare("INSERT INTO tenant_membership_events (id, tenant_id, membership_id, subject, actor_subject, event_type, previous_role, new_role, previous_status, new_status, reason, request_id) SELECT ?, ?, ?, ?, ?, 'created', NULL, ?, NULL, 'active', ?, ? WHERE EXISTS (SELECT 1 FROM tenant_memberships WHERE id = ? AND tenant_id = ? AND subject = ?)")
      .bind(membershipEventId, tenant, membershipId, subject, subject, invitation.role, "Accepted tenant membership invitation: " + invitation.reason.slice(0, 950), requestId, membershipId, tenant, subject),
    db.prepare("INSERT INTO tenant_membership_invitation_events (id, tenant_id, invitation_id, event_type, actor_subject, subject, reason, request_id) SELECT ?, ?, ?, 'accepted', ?, ?, 'Invitation accepted by authenticated Access subject', ? WHERE EXISTS (SELECT 1 FROM tenant_membership_invitations WHERE id = ? AND tenant_id = ? AND status = 'accepted' AND accepted_by_subject = ?)")
      .bind(invitationEventId, tenant, invitationId, subject, subject, requestId, invitationId, tenant, subject),
  ]);
  if (!Array.isArray(results) || results.length !== 5 ||
      results.some(result => !result?.meta || !Number.isInteger(result.meta.changes))) {
    throw new Error("membership_invitation_accept_batch_invalid");
  }
  if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1 ||
      results[2].meta.changes !== 1 || results[3].meta.changes !== 1 ||
      results[4].meta.changes !== 1) return { error: "membership_invitation_conflict", status: 409 };
  return { data: { invitation_id: invitationId, membership_id: membershipId,
    tenant_id: tenant, subject, role: invitation.role, status: "active" }, status: 201 };
}
async function revokeMembershipInvitation(db, tenant, invitationId, actor, requestId, body) {
  if (!onlyKeys(body, ["reason"]) || typeof body.reason !== "string" ||
      body.reason.trim() !== body.reason || body.reason.length < 1 || body.reason.length > 1000) {
    return { error: "membership_invitation_request_invalid", status: 400 };
  }
  const eventId = crypto.randomUUID();
  const now = new Date().toISOString();
  const results = await db.batch([
    db.prepare("UPDATE tenant_membership_invitations SET status = 'revoked', revoked_at = ? WHERE id = ? AND tenant_id = ? AND status = 'pending' AND expires_at > ?")
      .bind(now, invitationId, tenant, now),
    db.prepare("INSERT INTO tenant_membership_invitation_events (id, tenant_id, invitation_id, event_type, actor_subject, subject, reason, request_id) SELECT ?, ?, ?, 'revoked', ?, NULL, ?, ? WHERE changes() = 1")
      .bind(eventId, tenant, invitationId, actor, body.reason, requestId),
  ]);
  if (!Array.isArray(results) || results.length !== 2 ||
      results.some(result => !result?.meta || !Number.isInteger(result.meta.changes))) {
    throw new Error("membership_invitation_revoke_batch_invalid");
  }
  return results[0].meta.changes === 1 && results[1].meta.changes === 1
    ? { data: { invitation_id: invitationId, status: "revoked" }, status: 200 }
    : { error: "membership_invitation_not_found", status: 404 };
}

async function createTenantForProvisioning(db, subject, body, requestId, allowlist) {
  if (!allowlist || !allowlist.has(subject)) return { error: "not_found", status: 404 };
  if (!onlyKeys(body, ["display_name", "idempotency_key"]) ||
      typeof body.display_name !== "string" || body.display_name.trim() !== body.display_name ||
      body.display_name.length < 1 || body.display_name.length > 160 ||
      !validId(body.idempotency_key, 160)) {
    return { error: "tenant_provisioning_request_invalid", status: 400 };
  }
  const requestDigest = await sha256Hex(JSON.stringify([subject, body.display_name]));
  const tenantId = "tenant-" + crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const grantIds = Array.from({ length: 6 }, () => crypto.randomUUID());
  const statements = [
    db.prepare(
      "INSERT INTO tenants (id, display_name, status) SELECT ?, ?, 'active' WHERE NOT EXISTS (SELECT 1 FROM tenant_provisioning_requests WHERE actor_subject = ? AND idempotency_key = ?)"
    ).bind(tenantId, body.display_name, subject, body.idempotency_key),
    db.prepare(
      "INSERT INTO tenant_memberships (id, tenant_id, subject, role, status) SELECT ?, ?, ?, 'tenant_owner', 'active' WHERE EXISTS (SELECT 1 FROM tenants WHERE id = ?)"
    ).bind(membershipId, tenantId, subject, tenantId),
    db.prepare(
      "INSERT INTO tenant_resource_grants (id, tenant_id, subject, resource_type, resource_id, action) SELECT ?, ?, ?, 'tenant', ?, 'read' WHERE EXISTS (SELECT 1 FROM tenant_memberships WHERE id = ? AND tenant_id = ?)"
    ).bind(grantIds[0], tenantId, subject, tenantId, membershipId, tenantId),
    ...["create", "update", "delete", "ingest", "manage_members"].map((action, index) =>
      db.prepare(
        "INSERT INTO tenant_resource_grants (id, tenant_id, subject, resource_type, resource_id, action) SELECT ?, ?, ?, 'tenant', ?, ? WHERE EXISTS (SELECT 1 FROM tenant_memberships WHERE id = ? AND tenant_id = ?)"
      ).bind(grantIds[index + 1], tenantId, subject, tenantId, action, membershipId, tenantId)),
    db.prepare(
      "INSERT INTO tenant_membership_events (id, tenant_id, membership_id, subject, actor_subject, event_type, previous_role, new_role, previous_status, new_status, reason, request_id) SELECT ?, ?, ?, ?, ?, 'created', NULL, 'tenant_owner', NULL, 'active', 'Initial owner assigned by allowlisted tenant provisioning', ? WHERE EXISTS (SELECT 1 FROM tenant_memberships WHERE id = ? AND tenant_id = ?)"
    ).bind(eventId, tenantId, membershipId, subject, subject, requestId, membershipId, tenantId),
    db.prepare(
      "INSERT INTO tenant_provisioning_requests (id, actor_subject, idempotency_key, request_sha256, tenant_id) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM tenant_memberships WHERE id = ? AND tenant_id = ?)"
    ).bind(requestId, subject, body.idempotency_key, requestDigest, tenantId, membershipId, tenantId),
  ];
  try {
    const results = await db.batch(statements);
    if (!Array.isArray(results) || results.length !== statements.length ||
        results.some(result => !result?.meta || !Number.isInteger(result.meta.changes))) {
      throw new Error("tenant_provisioning_batch_invalid");
    }
    if (results[0].meta.changes === 1) {
      if (results.some((result, index) => index > 0 && result.meta.changes !== 1)) {
        throw new Error("tenant_provisioning_batch_incomplete");
      }
      return { data: { tenant_id: tenantId, display_name: body.display_name,
        tenant_status: "active", membership_id: membershipId, membership_role: "tenant_owner",
        membership_status: "active", created: true }, status: 201 };
    }
  } catch {
    // A concurrent request with the same actor/key can win the unique key.
    // Read the durable outcome below; all other batch failures remain 503.
  }
  const existing = await rows(db.prepare(
    "SELECT r.request_sha256, r.tenant_id, t.display_name, t.status, m.id AS membership_id, m.role, m.status AS membership_status FROM tenant_provisioning_requests r JOIN tenants t ON t.id = r.tenant_id JOIN tenant_memberships m ON m.tenant_id = r.tenant_id AND m.subject = r.actor_subject WHERE r.actor_subject = ? AND r.idempotency_key = ? LIMIT 2"
  ).bind(subject, body.idempotency_key));
  if (existing.length !== 1) throw new Error("tenant_provisioning_storage_conflict");
  const row = existing[0];
  if (row.request_sha256 !== requestDigest) return { error: "idempotency_key_reused", status: 409 };
  if (row.role !== "tenant_owner" || row.membership_status !== "active" || row.status !== "active") {
    return { error: "tenant_provisioning_conflict", status: 409 };
  }
  return { data: { tenant_id: row.tenant_id, display_name: row.display_name,
    tenant_status: row.status, membership_id: row.membership_id, membership_role: row.role,
    membership_status: row.membership_status, created: false }, status: 200 };
}

export default {
  async fetch(request, env) {
    if (request.method !== "GET" && request.method !== "POST") return error("not_found", 404);
    const url = new URL(request.url);
    const tenantProvision = url.pathname === "/internal/v1/tenants";
    const siteGrantChange = url.pathname.match(/^\/internal\/v1\/tenants\/([^/]+)\/site-grants$/);
    const membershipChange = url.pathname.match(/^\/internal\/v1\/tenants\/([^/]+)\/membership-actions$/);
    const membershipEvents = url.pathname.match(/^\/internal\/v1\/tenants\/([^/]+)\/membership-events$/);
    const membershipInvitationCreate = url.pathname.match(/^\/internal\/v1\/tenants\/([^/]+)\/membership-invitations$/);
    const membershipInvitationAccept = url.pathname.match(/^\/internal\/v1\/tenants\/([^/]+)\/membership-invitations\/([^/]+)\/accept$/);
    const membershipInvitationRevoke = url.pathname.match(/^\/internal\/v1\/tenants\/([^/]+)\/membership-invitations\/([^/]+)\/revoke$/);
    const match = url.pathname.match(/^\/internal\/v1\/tenants\/([^/]+)\/(sites|assets|sources|observations|audit-events)\/([^/]+)$/);
    const criteriaCreate = url.pathname.match(/^\/internal\/v1\/tenants\/([^/]+)\/water-quality-criteria$/);
    const reviewerAssign = url.pathname.match(/^\/internal\/v1\/tenants\/([^/]+)\/water-quality-criteria\/reviewers\/assign$/);
    const reviewerRevoke = url.pathname.match(/^\/internal\/v1\/tenants\/([^/]+)\/water-quality-criteria\/reviewers\/revoke$/);
    const reviewerList = url.pathname.match(/^\/internal\/v1\/tenants\/([^/]+)\/water-quality-criteria\/reviewers$/);
    const criteriaList = request.method === "GET" ? criteriaCreate : null;
    const criteriaDetail = url.pathname.match(/^\/internal\/v1\/tenants\/([^/]+)\/water-quality-criteria\/(?!reviewers\/)([^/]+)\/([^/]+)$/);
    const criteriaSubmit = url.pathname.match(/^\/internal\/v1\/tenants\/([^/]+)\/water-quality-criteria\/(?!reviewers\/)([^/]+)\/([^/]+)\/submit$/);
    const criteriaReview = url.pathname.match(/^\/internal\/v1\/tenants\/([^/]+)\/water-quality-criteria\/(?!reviewers\/)([^/]+)\/([^/]+)\/review$/);
    const criteriaResolve = url.pathname.match(/^\/internal\/v1\/tenants\/([^/]+)\/water-quality-criteria\/(?!reviewers\/)([^/]+)\/([^/]+)\/resolve$/);
    const criteriaAssess = url.pathname.match(/^\/internal\/v1\/tenants\/([^/]+)\/water-quality-criteria\/(?!reviewers\/)([^/]+)\/([^/]+)\/assess$/);
    const observationReviewerAssign = url.pathname.match(/^\/internal\/v1\/tenants\/([^/]+)\/observations\/reviewers\/assign$/);
    const observationReviewerRevoke = url.pathname.match(/^\/internal\/v1\/tenants\/([^/]+)\/observations\/reviewers\/revoke$/);
    const observationVerification = url.pathname.match(/^\/internal\/v1\/tenants\/([^/]+)\/observations\/([^/]+)\/verification$/);
    const calibrationReviewerAssign = url.pathname.match(/^\/internal\/v1\/tenants\/([^/]+)\/sites\/([^/]+)\/assets\/([^/]+)\/calibration-reviewers\/assign$/);
    const calibrationReviewerRevoke = url.pathname.match(/^\/internal\/v1\/tenants\/([^/]+)\/sites\/([^/]+)\/assets\/([^/]+)\/calibration-reviewers\/revoke$/);
    const calibrationVerification = url.pathname.match(/^\/internal\/v1\/tenants\/([^/]+)\/sites\/([^/]+)\/assets\/([^/]+)\/calibrations\/([^/]+)\/verification$/);
    const sensorMappingRegister = url.pathname.match(/^\/internal\/v1\/tenants\/([^/]+)\/sites\/([^/]+)\/assets\/([^/]+)\/sensor-source-mappings$/);
    const sensorMappingReview = url.pathname.match(/^\/internal\/v1\/tenants\/([^/]+)\/sites\/([^/]+)\/assets\/([^/]+)\/sensor-source-mappings\/([^/]+)\/verification$/);
    const sensorMappingReviewerAssign = url.pathname.match(/^\/internal\/v1\/tenants\/([^/]+)\/sites\/([^/]+)\/sensor-source-mapping-reviewers\/assign$/);
    const sensorMappingReviewerRevoke = url.pathname.match(/^\/internal\/v1\/tenants\/([^/]+)\/sites\/([^/]+)\/sensor-source-mapping-reviewers\/revoke$/);
    const calibrationRegister = url.pathname.match(/^\/internal\/v1\/tenants\/([^/]+)\/sites\/([^/]+)\/assets\/([^/]+)\/calibrations$/);
    const qualityPolicyRegister = url.pathname.match(/^\/internal\/v1\/tenants\/([^/]+)\/sites\/([^/]+)\/assets\/([^/]+)\/measurement-quality-policies$/);
    const qualityPolicyReview = url.pathname.match(/^\/internal\/v1\/tenants\/([^/]+)\/sites\/([^/]+)\/assets\/([^/]+)\/measurement-quality-policies\/([^/]+)\/verification$/);
    const qualityAssessment = url.pathname.match(/^\/internal\/v1\/tenants\/([^/]+)\/observations\/([^/]+)\/measurement-quality-assessment$/);
    const labReportUpload = url.pathname.match(/^\/internal\/v1\/tenants\/([^/]+)\/sites\/([^/]+)\/laboratory-reports$/);
    const labReportDetail = url.pathname.match(/^\/internal\/v1\/tenants\/([^/]+)\/sites\/([^/]+)\/laboratory-reports\/([^/]+)$/);
    if ((tenantProvision && request.method !== "POST") || ((membershipInvitationCreate || membershipInvitationAccept || membershipInvitationRevoke || membershipChange || siteGrantChange) && request.method !== "POST") || (membershipEvents && request.method !== "GET") || (!tenantProvision && !membershipEvents && !membershipInvitationCreate && !membershipInvitationAccept && !membershipInvitationRevoke && !membershipChange && !siteGrantChange && !match && !criteriaCreate && !criteriaDetail && !reviewerAssign && !reviewerRevoke && !reviewerList && !criteriaSubmit && !criteriaReview && !criteriaResolve && !criteriaAssess && !observationReviewerAssign && !observationReviewerRevoke && !observationVerification && !calibrationReviewerAssign && !calibrationReviewerRevoke && !calibrationVerification && !calibrationRegister && !sensorMappingRegister && !sensorMappingReview && !sensorMappingReviewerAssign && !sensorMappingReviewerRevoke && !qualityPolicyRegister && !qualityPolicyReview && !qualityAssessment && !labReportUpload && !labReportDetail) || url.search || url.hash ||
        (request.method === "POST" && (!criteriaCreate && !reviewerAssign && !reviewerRevoke && !criteriaSubmit && !criteriaReview && !criteriaResolve && !criteriaAssess && !observationReviewerAssign && !observationReviewerRevoke && !observationVerification && !calibrationReviewerAssign && !calibrationReviewerRevoke && !calibrationVerification && !calibrationRegister && !sensorMappingRegister && !sensorMappingReview && !sensorMappingReviewerAssign && !sensorMappingReviewerRevoke && !qualityPolicyRegister && !qualityPolicyReview && !qualityAssessment && !labReportUpload && !tenantProvision && !membershipInvitationCreate && !membershipInvitationAccept && !membershipInvitationRevoke && !membershipChange && !siteGrantChange || criteriaDetail || match || labReportDetail)) ||
        (request.method === "GET" && (reviewerAssign || reviewerRevoke || criteriaSubmit || criteriaReview || criteriaResolve || criteriaAssess || observationReviewerAssign || observationReviewerRevoke || observationVerification || calibrationReviewerAssign || calibrationReviewerRevoke || calibrationVerification || calibrationRegister || sensorMappingRegister || sensorMappingReview || sensorMappingReviewerAssign || sensorMappingReviewerRevoke || qualityPolicyRegister || qualityPolicyReview || qualityAssessment || labReportUpload))) return error("not_found", 404);
    const tenant = membershipInvitationCreate?.[1] ?? membershipInvitationAccept?.[1] ?? membershipInvitationRevoke?.[1] ?? siteGrantChange?.[1] ?? membershipChange?.[1] ?? membershipEvents?.[1] ?? match?.[1] ?? criteriaCreate?.[1] ?? criteriaDetail?.[1] ?? reviewerAssign?.[1] ?? reviewerRevoke?.[1] ?? reviewerList?.[1] ?? criteriaSubmit?.[1] ?? criteriaReview?.[1] ?? criteriaResolve?.[1] ?? criteriaAssess?.[1] ?? observationReviewerAssign?.[1] ?? observationReviewerRevoke?.[1] ?? observationVerification?.[1] ?? calibrationReviewerAssign?.[1] ?? calibrationReviewerRevoke?.[1] ?? calibrationVerification?.[1] ?? calibrationRegister?.[1] ?? sensorMappingRegister?.[1] ?? sensorMappingReview?.[1] ?? sensorMappingReviewerAssign?.[1] ?? sensorMappingReviewerRevoke?.[1] ?? qualityPolicyRegister?.[1] ?? qualityPolicyReview?.[1] ?? qualityAssessment?.[1] ?? labReportUpload?.[1] ?? labReportDetail?.[1];
    const resourceId = match?.[3];
    const entryId = criteriaDetail?.[2] ?? criteriaSubmit?.[2] ?? criteriaReview?.[2] ?? criteriaResolve?.[2] ?? criteriaAssess?.[2] ?? null;
    const version = criteriaDetail?.[3] ?? criteriaSubmit?.[3] ?? criteriaReview?.[3] ?? criteriaResolve?.[3] ?? criteriaAssess?.[3] ?? null;
    if ((!tenantProvision && !validId(tenant, 120)) || (resourceId && !validId(resourceId)) || ((membershipInvitationAccept || membershipInvitationRevoke) && !validId((membershipInvitationAccept || membershipInvitationRevoke)[2])) ||
        (entryId && (!validId(entryId) || !validId(version, 80))) ||
        (observationVerification && !validId(observationVerification[2])) ||
        ((calibrationReviewerAssign || calibrationReviewerRevoke || calibrationVerification || calibrationRegister) && (!validId((calibrationReviewerAssign || calibrationReviewerRevoke || calibrationVerification || calibrationRegister)[2]) || !validId((calibrationReviewerAssign || calibrationReviewerRevoke || calibrationVerification || calibrationRegister)[3]))) || (calibrationVerification && !validId(calibrationVerification[4])) || ((sensorMappingRegister || sensorMappingReview || sensorMappingReviewerAssign || sensorMappingReviewerRevoke) && (!validId((sensorMappingRegister || sensorMappingReview || sensorMappingReviewerAssign || sensorMappingReviewerRevoke)[2]) || !validId((sensorMappingRegister || sensorMappingReview || sensorMappingReviewerAssign || sensorMappingReviewerRevoke)[3]))) || (sensorMappingReview && !validId(sensorMappingReview[4])) || ((qualityPolicyRegister || qualityPolicyReview) && (!validId((qualityPolicyRegister || qualityPolicyReview)[2]) || !validId((qualityPolicyRegister || qualityPolicyReview)[3]))) || (qualityPolicyReview && !validId(qualityPolicyReview[4])) || (qualityAssessment && !validId(qualityAssessment[2])) || ((labReportUpload || labReportDetail) && !validId((labReportUpload ?? labReportDetail)[2])) ||
        (labReportDetail && !validId(labReportDetail[3]))) return error("not_found", 404);

    const subject = request.headers.get("x-nova-verified-subject");
    const issuer = request.headers.get("x-nova-verified-issuer");
    const audience = request.headers.get("x-nova-verified-audience");
    const issuedAt = Number(request.headers.get("x-nova-gateway-issued-at"));
    const requestId = request.headers.get("x-nova-request-id");
    const now = Math.floor(Date.now() / 1000);
    if (!validSubject(subject) || issuer !== env.ACCESS_ISSUER || audience !== env.ACCESS_AUDIENCE ||
        !Number.isInteger(issuedAt) || issuedAt > now + 30 || issuedAt < now - 120 ||
        !validId(requestId, 80) ||
        !(await verifyEnvelope(env.INTERNAL_AUTH_SECRET, request.method, url.pathname, request.headers))) {
      return error("request_not_authorized", 401);
    }
    if (!env.DB) return error("storage_unavailable", 503);

    let draftBody = null;
    if (request.method === "POST") {
      const declaredLength = Number(request.headers.get("content-length") ?? "0");
      if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json" ||
          !Number.isFinite(declaredLength) || declaredLength > (labReportUpload ? 1500000 : 65536)) return error("invalid_request_body", 400);
      try {
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > (labReportUpload ? 1500000 : 65536)) return error("invalid_request_body", 400);
        draftBody = JSON.parse(raw);
      } catch { return error("invalid_request_body", 400); }
      if (draftBody === null || typeof draftBody !== "object" || Array.isArray(draftBody)) return error("invalid_request_body", 400);
    }
    try {
      if (!(await consumeRequestId(env.DB, requestId, issuedAt))) return error("request_not_authorized", 401);
      if (membershipInvitationCreate || membershipInvitationAccept || membershipInvitationRevoke) {
        const tenantRows = await rows(env.DB.prepare(
          "SELECT status FROM tenants WHERE id = ? LIMIT 2"
        ).bind(tenant));
        if (tenantRows.length !== 1 || tenantRows[0].status !== "active") return error("not_found", 404);
        if (membershipInvitationAccept) {
          const accepted = await acceptMembershipInvitation(env.DB, tenant,
            membershipInvitationAccept[2], subject, requestId, draftBody);
          return accepted.error ? json({ error: accepted.error }, accepted.status)
            : json({ data: accepted.data, request_id: requestId }, accepted.status);
        }
        const ownerRows = await rows(env.DB.prepare(
          "SELECT subject, tenant_id, role, status FROM tenant_memberships WHERE subject = ? AND tenant_id = ? LIMIT 2"
        ).bind(subject, tenant));
        if (ownerRows.length !== 1 || ownerRows[0].subject !== subject ||
            ownerRows[0].tenant_id !== tenant || ownerRows[0].status !== "active" ||
            ownerRows[0].role !== "tenant_owner") return error("not_found", 404);
        const result = membershipInvitationCreate
          ? await createMembershipInvitation(env.DB, tenant, subject, requestId, draftBody)
          : await revokeMembershipInvitation(env.DB, tenant, membershipInvitationRevoke[2],
              subject, requestId, draftBody);
        return result.error ? json({ error: result.error }, result.status)
          : json({ data: result.data, request_id: requestId }, result.status);
      }
      if (siteGrantChange) {
        const memberships = await rows(env.DB.prepare(
          "SELECT m.subject, m.tenant_id, m.role, m.status, t.status AS tenant_status FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.subject = ? AND m.tenant_id = ? LIMIT 2"
        ).bind(subject, tenant));
        if (memberships.length !== 1 || memberships[0].subject !== subject ||
            memberships[0].tenant_id !== tenant || memberships[0].status !== "active" ||
            memberships[0].tenant_status !== "active" ||
            !["tenant_owner", "tenant_admin"].includes(memberships[0].role)) return error("not_found", 404);
        const changed = await changeTenantSiteGrant(env.DB, tenant, subject,
          memberships[0].role, requestId, draftBody);
        return changed.error ? json({ error: changed.error }, changed.status)
          : json({ data: changed.data, request_id: requestId }, changed.status);
      }
      if (membershipChange) {
        const memberships = await rows(env.DB.prepare(
          "SELECT subject, tenant_id, role, status FROM tenant_memberships WHERE subject = ? AND tenant_id = ? LIMIT 2"
        ).bind(subject, tenant));
        if (memberships.length !== 1 || memberships[0].subject !== subject ||
            memberships[0].tenant_id !== tenant || memberships[0].status !== "active" ||
            !["tenant_owner", "tenant_admin"].includes(memberships[0].role)) return error("not_found", 404);
        const changed = await changeTenantMembership(env.DB, tenant, subject,
          memberships[0].role, requestId, draftBody);
        return changed.error ? json({ error: changed.error }, changed.status)
          : json({ data: changed.data, request_id: requestId }, changed.status);
      }
      if (membershipEvents) {
        const memberships = await rows(env.DB.prepare(
          "SELECT m.subject, m.tenant_id, m.role, m.status AS membership_status FROM tenant_memberships m WHERE m.subject = ? AND m.tenant_id = ? LIMIT 2"
        ).bind(subject, tenant));
        if (memberships.length !== 1 || memberships[0].subject !== subject ||
            memberships[0].tenant_id !== tenant || memberships[0].membership_status !== "active" ||
            !["tenant_owner", "tenant_admin"].includes(memberships[0].role)) return error("not_found", 404);
        const events = await rows(env.DB.prepare(
          "SELECT id, tenant_id, membership_id, subject, actor_subject, event_type, previous_role, new_role, previous_status, new_status, reason, request_id, created_at FROM tenant_membership_events WHERE tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT 100"
        ).bind(tenant));
        const invitationEvents = await rows(env.DB.prepare(
          "SELECT id, tenant_id, invitation_id, event_type, actor_subject, subject, reason, request_id, created_at FROM tenant_membership_invitation_events WHERE tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT 100"
        ).bind(tenant));
        const siteGrantEvents = await rows(env.DB.prepare(
          "SELECT id, tenant_id, grant_id, subject, site_id, grant_action, event_type, actor_subject, reason, request_id, created_at FROM tenant_site_grant_events WHERE tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT 100"
        ).bind(tenant));
        if (events.some(event => event.tenant_id !== tenant) ||
            invitationEvents.some(event => event.tenant_id !== tenant) ||
            siteGrantEvents.some(event => event.tenant_id !== tenant)) return error("not_found", 404);
        const combined = [
          ...events.map(event => ({ ...event, event_type: "membership_" + event.event_type })),
          ...invitationEvents.map(event => ({ ...event, event_type: "invitation_" + event.event_type })),
          ...siteGrantEvents.map(event => ({ ...event, event_type: "site_grant_" + event.event_type })),
        ].sort((left, right) => right.created_at.localeCompare(left.created_at) ||
          right.id.localeCompare(left.id)).slice(0, 100);
        return json({ data: combined, request_id: requestId });
      }
      if (tenantProvision) {
        const provisioned = await createTenantForProvisioning(env.DB, subject, draftBody, requestId,
          configuredProvisioningSubjects(env.TENANT_PROVISIONING_SUBJECTS));
        return provisioned.error ? json({ error: provisioned.error }, provisioned.status)
          : json({ data: provisioned.data, request_id: requestId }, provisioned.status);
      }
      if (criteriaReview) {
        const reviewed = await recordCriteriaReview(env.DB, tenant, entryId, version, subject, requestId, draftBody);
        return reviewed.error ? json({ error: reviewed.error }, reviewed.status)
          : json({ data: reviewed.data, request_id: requestId }, reviewed.status);
      }
      if (criteriaDetail) {
        const data = await readCriteriaRegistry(env.DB, tenant, entryId, version, subject);
        if (data === null) return error("not_found", 404);
        const membership = await rows(env.DB.prepare(
          "SELECT m.subject, m.tenant_id, m.role, m.status AS membership_status, t.status AS tenant_status FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.subject = ? AND m.tenant_id = ? LIMIT 2"
        ).bind(subject, tenant));
        const memberCanRead = membership.length === 1 &&
          membership[0].subject === subject && membership[0].tenant_id === tenant &&
          membership[0].membership_status === "active" && membership[0].tenant_status === "active" &&
          ROLE_ACTIONS[membership[0].role]?.has("read");
        const memberHasSiteGrant = memberCanRead &&
          (data.site_id === null || await hasSiteReadGrant(env.DB, tenant, subject, data.site_id));
        if (memberHasSiteGrant) return json({ data, request_id: requestId });
        const reviewer = await rows(env.DB.prepare(
          "SELECT DISTINCT r.reviewer_subject, r.jurisdiction FROM water_quality_criteria_reviewers r JOIN tenants t ON t.id = r.tenant_id AND t.status = 'active' WHERE r.tenant_id = ? AND r.reviewer_subject = ? AND r.jurisdiction = ? AND r.status = 'active' LIMIT 1"
        ).bind(tenant, subject, data.jurisdiction));
        return reviewer.length === 1 && reviewer[0].reviewer_subject === subject &&
          reviewer[0].jurisdiction === data.jurisdiction
          ? json({ data, request_id: requestId }) : error("not_found", 404);
      }
      if (criteriaCreate || reviewerAssign || reviewerRevoke || reviewerList || criteriaSubmit || criteriaResolve || criteriaAssess || observationReviewerAssign || observationReviewerRevoke || observationVerification || calibrationReviewerAssign || calibrationReviewerRevoke || calibrationVerification || calibrationRegister || sensorMappingRegister || sensorMappingReview || sensorMappingReviewerAssign || sensorMappingReviewerRevoke || qualityPolicyRegister || qualityPolicyReview || qualityAssessment || labReportUpload || labReportDetail) {
        const membership = await rows(env.DB.prepare(
          "SELECT m.subject, m.tenant_id, m.role, m.status AS membership_status, t.status AS tenant_status FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.subject = ? AND m.tenant_id = ? LIMIT 2"
        ).bind(subject, tenant));
        if (membership.length !== 1 || membership[0].subject !== subject ||
            membership[0].tenant_id !== tenant || membership[0].membership_status !== "active" ||
            membership[0].tenant_status !== "active") return error("not_found", 404);
        if (observationReviewerAssign || observationReviewerRevoke) {
          if (request.method !== "POST" || !["tenant_owner", "tenant_admin"].includes(membership[0].role) ||
              !await hasSiteReadGrant(env.DB, tenant, subject, draftBody?.site_id)) return error("not_found", 404);
          const assigned = await assignObservationReviewer(env.DB, tenant, subject, requestId,
            draftBody, observationReviewerAssign ? "assign" : "revoke");
          return assigned.error ? json({ error: assigned.error }, assigned.status)
            : json({ data: assigned.data, request_id: requestId }, assigned.status);
        }
        if (qualityPolicyRegister) {
          if (request.method !== "POST" || !["tenant_owner", "tenant_admin"].includes(membership[0].role) ||
              !await hasSiteReadGrant(env.DB, tenant, subject, qualityPolicyRegister[2])) return error("not_found", 404);
          const registered = await registerMeasurementQualityPolicy(env.DB, tenant, qualityPolicyRegister[2],
            qualityPolicyRegister[3], subject, draftBody);
          return registered.error ? json({ error: registered.error }, registered.status)
            : json({ data: registered.data, request_id: requestId }, registered.status);
        }
        if (qualityPolicyReview) {
          if (request.method !== "POST" || !ROLE_ACTIONS[membership[0].role]?.has("read") ||
              !await hasSiteReadGrant(env.DB, tenant, subject, qualityPolicyReview[2])) return error("not_found", 404);
          const reviewed = await reviewMeasurementQualityPolicy(env.DB, tenant, qualityPolicyReview[2],
            qualityPolicyReview[3], qualityPolicyReview[4], subject, requestId, draftBody);
          return reviewed.error ? json({ error: reviewed.error }, reviewed.status)
            : json({ data: reviewed.data, request_id: requestId }, reviewed.status);
        }
        if (qualityAssessment) {
          if (request.method !== "POST" || !ROLE_ACTIONS[membership[0].role]?.has("read") ||
              !onlyKeys(draftBody, [])) return error("not_found", 404);
          const observed = await rows(env.DB.prepare("SELECT site_id FROM observations WHERE tenant_id=? AND id=? LIMIT 2")
            .bind(tenant, qualityAssessment[2]));
          if (observed.length !== 1 || !await hasSiteReadGrant(env.DB, tenant, subject, observed[0].site_id)) return error("not_found", 404);
          const assessed = await assessMeasurementQuality(env.DB, tenant, qualityAssessment[2], requestId);
          return assessed.error ? json({ error: assessed.error }, assessed.status)
            : json({ data: assessed.data, request_id: requestId }, assessed.status);
        }
        if (calibrationReviewerAssign || calibrationReviewerRevoke) {
          const route = calibrationReviewerAssign ?? calibrationReviewerRevoke;
          if (request.method !== "POST" || !["tenant_owner", "tenant_admin"].includes(membership[0].role) || !await hasSiteReadGrant(env.DB, tenant, subject, route[2]) || draftBody?.site_id !== route[2]) return error("not_found", 404);
          const asset = await rows(env.DB.prepare("SELECT id FROM assets WHERE tenant_id=? AND site_id=? AND id=? LIMIT 2").bind(tenant, route[2], route[3]));
          if (asset.length !== 1 || asset[0].id !== route[3]) return error("not_found", 404);
          const assigned = await assignCalibrationReviewer(env.DB, tenant, subject, requestId, draftBody, calibrationReviewerAssign ? "assign" : "revoke");
          return assigned.error ? json({ error: assigned.error }, assigned.status) : json({ data: assigned.data, request_id: requestId }, assigned.status);
        }
        if (calibrationVerification) {
          if (request.method !== "POST" || !ROLE_ACTIONS[membership[0].role]?.has("read") || !await hasSiteReadGrant(env.DB, tenant, subject, calibrationVerification[2])) return error("not_found", 404);
          const reviewed = await reviewSensorCalibration(env.DB, tenant, calibrationVerification[2], calibrationVerification[3], calibrationVerification[4], subject, requestId, draftBody);
          return reviewed.error ? json({ error: reviewed.error }, reviewed.status) : json({ data: reviewed.data, request_id: requestId }, reviewed.status);
        }
        if (sensorMappingReviewerAssign || sensorMappingReviewerRevoke) {
          const route = sensorMappingReviewerAssign ?? sensorMappingReviewerRevoke;
          if (request.method !== "POST" || !["tenant_owner", "tenant_admin"].includes(membership[0].role) ||
              !await hasSiteReadGrant(env.DB, tenant, subject, route[2])) return error("not_found", 404);
          const assigned = await assignSensorSourceMappingReviewer(env.DB, tenant, route[2], subject, draftBody,
            sensorMappingReviewerAssign ? "assign" : "revoke");
          return assigned.error ? json({ error: assigned.error }, assigned.status) : json({ data: assigned.data, request_id: requestId }, assigned.status);
        }
        if (sensorMappingRegister) {
          if (request.method !== "POST" || !["tenant_owner", "tenant_admin"].includes(membership[0].role) ||
              !await hasSiteReadGrant(env.DB, tenant, subject, sensorMappingRegister[2])) return error("not_found", 404);
          const registered = await registerSensorSourceMapping(env.DB, tenant, sensorMappingRegister[1], sensorMappingRegister[2],
            sensorMappingRegister[3], subject, requestId, draftBody);
          return registered.error ? json({ error: registered.error }, registered.status) : json({ data: registered.data, request_id: requestId }, registered.status);
        }
        if (sensorMappingReview) {
          if (request.method !== "POST" || !ROLE_ACTIONS[membership[0].role]?.has("read") ||
              !await hasSiteReadGrant(env.DB, tenant, subject, sensorMappingReview[2])) return error("not_found", 404);
          const reviewed = await reviewSensorSourceMapping(env.DB, tenant, sensorMappingReview[1], sensorMappingReview[2],
            sensorMappingReview[3], sensorMappingReview[4], subject, requestId, draftBody);
          return reviewed.error ? json({ error: reviewed.error }, reviewed.status) : json({ data: reviewed.data, request_id: requestId }, reviewed.status);
        }
        if (calibrationRegister) {
          if (request.method !== "POST" || !["tenant_owner", "tenant_admin"].includes(membership[0].role) ||
              !await hasSiteReadGrant(env.DB, tenant, subject, calibrationRegister[2])) return error("not_found", 404);
          const registered = await registerSensorCalibration(env.DB, tenant, calibrationRegister[2],
            calibrationRegister[3], subject, requestId, draftBody);
          return registered.error ? json({ error: registered.error }, registered.status)
            : json({ data: registered.data, request_id: requestId }, registered.status);
        }
        if (labReportUpload || labReportDetail) {
          const siteId = (labReportUpload ?? labReportDetail)[2];
          if (!await hasSiteReadGrant(env.DB, tenant, subject, siteId)) return error("not_found", 404);
          if (labReportUpload) {
            if (request.method !== "POST" || !["tenant_owner", "tenant_admin"].includes(membership[0].role)) {
              return error("not_found", 404);
            }
            if (Object.hasOwn(draftBody, "site_id")) return error("invalid_request_body", 400);
            const registered = await registerLaboratoryReportEvidence(env.DB, tenant, subject,
              requestId, { ...draftBody, site_id: siteId });
            return registered.error ? json({ error: registered.error }, registered.status)
              : json({ data: registered.data, request_id: requestId }, registered.status);
          }
          if (!ROLE_ACTIONS[membership[0].role]?.has("read")) return error("not_found", 404);
          const evidence = await readLaboratoryReportEvidence(env.DB, tenant, subject, siteId, labReportDetail[3]);
          return evidence ? json({ data: evidence, request_id: requestId }) : error("not_found", 404);
        }
        if (observationVerification) {
          if (request.method !== "POST" || !ROLE_ACTIONS[membership[0].role]?.has("read")) return error("not_found", 404);
          const observationRows = await rows(env.DB.prepare(
            "SELECT site_id FROM observations WHERE tenant_id = ? AND id = ? LIMIT 2"
          ).bind(tenant, observationVerification[2]));
          if (observationRows.length !== 1 ||
              !await hasSiteReadGrant(env.DB, tenant, subject, observationRows[0].site_id)) return error("not_found", 404);
          const reviewed = await reviewObservation(env.DB, tenant, observationVerification[2],
            subject, requestId, draftBody);
          return reviewed.error ? json({ error: reviewed.error }, reviewed.status)
            : json({ data: reviewed.data, request_id: requestId }, reviewed.status);
        }
        if (criteriaAssess) {
          if (!ROLE_ACTIONS[membership[0].role]?.has("read")) return error("not_found", 404);
          if (!onlyKeys(draftBody, ["context", "samples"]) ||
              !Object.hasOwn(draftBody, "context") || !Object.hasOwn(draftBody, "samples")) return error("invalid_request_body", 400);
          if (!await hasSiteReadGrant(env.DB, tenant, subject, draftBody.context?.site_id)) return error("not_found", 404);
          const assessed = await assessStoredCriteria(env.DB, tenant, entryId, version, draftBody.context, draftBody.samples);
          return assessed.error ? json({ error: assessed.error }, assessed.status)
            : json({ data: assessed.data, request_id: requestId }, assessed.status);
        }
        if (criteriaResolve) {
          if (!ROLE_ACTIONS[membership[0].role]?.has("read")) return error("not_found", 404);
          if (!onlyKeys(draftBody, ["context", "sampled_at"]) ||
              !Object.hasOwn(draftBody, "context") || !Object.hasOwn(draftBody, "sampled_at")) return error("invalid_request_body", 400);
          if (!await hasSiteReadGrant(env.DB, tenant, subject, draftBody.context?.site_id)) return error("not_found", 404);
          const resolved = await resolveStoredCriteria(env.DB, tenant, entryId, version, draftBody.context, draftBody.sampled_at);
          return resolved.error ? json({ error: resolved.error }, resolved.status)
            : json({ data: resolved.data, request_id: requestId }, resolved.status);
        }
        if (request.method === "POST") {
          if (!["tenant_owner", "tenant_admin"].includes(membership[0].role)) return error("not_found", 404);
          if (criteriaSubmit) {
            if (!onlyKeys(draftBody, [])) return error("invalid_request_body", 400);
            const submitted = await submitCriteriaForReview(env.DB, tenant, entryId, version, subject, requestId);
            return submitted.error ? json({ error: submitted.error }, submitted.status)
              : json({ data: submitted.data, request_id: requestId }, submitted.status);
          }
          if (criteriaCreate) {
            if (!onlyKeys(draftBody, ["entry"]) || !Object.hasOwn(draftBody, "entry")) return error("invalid_request_body", 400);
            const created = await createCriteriaDraft(env.DB, tenant, subject, requestId, draftBody.entry);
            return created.error
              ? json({ error: created.error, details: created.details }, created.status)
              : json({ data: created.data, request_id: requestId }, created.status);
          }
          const action = reviewerAssign ? "assign" : "revoke";
          const provisioned = await provisionCriteriaReviewer(env.DB, tenant, subject, requestId, draftBody, action);
          return provisioned.error
            ? json({ error: provisioned.error }, provisioned.status)
            : json({ data: provisioned.data, request_id: requestId }, provisioned.status);
        }
        if (reviewerList) {
          if (!["tenant_owner", "tenant_admin"].includes(membership[0].role)) return error("not_found", 404);
          const data = await readCriteriaReviewers(env.DB, tenant);
          return json({ data, request_id: requestId });
        }
        if (!ROLE_ACTIONS[membership[0].role]?.has("read")) return error("not_found", 404);
        const data = await readCriteriaRegistry(env.DB, tenant, entryId, version, subject);
        return data === null ? error("not_found", 404) : json({ data, request_id: requestId });
      }
      const routeType = match[2];
      const type = routeType === "audit-events" ? "audit_event" : routeType.slice(0, -1);
      const record = await readResource(env.DB, subject, tenant, type, resourceId);
      return record ? json({ data: record, request_id: requestId }) : error("not_found", 404);
    } catch {
      return error("storage_unavailable", 503);
    }
  },
};

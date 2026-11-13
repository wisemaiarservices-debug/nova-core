import { json, error } from "./http.mjs";
import { validateWaterQualityCriteriaRegistryEntry, resolveApprovedWaterQualityCriteria } from "./water-quality-criteria-registry.mjs";
import { assessWaterQualityAgainstDeclaredCriteria } from "./water-quality-criteria-assessment.mjs";
import { createSiteConfiguration } from "./configuration-write-persistence.mjs";

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
      samples.some(sample => !onlyKeys(sample, ["id", "parameter", "value", "unit", "sampled_at"]))) {
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
    results.push(assessment.results[0]);
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

export default {
  async fetch(request, env) {
    if (request.method !== "GET" && request.method !== "POST") return error("not_found", 404);
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/internal\/v1\/tenants\/([^/]+)\/(sites|assets|sources|observations|audit-events)\/([^/]+)$/);
    const configurationRead = request.method === "GET" ? url.pathname.match(/^\/internal\/v1\/tenants\/([^/]+)\/sites\/([^/]+)\/configurations(?:\/([^/]+))?$/) : null;
    const configurationCreate = url.pathname.match(/^\/internal\/v1\/tenants\/([^/]+)\/sites\/([^/]+)\/configurations$/);
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
    if ((!match && !configurationRead && !configurationCreate && !criteriaCreate && !criteriaDetail && !reviewerAssign && !reviewerRevoke && !reviewerList && !criteriaSubmit && !criteriaReview && !criteriaResolve && !criteriaAssess) || url.search || url.hash ||
        (request.method === "POST" && (!configurationCreate && !configurationRead && !criteriaCreate && !reviewerAssign && !reviewerRevoke && !criteriaSubmit && !criteriaReview && !criteriaResolve && !criteriaAssess || criteriaDetail || match)) ||
        (request.method === "GET" && (configurationCreate || reviewerAssign || reviewerRevoke || criteriaSubmit || criteriaReview || criteriaResolve || criteriaAssess))) return error("not_found", 404);
    const tenant = match?.[1] ?? configurationRead?.[1] ?? configurationCreate?.[1] ?? criteriaCreate?.[1] ?? criteriaDetail?.[1] ?? reviewerAssign?.[1] ?? reviewerRevoke?.[1] ?? reviewerList?.[1] ?? criteriaSubmit?.[1] ?? criteriaReview?.[1] ?? criteriaResolve?.[1] ?? criteriaAssess?.[1];
    const resourceId = match?.[3];
    const configurationSiteId = configurationCreate?.[2] ?? configurationRead?.[2] ?? null;\n    const configurationVersion = configurationRead?.[3] ?? null;
    const entryId = criteriaDetail?.[2] ?? criteriaSubmit?.[2] ?? criteriaReview?.[2] ?? criteriaResolve?.[2] ?? criteriaAssess?.[2] ?? null;
    const version = criteriaDetail?.[3] ?? criteriaSubmit?.[3] ?? criteriaReview?.[3] ?? criteriaResolve?.[3] ?? criteriaAssess?.[3] ?? null;
    if (!validId(tenant, 120) || (resourceId && !validId(resourceId)) ||
        (configurationSiteId && !validId(configurationSiteId, 160)) ||\n        (configurationVersion && !validId(configurationVersion, 32)) ||
        (entryId && (!validId(entryId) || !validId(version, 80)))) return error("not_found", 404);

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
          !Number.isFinite(declaredLength) || declaredLength > 65536) return error("invalid_request_body", 400);
      try {
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > 65536) return error("invalid_request_body", 400);
        draftBody = JSON.parse(raw);
      } catch { return error("invalid_request_body", 400); }
      if (draftBody === null || typeof draftBody !== "object" || Array.isArray(draftBody)) return error("invalid_request_body", 400);
    }
    try {
      if (!(await consumeRequestId(env.DB, requestId, issuedAt))) return error("request_not_authorized", 401);
      if (configurationRead) {
        const membership = await rows(env.DB.prepare(
          "SELECT m.subject, m.tenant_id, m.role, m.status AS membership_status, t.status AS tenant_status FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.subject = ? AND m.tenant_id = ? LIMIT 2"
        ).bind(subject, tenant));
        if (membership.length !== 1 || membership[0].subject !== subject ||
            membership[0].tenant_id !== tenant || membership[0].membership_status !== "active" ||
            membership[0].tenant_status !== "active" || !ROLE_ACTIONS[membership[0].role]?.has("read") ||
            !(await hasSiteReadGrant(env.DB, tenant, subject, configurationSiteId))) {
          return error("not_found", 404);
        }
        const query = configurationVersion
          ? "SELECT id, tenant_id, site_id, configuration_version, schema_id, configuration_json, content_sha256, created_by_subject, request_id, created_at FROM tenant_site_configurations WHERE tenant_id = ? AND site_id = ? AND configuration_version = ? LIMIT 1"
          : "SELECT id, tenant_id, site_id, configuration_version, schema_id, configuration_json, content_sha256, created_by_subject, request_id, created_at FROM tenant_site_configurations WHERE tenant_id = ? AND site_id = ? ORDER BY CAST(substr(configuration_version, 2) AS INTEGER) DESC LIMIT 100";
        const configurations = await rows(configurationVersion
          ? env.DB.prepare(query).bind(tenant, configurationSiteId, configurationVersion)
          : env.DB.prepare(query).bind(tenant, configurationSiteId));
        const data = configurations.map(row => ({ ...row,
          configuration: JSON.parse(row.configuration_json), configuration_json: undefined }));
        return configurationVersion
          ? (data.length === 1 ? json({ data: data[0], request_id: requestId }) : error("not_found", 404))
          : json({ data, request_id: requestId });
      }
      if (configurationCreate) {
        if (!onlyKeys(draftBody, ["payload", "schema_id", "content_sha256"]) ||
            !Object.hasOwn(draftBody, "payload") || !Object.hasOwn(draftBody, "schema_id")) {
          return error("invalid_request_body", 400);
        }
        const idempotencyKey = request.headers.get("x-nova-idempotency-key");
        if (!validId(idempotencyKey, 200)) return error("idempotency_key_required", 400);
        try {
          const data = await createSiteConfiguration({
            db: env.DB, principalSubject: subject, tenantId: tenant,
            siteId: configurationSiteId, idempotencyKey, requestId,
            payload: draftBody.payload, schemaId: draftBody.schema_id,
            suppliedDigest: draftBody.content_sha256,
          });
          return json({ data, request_id: requestId }, data.replayed ? 200 : 201);
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : "";
          if (reason === "configuration_authorization_denied") return error("not_found", 404);
          if (reason === "configuration_idempotency_conflict") return error("idempotency_key_conflict", 409);
          if (reason === "configuration_domain_invalid") return error("configuration_domain_invalid", 422);
          if (reason.startsWith("configuration_request_invalid") ||
              reason.startsWith("configuration_schema_") ||
              reason.startsWith("configuration_digest_") ||
              reason.startsWith("configuration_must_be_") ||
              reason.startsWith("configuration_forbidden_") ||
              reason === "configuration_value_not_json" ||
              reason.startsWith("configuration_non_") ||
              reason.startsWith("configuration_depth_") ||
              reason.startsWith("configuration_complexity_") ||
              reason.startsWith("configuration_array_") ||
              reason.startsWith("configuration_too_large")) return error("invalid_configuration", 400);
          return error("storage_unavailable", 503);
        }
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
      if (criteriaCreate || reviewerAssign || reviewerRevoke || reviewerList || criteriaSubmit || criteriaResolve || criteriaAssess) {
        const membership = await rows(env.DB.prepare(
          "SELECT m.subject, m.tenant_id, m.role, m.status AS membership_status, t.status AS tenant_status FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.subject = ? AND m.tenant_id = ? LIMIT 2"
        ).bind(subject, tenant));
        if (membership.length !== 1 || membership[0].subject !== subject ||
            membership[0].tenant_id !== tenant || membership[0].membership_status !== "active" ||
            membership[0].tenant_status !== "active") return error("not_found", 404);
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

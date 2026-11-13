const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const ROLES = new Set(["regulatory_reviewer", "domain_expert"]);
const STATUSES = new Set(["draft", "review_pending", "approved", "rejected", "superseded", "retired"]);

function validDate(value) {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function validTimestamp(value) {
  return typeof value === "string" && TIMESTAMP.test(value) &&
    validDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
}
function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function issue(code, path) { return { code, path }; }

/**
 * Structural governance checks only. This does not authenticate source
 * documents, reviewer identities, legal authority, or approval signatures.
 */
export function validateWaterQualityCriteriaRegistryEntry(entry) {
  const errors = [];
  if (!object(entry)) return { valid: false, errors: [issue("entry.invalid_type", "$")] };
  for (const key of ["id", "jurisdiction", "title", "version"]) {
    if (!nonempty(entry[key])) errors.push(issue("entry.required_field_missing", key));
  }
  if (!object(entry.authority) || !nonempty(entry.authority.name) ||
      !nonempty(entry.authority.source_evidence_ref) ||
      !/^sha256:[a-f0-9]{64}$/i.test(entry.authority.document_digest ?? "")) {
    errors.push(issue("authority.source_provenance_incomplete", "authority"));
  }
  if (!validDate(entry.published_on) || !validDate(entry.effective_from) ||
      (entry.effective_to !== undefined && !validDate(entry.effective_to))) {
    errors.push(issue("entry.date_invalid", "published_on/effective_period"));
  }
  if (entry.effective_to && entry.effective_to < entry.effective_from) {
    errors.push(issue("entry.effective_period_reversed", "effective_period"));
  }
  if (!object(entry.scope)) {
    errors.push(issue("entry.scope_missing", "scope"));
  } else {
    for (const key of ["crop_ids", "irrigation_methods", "intended_uses"]) {
      if (!Array.isArray(entry.scope[key]) || entry.scope[key].length === 0 ||
          entry.scope[key].some(value => !nonempty(value))) {
        errors.push(issue("entry.scope_explicit_values_required", "scope." + key));
      }
    }
    for (const key of ["tenant_id", "site_id"]) {
      if (entry.scope[key] !== undefined && !nonempty(entry.scope[key])) {
        errors.push(issue("entry.scope_identifier_invalid", "scope." + key));
      }
    }
  }
  if (!Array.isArray(entry.criteria) || entry.criteria.length === 0) {
    errors.push(issue("entry.criteria_required", "criteria"));
  } else {
    entry.criteria.forEach((rule, index) => {
      const path = "criteria[" + index + "]";
      if (!object(rule) || !nonempty(rule.parameter) || !nonempty(rule.unit) ||
          !nonempty(rule.reference_clause) || !nonempty(rule.evidence_ref) ||
          !["max", "min", "range"].includes(rule.operator)) {
        errors.push(issue("criterion.rule_or_provenance_incomplete", path));
        return;
      }
      if (rule.operator === "range") {
        if (!Number.isFinite(rule.minimum) || !Number.isFinite(rule.maximum) ||
            rule.minimum > rule.maximum) errors.push(issue("criterion.range_invalid", path));
      } else if (!Number.isFinite(rule.value)) {
        errors.push(issue("criterion.value_invalid", path));
      }
    });
  }
  if (!object(entry.review) || !STATUSES.has(entry.review.status)) {
    errors.push(issue("review.status_invalid", "review.status"));
  } else if (entry.review.status === "approved") {
    const approvals = Array.isArray(entry.review.approvals) ? entry.review.approvals : [];
    const roles = new Set(approvals.filter(item => object(item) &&
      nonempty(item.reviewer_id) && ROLES.has(item.role) &&
      validTimestamp(item.reviewed_at) && nonempty(item.evidence_ref))
      .map(item => item.role));
    const reviewers = new Set(approvals.filter(item => object(item) &&
      nonempty(item.reviewer_id) && ROLES.has(item.role) &&
      validTimestamp(item.reviewed_at) && nonempty(item.evidence_ref))
      .map(item => item.reviewer_id));
    if (!roles.has("regulatory_reviewer") || !roles.has("domain_expert") || reviewers.size < 2) {
      errors.push(issue("review.independent_role_approvals_required", "review.approvals"));
    }
  }
  if (entry.supersedes_id !== undefined && !nonempty(entry.supersedes_id)) {
    errors.push(issue("entry.supersedes_reference_invalid", "supersedes_id"));
  }
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

/**
 * Resolves an entry for a sample/context only when explicitly approved,
 * exactly scoped, and effective on the sample date. Returns references, not
 * a declaration that the underlying law or source is authentic/current.
 */
export function resolveApprovedWaterQualityCriteria(entry, context, sampledAt) {
  const validation = validateWaterQualityCriteriaRegistryEntry(entry);
  if (!validation.valid) return { status: "not_assessed", reason: "registry_entry_invalid", errors: validation.errors };
  if (entry.review.status !== "approved") return { status: "not_assessed", reason: "registry_entry_not_approved" };
  if (!object(context) || !validTimestamp(sampledAt)) return { status: "not_assessed", reason: "context_or_sample_timestamp_invalid" };
  const scope = entry.scope;
  if ((scope.tenant_id !== undefined && scope.tenant_id !== context.tenant_id) ||
      (scope.site_id !== undefined && scope.site_id !== context.site_id) ||
      !scope.crop_ids.includes(context.crop_id) ||
      !scope.irrigation_methods.includes(context.irrigation_method) ||
      !scope.intended_uses.includes(context.intended_use) ||
      context.jurisdiction !== entry.jurisdiction) {
    return { status: "not_assessed", reason: "registry_scope_mismatch" };
  }
  const date = sampledAt.slice(0, 10);
  if (date < entry.effective_from || (entry.effective_to && date > entry.effective_to)) {
    return { status: "not_assessed", reason: "registry_entry_not_effective_on_sample_date" };
  }
  return Object.freeze({
    status: "approved_entry_scope_match",
    entry_id: entry.id,
    version: entry.version,
    jurisdiction: entry.jurisdiction,
    effective_from: entry.effective_from,
    effective_to: entry.effective_to ?? null,
    criteria: entry.criteria,
    source_evidence_ref: entry.authority.source_evidence_ref,
    document_digest: entry.authority.document_digest,
    review_status: "approved_by_declared_reviewers",
    legal_status: "not_independently_verified",
    source_authenticity: "not_independently_verified",
    operational_decision: "not_authorized",
  });
}

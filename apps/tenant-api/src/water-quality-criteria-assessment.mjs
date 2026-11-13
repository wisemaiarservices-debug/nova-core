function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function validTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  return isoDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
}
function inRange(value, criterion) {
  if (criterion.operator === "max") return value <= criterion.value;
  if (criterion.operator === "min") return value >= criterion.value;
  if (criterion.operator === "range") {
    return Number.isFinite(criterion.minimum) && Number.isFinite(criterion.maximum) &&
      criterion.minimum <= criterion.maximum && value >= criterion.minimum && value <= criterion.maximum;
  }
  return null;
}

/**
 * Compares water-quality sample values only against caller-supplied, scoped,
 * dated criteria with explicit provenance. It does not validate legal status,
 * scientific suitability, sampling representativeness or operational safety.
 */
export function assessWaterQualityAgainstDeclaredCriteria(samples, context, criteriaSet) {
  const insufficient = (reason, details = {}) => ({
    status: "criteria_not_assessed", reason, ...details,
  });
  if (!Array.isArray(samples)) return insufficient("water_quality_samples_missing");
  if (!object(context) || typeof context.jurisdiction !== "string" ||
      !context.jurisdiction.trim() || typeof context.crop_id !== "string" ||
      !context.crop_id.trim() || typeof context.irrigation_method !== "string" ||
      !context.irrigation_method.trim() || typeof context.intended_use !== "string" ||
      !context.intended_use.trim()) {
    return insufficient("explicit_jurisdiction_crop_method_and_use_required");
  }
  if (!object(criteriaSet) || !Array.isArray(criteriaSet.criteria) ||
      typeof criteriaSet.id !== "string" || !criteriaSet.id.trim() ||
      typeof criteriaSet.authority !== "string" || !criteriaSet.authority.trim() ||
      typeof criteriaSet.title !== "string" || !criteriaSet.title.trim() ||
      typeof criteriaSet.version !== "string" || !criteriaSet.version.trim() ||
      typeof criteriaSet.evidence_ref !== "string" || !criteriaSet.evidence_ref.trim() ||
      !isoDate(criteriaSet.effective_from) ||
      (criteriaSet.effective_to !== undefined && !isoDate(criteriaSet.effective_to))) {
    return insufficient("criteria_set_provenance_or_effective_dates_incomplete");
  }
  if (criteriaSet.effective_to && criteriaSet.effective_to < criteriaSet.effective_from) {
    return insufficient("criteria_set_effective_period_invalid");
  }
  const results = samples.map((sample, index) => {
    if (!object(sample) || typeof sample.parameter !== "string" ||
        typeof sample.value !== "number" || !Number.isFinite(sample.value) ||
        typeof sample.unit !== "string" || !sample.unit.trim() ||
        !validTimestamp(sample.sampled_at)) {
      return { sample_id: sample?.id ?? null, status: "not_assessed", reason: "sample_value_unit_or_date_invalid", index };
    }
    const matches = criteriaSet.criteria.filter(rule => object(rule) &&
      rule.parameter === sample.parameter && rule.unit === sample.unit &&
      rule.jurisdiction === context.jurisdiction &&
      rule.crop_id === context.crop_id &&
      rule.irrigation_method === context.irrigation_method &&
      rule.intended_use === context.intended_use);
    if (matches.length !== 1) {
      return { sample_id: sample.id ?? null, parameter: sample.parameter,
        status: "not_assessed", reason: matches.length ? "criterion_ambiguous" : "no_exactly_scoped_criterion" };
    }
    const rule = matches[0];
    if (!["max", "min", "range"].includes(rule.operator) ||
        (rule.operator !== "range" && !Number.isFinite(rule.value)) ||
        (rule.operator === "range" && (!Number.isFinite(rule.minimum) ||
          !Number.isFinite(rule.maximum) || rule.minimum > rule.maximum)) ||
        typeof rule.evidence_ref !== "string" || !rule.evidence_ref.trim() ||
        typeof rule.reference_clause !== "string" || !rule.reference_clause.trim()) {
      return { sample_id: sample.id ?? null, parameter: sample.parameter,
        status: "not_assessed", reason: "criterion_rule_or_source_provenance_incomplete" };
    }
    const sampledDate = sample.sampled_at.slice(0, 10);
    if (sampledDate < criteriaSet.effective_from ||
        (criteriaSet.effective_to && sampledDate > criteriaSet.effective_to)) {
      return { sample_id: sample.id ?? null, parameter: sample.parameter,
        status: "not_assessed", reason: "criterion_not_effective_on_sample_date" };
    }
    const comparison = inRange(sample.value, rule);
    if (comparison === null) {
      return { sample_id: sample.id ?? null, parameter: sample.parameter,
        status: "not_assessed", reason: "criterion_operator_unsupported" };
    }
    return {
      sample_id: sample.id ?? null,
      parameter: sample.parameter,
      unit: sample.unit,
      observed_value: sample.value,
      status: comparison ? "within_declared_criterion" : "outside_declared_criterion",
      criterion: {
        set_id: criteriaSet.id,
        authority: criteriaSet.authority,
        title: criteriaSet.title,
        version: criteriaSet.version,
        reference_clause: rule.reference_clause,
        operator: rule.operator,
        value: rule.value ?? null,
        minimum: rule.minimum ?? null,
        maximum: rule.maximum ?? null,
        evidence_refs: [criteriaSet.evidence_ref, rule.evidence_ref],
      },
    };
  });
  return Object.freeze({
    status: results.every(item => item.status !== "not_assessed")
      ? "declared_criteria_comparison_complete" : "partial_criteria_comparison",
    context: Object.freeze({ ...context }),
    criteria_set: Object.freeze({
      id: criteriaSet.id, authority: criteriaSet.authority,
      title: criteriaSet.title, version: criteriaSet.version,
      effective_from: criteriaSet.effective_from,
      effective_to: criteriaSet.effective_to ?? null,
      evidence_ref: criteriaSet.evidence_ref,
    }),
    results: Object.freeze(results),
    interpretation: "comparison_to_caller_supplied_criteria_only",
    legal_status: "not_verified",
    scientific_suitability: "not_assessed",
    operational_decision: "not_authorized",
    limitations: Object.freeze([
      "no_default_or_universal_thresholds_are_embedded",
      "no_unit_conversion_or_parameter_aliasing_is_performed",
      "criteria_authority_accuracy_and_current_legal_status_are_not_independently_verified",
      "within_declared_criterion_does_not_mean_safe_or_suitable",
      "outside_declared_criterion_is_not_a_standalone_operational_decision",
      "sampling_representativeness_and_laboratory_accreditation_are_not_established",
      "human_regulatory_and_domain_expert_review_is_required",
    ]),
  });
}

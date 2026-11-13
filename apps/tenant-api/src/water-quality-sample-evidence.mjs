const OBSERVATION_REF = /^observation:([A-Za-z0-9][A-Za-z0-9._:-]{0,159})$/;

/**
 * Resolve measured sample evidence against a tenant/site-owned Core observation.
 * A reference string alone is never sufficient. The stored value, metric, unit,
 * timestamp and verified state must all match exactly.
 */
export async function resolveWaterQualitySampleEvidence(db, tenantId, siteId, sample) {
  const provenance = sample?.provenance;
  if (provenance?.source_type === "synthetic") {
    return { eligible: false, reason: "synthetic_sample_not_eligible_for_field_assessment" };
  }
  if (provenance?.source_type !== "measured") {
    return { eligible: false, reason: "external_evidence_verification_not_configured" };
  }
  const reference = typeof provenance.evidence_ref === "string"
    ? OBSERVATION_REF.exec(provenance.evidence_ref) : null;
  if (!reference) return { eligible: false, reason: "persisted_observation_reference_required" };
  const matches = await db.prepare(
    "SELECT id, tenant_id, site_id, metric, value, unit, observed_at, verification_status " +
    "FROM observations WHERE id = ? AND tenant_id = ? AND site_id = ? LIMIT 2"
  ).bind(reference[1], tenantId, siteId).all();
  if (!matches || !Array.isArray(matches.results) || matches.results.length !== 1) {
    return { eligible: false, reason: "persisted_observation_not_found_in_site_scope" };
  }
  const row = matches.results[0];
  if (row.id !== reference[1] || row.tenant_id !== tenantId || row.site_id !== siteId ||
      row.metric !== sample.parameter || row.value !== sample.value ||
      row.unit !== sample.unit || row.observed_at !== sample.sampled_at) {
    return { eligible: false, reason: "persisted_observation_payload_mismatch" };
  }
  if (row.verification_status !== "verified") {
    return { eligible: false, reason: "persisted_observation_not_verified" };
  }
  return { eligible: true, verification_status: "matched_to_verified_core_observation" };
}

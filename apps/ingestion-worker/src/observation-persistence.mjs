const encoder = new TextEncoder();

function stableJson(value) {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((key) =>
      JSON.stringify(key) + ":" + stableJson(value[key])
    ).join(",") + "}";
  }
  return JSON.stringify(value);
}

async function stableId(sourceId, idempotencyKey) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(sourceId + "\u0000" + idempotencyKey),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return hex;
}

const EXISTING_OBSERVATION_QUERY =
  "SELECT id, tenant_id, site_id, asset_id, source_id, module, metric, value, unit, observed_at, " +
  "idempotency_key, verification_status, provenance_json, quality_flags_json, source_capability_id, " +
  "measurement_kind, acquisition_protocol, protocol_version, sampling_mode, sampling_interval_seconds " +
  "FROM observations WHERE source_id = ? AND idempotency_key = ? LIMIT 1";

async function findExistingObservation(database, observation) {
  return database.prepare(EXISTING_OBSERVATION_QUERY)
    .bind(observation.source_id, observation.idempotency_key)
    .first();
}

function sameAcceptedPayload(row, observation, tenantId) {
  return row.tenant_id === tenantId &&
    row.site_id === observation.site_id &&
    (row.asset_id ?? null) === (observation.asset_id ?? null) &&
    row.module === observation.module &&
    row.source_capability_id === observation.source_capability_id &&
    row.measurement_kind === observation.measurement_kind &&
    row.acquisition_protocol === observation.acquisition_protocol &&
    row.protocol_version === observation.protocol_version &&
    row.sampling_mode === observation.sampling_mode &&
    (row.sampling_interval_seconds ?? null) === (observation.sampling_interval_seconds ?? null) &&
    row.metric === observation.metric &&
    Number(row.value) === observation.value &&
    row.unit === observation.unit &&
    row.observed_at === observation.observed_at &&
    row.provenance_json === stableJson(observation.provenance) &&
    row.quality_flags_json === stableJson(observation.quality_flags ?? []);
}

/**
 * Persist one authenticated observation after tenant ownership was resolved
 * from the stored site/source/asset records. Both observation and audit rows
 * carry that server-derived tenant. Verification remains explicitly unverified.
 */
export async function persistObservation(database, observation, principal, requestId = null, tenantId = null) {
  if (!database || typeof database.prepare !== "function" ||
      typeof database.batch !== "function") {
    throw new Error("storage_not_configured");
  }
  if (!principal || typeof principal.serviceId !== "string" || !principal.serviceId.trim() ||
      typeof tenantId !== "string" || !tenantId.trim()) {
    throw new Error("verified_service_principal_and_tenant_required");
  }

  // Idempotent retries represent an already accepted historical write. Resolve
  // them before INSERT so current capability/rights guards do not reject a
  // replay of an observation that was validly committed before revocation.
  const previouslyAccepted = await findExistingObservation(database, observation);
  if (previouslyAccepted) {
    if (!sameAcceptedPayload(previouslyAccepted, observation, tenantId)) {
      return { status: "idempotency_conflict", accepted: false };
    }
    return {
      status: "already_accepted",
      accepted: true,
      observation_id: previouslyAccepted.id,
      verification_status: previouslyAccepted.verification_status,
      idempotent: true,
    };
  }

  const digest = await stableId(observation.source_id, observation.idempotency_key);
  const observationId = "obs_" + digest;
  const auditId = "audit_" + digest;
  const provenanceJson = stableJson(observation.provenance);
  const qualityFlagsJson = stableJson(observation.quality_flags ?? []);
  const detailsJson = stableJson({
    module: observation.module,
    source_id: observation.source_id,
    metric: observation.metric,
    verification_status: "unverified",
    source_capability_id: observation.source_capability_id,
    measurement_kind: observation.measurement_kind,
    acquisition_protocol: observation.acquisition_protocol,
    protocol_version: observation.protocol_version,
    sampling_mode: observation.sampling_mode,
    sampling_interval_seconds: observation.sampling_interval_seconds,
    idempotency_key: observation.idempotency_key,
  });

  const insertObservation = database.prepare(
    "INSERT OR IGNORE INTO observations " +
    "(id, site_id, tenant_id, asset_id, source_id, module, metric, value, unit, observed_at, " +
    "idempotency_key, verification_status, provenance_json, quality_flags_json, source_capability_id, " +
    "measurement_kind, acquisition_protocol, protocol_version, sampling_mode, sampling_interval_seconds) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unverified', ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    observationId,
    observation.site_id,
    tenantId,
    observation.asset_id ?? null,
    observation.source_id,
    observation.module,
    observation.metric,
    observation.value,
    observation.unit,
    observation.observed_at,
    observation.idempotency_key,
    provenanceJson,
    qualityFlagsJson,
    observation.source_capability_id,
    observation.measurement_kind,
    observation.acquisition_protocol,
    observation.protocol_version,
    observation.sampling_mode,
    observation.sampling_interval_seconds,
  );

  const insertAudit = database.prepare(
    "INSERT OR IGNORE INTO audit_events " +
    "(id, tenant_id, actor_type, actor_id, action, entity_type, entity_id, occurred_at, request_id, details_json) " +
    "SELECT ?, ?, 'service', ?, 'observation.accepted', 'observation', ?, " +
    "strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ? " +
    "WHERE EXISTS (SELECT 1 FROM observations WHERE id = ? AND tenant_id = ? " +
    "AND site_id = ? AND asset_id IS ? AND source_id = ? AND module = ? AND metric = ? " +
    "AND value = ? AND unit = ? AND observed_at = ? AND idempotency_key = ? " +
    "AND provenance_json = ? AND quality_flags_json = ? AND source_capability_id = ? " +
    "AND measurement_kind = ? AND acquisition_protocol = ? AND protocol_version = ? " +
    "AND sampling_mode = ? AND sampling_interval_seconds IS ?)",
  ).bind(auditId, tenantId, principal.serviceId, observationId, requestId,
    detailsJson, observationId, tenantId, observation.site_id, observation.asset_id ?? null,
    observation.source_id, observation.module, observation.metric, observation.value,
    observation.unit, observation.observed_at, observation.idempotency_key, provenanceJson,
    qualityFlagsJson, observation.source_capability_id, observation.measurement_kind,
    observation.acquisition_protocol, observation.protocol_version, observation.sampling_mode,
    observation.sampling_interval_seconds ?? null);

  const batchResults = await database.batch([insertObservation, insertAudit]);
  const inserted = Number(batchResults?.[0]?.meta?.changes ?? 0) > 0;

  const existing = await findExistingObservation(database, observation);

  if (!existing) throw new Error("observation_persistence_unconfirmed");
  if (!sameAcceptedPayload(existing, observation, tenantId)) {
    return { status: "idempotency_conflict", accepted: false };
  }

  return {
    status: inserted ? "accepted" : "already_accepted",
    accepted: true,
    observation_id: existing.id,
    verification_status: existing.verification_status,
    idempotent: !inserted,
  };
}

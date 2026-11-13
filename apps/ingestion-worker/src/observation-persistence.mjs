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

function sameAcceptedPayload(row, observation, tenantId) {
  return row.tenant_id === tenantId &&
    row.site_id === observation.site_id &&
    (row.asset_id ?? null) === (observation.asset_id ?? null) &&
    row.module === observation.module &&
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
    idempotency_key: observation.idempotency_key,
  });

  const insertObservation = database.prepare(
    "INSERT OR IGNORE INTO observations " +
    "(id, site_id, tenant_id, asset_id, source_id, module, metric, value, unit, observed_at, " +
    "idempotency_key, verification_status, provenance_json, quality_flags_json) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unverified', ?, ?)",
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
  );

  const insertAudit = database.prepare(
    "INSERT OR IGNORE INTO audit_events " +
    "(id, tenant_id, actor_type, actor_id, action, entity_type, entity_id, occurred_at, request_id, details_json) " +
    "SELECT ?, ?, 'service', ?, 'observation.accepted', 'observation', ?, " +
    "strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ? " +
    "WHERE EXISTS (SELECT 1 FROM observations WHERE id = ? AND tenant_id = ?)",
  ).bind(auditId, tenantId, principal.serviceId, observationId, requestId,
    detailsJson, observationId, tenantId);

  const batchResults = await database.batch([insertObservation, insertAudit]);
  const inserted = Number(batchResults?.[0]?.meta?.changes ?? 0) > 0;

  const existing = await database.prepare(
    "SELECT id, tenant_id, site_id, asset_id, source_id, module, metric, value, unit, observed_at, " +
    "idempotency_key, verification_status, provenance_json, quality_flags_json " +
    "FROM observations WHERE source_id = ? AND idempotency_key = ? LIMIT 1",
  ).bind(observation.source_id, observation.idempotency_key).first();

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

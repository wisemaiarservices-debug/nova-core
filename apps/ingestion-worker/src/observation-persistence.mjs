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

function sameAcceptedPayload(row, observation) {
  return row.site_id === observation.site_id &&
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
 * Persist one already-authenticated, authorized and ownership-checked observation.
 * D1 batch is transactional. Both rows remain unverified; caller identity is
 * server-derived. Stable IDs and the unique source/idempotency index make retries safe.
 */
export async function persistObservation(database, observation, principal, requestId = null) {
  if (!database || typeof database.prepare !== "function" ||
      typeof database.batch !== "function") {
    throw new Error("storage_not_configured");
  }
  if (!principal || typeof principal.serviceId !== "string" || !principal.serviceId.trim()) {
    throw new Error("verified_service_principal_required");
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
    "(id, site_id, asset_id, source_id, module, metric, value, unit, observed_at, " +
    "idempotency_key, verification_status, provenance_json, quality_flags_json) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unverified', ?, ?)",
  ).bind(
    observationId,
    observation.site_id,
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
    "(id, actor_type, actor_id, action, entity_type, entity_id, occurred_at, request_id, details_json) " +
    "SELECT ?, 'service', ?, 'observation.accepted', 'observation', ?, " +
    "strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ? " +
    "WHERE EXISTS (SELECT 1 FROM observations WHERE id = ?)",
  ).bind(auditId, principal.serviceId, observationId, requestId, detailsJson, observationId);

  await database.batch([insertObservation, insertAudit]);

  const existing = await database.prepare(
    "SELECT id, site_id, asset_id, source_id, module, metric, value, unit, observed_at, " +
    "idempotency_key, verification_status, provenance_json, quality_flags_json " +
    "FROM observations WHERE source_id = ? AND idempotency_key = ? LIMIT 1",
  ).bind(observation.source_id, observation.idempotency_key).first();

  if (!existing) throw new Error("observation_persistence_unconfirmed");
  if (!sameAcceptedPayload(existing, observation)) {
    return { status: "idempotency_conflict", accepted: false };
  }

  return {
    status: existing.id === observationId ? "accepted" : "already_accepted",
    accepted: true,
    observation_id: existing.id,
    verification_status: existing.verification_status,
    idempotent: existing.id !== observationId,
  };
}

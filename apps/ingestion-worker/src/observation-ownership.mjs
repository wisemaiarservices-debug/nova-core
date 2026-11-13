export async function resolveObservationOwnership(database, observation) {
  if (!database || typeof database.prepare !== "function") {
    throw new Error("storage_not_configured");
  }

  // Tenant ownership is resolved exclusively from registered Core records.
  // The producer envelope intentionally has no tenant_id field.
  const site = await database.prepare(
    "SELECT s.id, s.status, s.tenant_id, t.status AS tenant_status " +
    "FROM sites s LEFT JOIN tenants t ON t.id = s.tenant_id " +
    "WHERE s.id = ? LIMIT 1",
  ).bind(observation.site_id).first();
  if (!site || site.status !== "active" || typeof site.tenant_id !== "string" ||
      !site.tenant_id.trim() || site.tenant_status !== "active") return null;

  const source = await database.prepare(
    "SELECT id, site_id, module, verification_status, tenant_id " +
    "FROM sources WHERE id = ? LIMIT 1",
  ).bind(observation.source_id).first();
  if (!source || source.module !== observation.module ||
      source.verification_status === "disabled" ||
      source.tenant_id !== site.tenant_id ||
      (source.site_id !== null && source.site_id !== observation.site_id)) {
    return null;
  }

  if (observation.asset_id !== undefined && observation.asset_id !== null) {
    const asset = await database.prepare(
      "SELECT id, site_id, status, tenant_id FROM assets WHERE id = ? LIMIT 1",
    ).bind(observation.asset_id).first();
    if (!asset || asset.site_id !== observation.site_id ||
        asset.tenant_id !== site.tenant_id || asset.status !== "active") {
      return null;
    }
  }

  return Object.freeze({ tenantId: site.tenant_id });
}

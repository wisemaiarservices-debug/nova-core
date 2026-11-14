export async function resolveObservationOwnership(database, observation) {
  if (!database || typeof database.prepare !== "function") {
    throw new Error("storage_not_configured");
  }

  const site = await database.prepare(
    "SELECT id, tenant_id, status FROM sites WHERE id = ? LIMIT 1",
  ).bind(observation.site_id).first();
  if (!site || site.status !== "active" || typeof site.tenant_id !== "string" || !site.tenant_id.trim()) return false;

  const source = await database.prepare(
    "SELECT id, tenant_id, site_id, module, verification_status FROM sources WHERE id = ? LIMIT 1",
  ).bind(observation.source_id).first();
  if (!source || source.tenant_id !== site.tenant_id || source.module !== observation.module ||
      source.verification_status !== "verified" ||
      (source.site_id !== null && source.site_id !== observation.site_id)) {
    return false;
  }

  if (observation.asset_id !== undefined && observation.asset_id !== null) {
    const asset = await database.prepare(
      "SELECT id, tenant_id, site_id, status FROM assets WHERE id = ? LIMIT 1",
    ).bind(observation.asset_id).first();
    if (!asset || asset.tenant_id !== site.tenant_id || asset.site_id !== observation.site_id || asset.status !== "active") {
      return false;
    }
  }

  return site.tenant_id;
}

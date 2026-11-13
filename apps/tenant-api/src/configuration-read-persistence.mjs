const READ_ROLES = new Set(["tenant_owner", "tenant_admin", "operator", "analyst", "viewer", "service"]);

async function all(statement) {
  const result = await statement.all();
  if (!result || !Array.isArray(result.results)) throw new Error("configuration_read_storage_invalid_result");
  return result.results;
}

export async function readSiteConfigurationHistory({ db, principalSubject, tenantId, siteId, version = null }) {
  if (!db || typeof db.prepare !== "function" ||
      typeof principalSubject !== "string" || !principalSubject.trim() ||
      typeof tenantId !== "string" || !tenantId.trim() ||
      typeof siteId !== "string" || !siteId.trim() ||
      (version !== null && (typeof version !== "string" || !/^v[1-9][0-9]{0,30}$/.test(version)))) {
    return { error: "not_found", status: 404 };
  }

  const memberships = await all(db.prepare(
    "SELECT m.subject, m.tenant_id, m.role, m.status AS membership_status, t.status AS tenant_status " +
    "FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id " +
    "WHERE m.subject = ? AND m.tenant_id = ? LIMIT 2"
  ).bind(principalSubject, tenantId));
  if (memberships.length !== 1 || memberships[0].subject !== principalSubject ||
      memberships[0].tenant_id !== tenantId || memberships[0].membership_status !== "active" ||
      memberships[0].tenant_status !== "active" || !READ_ROLES.has(memberships[0].role)) {
    return { error: "not_found", status: 404 };
  }

  const grants = await all(db.prepare(
    "SELECT subject, tenant_id, resource_type, resource_id, action FROM tenant_resource_grants " +
    "WHERE tenant_id = ? AND subject = ? AND resource_type = 'site' AND resource_id = ? AND action = 'read' LIMIT 2"
  ).bind(tenantId, principalSubject, siteId));
  if (grants.length !== 1 || grants[0].subject !== principalSubject ||
      grants[0].tenant_id !== tenantId || grants[0].resource_type !== "site" ||
      grants[0].resource_id !== siteId || grants[0].action !== "read") {
    return { error: "not_found", status: 404 };
  }

  const select = "SELECT c.id, c.tenant_id, c.site_id, c.configuration_version, c.schema_id, " +
    "c.configuration_json, c.content_sha256, c.created_by_subject, c.request_id, c.created_at, " +
    "(SELECT e.event_type FROM tenant_site_configuration_events e WHERE e.configuration_id = c.id " +
    "AND e.tenant_id = c.tenant_id AND e.site_id = c.site_id ORDER BY e.rowid DESC LIMIT 1) AS lifecycle_status " +
    "FROM tenant_site_configurations c WHERE c.tenant_id = ? AND c.site_id = ";
  const records = version === null
    ? await all(db.prepare(select + "? ORDER BY CAST(substr(c.configuration_version, 2) AS INTEGER) DESC LIMIT 100")
      .bind(tenantId, siteId))
    : await all(db.prepare(select + "? AND c.configuration_version = ? LIMIT 1")
      .bind(tenantId, siteId, version));
  if (version !== null && records.length !== 1) return { error: "not_found", status: 404 };

  const data = records.map(row => ({
    id: row.id, tenant_id: row.tenant_id, site_id: row.site_id,
    configuration_version: row.configuration_version, schema_id: row.schema_id,
    configuration: JSON.parse(row.configuration_json), content_sha256: row.content_sha256,
    created_by_subject: row.created_by_subject, request_id: row.request_id,
    created_at: row.created_at, lifecycle_status: row.lifecycle_status ?? "unknown",
  }));
  return { data: version === null ? data : data[0], status: 200 };
}


export async function readLatestApprovedSiteConfiguration({ db, principalSubject, tenantId, siteId }) {
  if (!db || typeof db.prepare !== "function" ||
      typeof principalSubject !== "string" || !principalSubject.trim() ||
      typeof tenantId !== "string" || !tenantId.trim() ||
      typeof siteId !== "string" || !siteId.trim()) {
    return { error: "not_found", status: 404 };
  }
  const memberships = await all(db.prepare(
    "SELECT m.subject, m.tenant_id, m.role, m.status AS membership_status, t.status AS tenant_status " +
    "FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id " +
    "WHERE m.subject = ? AND m.tenant_id = ? LIMIT 2"
  ).bind(principalSubject, tenantId));
  if (memberships.length !== 1 || memberships[0].subject !== principalSubject ||
      memberships[0].tenant_id !== tenantId || memberships[0].membership_status !== "active" ||
      memberships[0].tenant_status !== "active" ||
      !new Set(["tenant_owner", "tenant_admin", "operator", "analyst", "viewer", "service"]).has(memberships[0].role)) {
    return { error: "not_found", status: 404 };
  }
  const grants = await all(db.prepare(
    "SELECT subject, tenant_id, resource_type, resource_id, action FROM tenant_resource_grants " +
    "WHERE tenant_id = ? AND subject = ? AND resource_type = 'site' AND resource_id = ? AND action = 'read' LIMIT 2"
  ).bind(tenantId, principalSubject, siteId));
  if (grants.length !== 1 || grants[0].subject !== principalSubject ||
      grants[0].tenant_id !== tenantId || grants[0].resource_type !== "site" ||
      grants[0].resource_id !== siteId || grants[0].action !== "read") {
    return { error: "not_found", status: 404 };
  }
  const records = await all(db.prepare(
    "SELECT c.id, c.tenant_id, c.site_id, c.configuration_version, c.schema_id, " +
    "c.configuration_json, c.content_sha256, c.created_by_subject, c.request_id, c.created_at, " +
    "(SELECT e.event_type FROM tenant_site_configuration_events e WHERE e.configuration_id = c.id " +
    "AND e.tenant_id = c.tenant_id AND e.site_id = c.site_id ORDER BY e.rowid DESC LIMIT 1) AS lifecycle_status " +
    "FROM tenant_site_configurations c WHERE c.tenant_id = ? AND c.site_id = ? " +
    "AND (SELECT e.event_type FROM tenant_site_configuration_events e WHERE e.configuration_id = c.id " +
    "AND e.tenant_id = c.tenant_id AND e.site_id = c.site_id ORDER BY e.rowid DESC LIMIT 1) = 'approved_for_review' " +
    "ORDER BY CAST(substr(c.configuration_version, 2) AS INTEGER) DESC LIMIT 1"
  ).bind(tenantId, siteId));
  if (records.length === 0) {
    return { data: { status: "not_available", reason: "no_approved_configuration",
      tenant_id: tenantId, site_id: siteId }, status: 200 };
  }
  const row = records[0];
  return { data: {
    status: "approved_configuration_available",
    configuration: {
      id: row.id, tenant_id: row.tenant_id, site_id: row.site_id,
      configuration_version: row.configuration_version, schema_id: row.schema_id,
      configuration: JSON.parse(row.configuration_json), content_sha256: row.content_sha256,
      created_by_subject: row.created_by_subject, request_id: row.request_id,
      created_at: row.created_at, lifecycle_status: row.lifecycle_status,
    },
    operational_decision: "not_authorized",
  }, status: 200 };
}

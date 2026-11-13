const ROLE_ACTIONS = Object.freeze({
  tenant_owner: new Set(["read", "create", "update", "delete", "ingest", "manage_members"]),
  tenant_admin: new Set(["read", "create", "update", "delete", "ingest"]),
  operator: new Set(["read", "ingest"]),
  analyst: new Set(["read"]),
  viewer: new Set(["read"]),
  service: new Set(["read", "ingest"]),
});

function exactString(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

// Pure decision helper. Inputs must come from the verified identity context and
// exact D1 membership/grant queries; caller-supplied tenant/subject is not trusted.
export function authorizeConfigurationWrite({
  principalSubject, tenantId, siteId, membershipRows, grantRows, action = "create",
}) {
  if (!exactString(principalSubject, 200) || !exactString(tenantId, 120) ||
      !exactString(siteId, 160) || action !== "create" ||
      !Array.isArray(membershipRows) || membershipRows.length !== 1 ||
      !Array.isArray(grantRows)) return Object.freeze({ allowed: false, reason: "authorization_denied" });
  const membership = membershipRows[0];
  if (!membership || membership.subject !== principalSubject ||
      membership.tenant_id !== tenantId || membership.membership_status !== "active" ||
      membership.tenant_status !== "active" || !ROLE_ACTIONS[membership.role]?.has(action)) {
    return Object.freeze({ allowed: false, reason: "authorization_denied" });
  }
  const exactGrant = grantRows.filter(grant =>
    grant && grant.subject === principalSubject && grant.tenant_id === tenantId &&
    grant.resource_type === "site" && grant.resource_id === siteId && grant.action === action
  );
  if (exactGrant.length !== 1) return Object.freeze({ allowed: false, reason: "authorization_denied" });
  return Object.freeze({ allowed: true, reason: "authorized" });
}

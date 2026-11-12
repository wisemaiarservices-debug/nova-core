-- Isolated fixture records for local D1 HTTP integration only.
INSERT INTO tenants (id, display_name, status) VALUES
  ('tenant-http-a', 'CI Tenant A', 'active'),
  ('tenant-http-b', 'CI Tenant B', 'active');

INSERT INTO tenant_memberships (id, tenant_id, subject, role, status) VALUES
  ('membership-http-a', 'tenant-http-a', 'ci-human-subject', 'tenant_owner', 'active');

INSERT INTO tenant_resource_grants (id, tenant_id, subject, resource_type, resource_id, action) VALUES
  ('grant-http-a-site', 'tenant-http-a', 'ci-human-subject', 'site', 'site-http-a', 'read');

INSERT INTO sites (id, tenant_id, name, status) VALUES
  ('site-http-a', 'tenant-http-a', 'CI Site A', 'active'),
  ('site-http-b', 'tenant-http-b', 'CI Site B', 'active');

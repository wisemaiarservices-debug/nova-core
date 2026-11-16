-- Recheck exact site-read grants at the database mutation boundary.
-- Route-level authorization remains useful for early rejection, but is not the
-- authority boundary: grants can be revoked between the route check and D1 write.

DROP TRIGGER tenant_asset_event_insert_guard;
CREATE TRIGGER tenant_asset_event_insert_guard
BEFORE INSERT ON tenant_asset_events
WHEN NOT EXISTS (
  SELECT 1 FROM tenants t
  JOIN sites s ON s.id = NEW.site_id AND s.tenant_id = NEW.tenant_id AND s.status = 'active'
  JOIN assets a ON a.id = NEW.asset_id AND a.tenant_id = NEW.tenant_id
    AND a.site_id = NEW.site_id AND a.status = 'unconfigured'
  JOIN tenant_memberships m ON m.tenant_id = NEW.tenant_id
    AND m.subject = NEW.actor_subject AND m.role = 'tenant_owner' AND m.status = 'active'
  JOIN tenant_resource_grants g ON g.tenant_id = NEW.tenant_id
    AND g.subject = NEW.actor_subject AND g.resource_type = 'site'
    AND g.resource_id = NEW.site_id AND g.action = 'read'
  WHERE t.id = NEW.tenant_id AND t.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'asset creation event requires active owner, exact site grant and tenant site asset');
END;

DROP TRIGGER tenant_asset_creation_request_insert_guard;
CREATE TRIGGER tenant_asset_creation_request_insert_guard
BEFORE INSERT ON tenant_asset_creation_requests
WHEN NOT EXISTS (
  SELECT 1 FROM tenants t
  JOIN sites s ON s.id = NEW.site_id AND s.tenant_id = NEW.tenant_id AND s.status = 'active'
  JOIN tenant_memberships m ON m.tenant_id = NEW.tenant_id
    AND m.subject = NEW.actor_subject AND m.role = 'tenant_owner' AND m.status = 'active'
  JOIN tenant_resource_grants g ON g.tenant_id = NEW.tenant_id
    AND g.subject = NEW.actor_subject AND g.resource_type = 'site'
    AND g.resource_id = NEW.site_id AND g.action = 'read'
  JOIN tenant_asset_events e ON e.tenant_id = NEW.tenant_id
    AND e.site_id = NEW.site_id AND e.asset_id = NEW.asset_id
    AND e.actor_subject = NEW.actor_subject AND e.request_id = NEW.request_id
  WHERE t.id = NEW.tenant_id AND t.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'asset creation idempotency record requires active owner, site grant and exact asset event');
END;

DROP TRIGGER tenant_source_reviewer_assignment_guard;
CREATE TRIGGER tenant_source_reviewer_assignment_guard
BEFORE INSERT ON tenant_source_reviewers
WHEN NOT EXISTS (
  SELECT 1 FROM tenants t JOIN sites s ON s.tenant_id=t.id
  WHERE t.id=NEW.tenant_id AND t.status='active' AND s.id=NEW.site_id AND s.status='active'
) OR NOT EXISTS (
  SELECT 1 FROM tenant_memberships m
  WHERE m.tenant_id=NEW.tenant_id AND m.subject=NEW.reviewer_subject AND m.status='active'
) OR NEW.reviewer_subject=NEW.assigned_by_subject OR NOT EXISTS (
  SELECT 1 FROM tenant_memberships a
  WHERE a.tenant_id=NEW.tenant_id AND a.subject=NEW.assigned_by_subject
    AND a.status='active' AND a.role IN ('tenant_owner','tenant_admin')
) OR NOT EXISTS (
  SELECT 1 FROM tenant_resource_grants g
  WHERE g.tenant_id=NEW.tenant_id AND g.subject=NEW.assigned_by_subject
    AND g.resource_type='site' AND g.resource_id=NEW.site_id AND g.action='read'
)
BEGIN SELECT RAISE(ABORT, 'source reviewer assignment requires active tenant admin, member and exact site read grant'); END;

DROP TRIGGER tenant_source_reviewer_event_guard;
CREATE TRIGGER tenant_source_reviewer_event_guard
BEFORE INSERT ON tenant_source_reviewer_events
WHEN NOT EXISTS (
  SELECT 1 FROM tenant_memberships m JOIN tenants t ON t.id=m.tenant_id AND t.status='active'
  WHERE m.tenant_id=NEW.tenant_id AND m.subject=NEW.actor_subject
    AND m.status='active' AND m.role IN ('tenant_owner','tenant_admin')
) OR NOT EXISTS (
  SELECT 1 FROM tenant_resource_grants g
  WHERE g.tenant_id=NEW.tenant_id AND g.subject=NEW.actor_subject
    AND g.resource_type='site' AND g.resource_id=NEW.site_id AND g.action='read'
) OR (NEW.event_type='assigned' AND NOT EXISTS (
  SELECT 1 FROM tenant_source_reviewers r WHERE r.tenant_id=NEW.tenant_id
    AND r.site_id=NEW.site_id AND r.reviewer_subject=NEW.reviewer_subject
    AND r.status='active' AND r.assigned_by_subject=NEW.actor_subject
)) OR (NEW.event_type='revoked' AND NOT EXISTS (
  SELECT 1 FROM tenant_source_reviewers r WHERE r.tenant_id=NEW.tenant_id
    AND r.site_id=NEW.site_id AND r.reviewer_subject=NEW.reviewer_subject
    AND r.status='revoked'
))
BEGIN SELECT RAISE(ABORT, 'source reviewer event requires current tenant admin authority and exact site read grant'); END;

DROP TRIGGER tenant_source_event_guard;
CREATE TRIGGER tenant_source_event_guard
BEFORE INSERT ON tenant_source_events
WHEN NOT EXISTS (
  SELECT 1 FROM sources src JOIN tenants t ON t.id=src.tenant_id AND t.status='active'
  JOIN sites s ON s.id=NEW.site_id AND s.tenant_id=NEW.tenant_id AND s.status='active'
  WHERE src.id=NEW.source_id AND src.tenant_id=NEW.tenant_id AND src.site_id=NEW.site_id
) OR NOT EXISTS (
  SELECT 1 FROM tenant_resource_grants g
  WHERE g.tenant_id=NEW.tenant_id AND g.subject=NEW.actor_subject
    AND g.resource_type='site' AND g.resource_id=NEW.site_id AND g.action='read'
) OR (
  NEW.event_type='registered' AND NOT EXISTS (
    SELECT 1 FROM tenant_memberships m WHERE m.tenant_id=NEW.tenant_id
      AND m.subject=NEW.actor_subject AND m.status='active'
      AND m.role IN ('tenant_owner','tenant_admin')
  )
) OR (
  NEW.event_type IN ('verified','rejected','revoked') AND NOT EXISTS (
    SELECT 1 FROM tenant_source_reviewers r
    JOIN tenant_memberships m ON m.tenant_id=r.tenant_id
      AND m.subject=r.reviewer_subject AND m.status='active'
    WHERE r.tenant_id=NEW.tenant_id AND r.site_id=NEW.site_id
      AND r.reviewer_subject=NEW.actor_subject AND r.status='active'
      AND NEW.actor_subject<>(SELECT registered_by_subject FROM sources WHERE id=NEW.source_id)
  )
) OR (
  (NEW.event_type IN ('verified','rejected') AND EXISTS (
    SELECT 1 FROM tenant_source_events e WHERE e.tenant_id=NEW.tenant_id
      AND e.source_id=NEW.source_id AND e.event_type IN ('verified','rejected','revoked')
  ))
  OR (NEW.event_type='revoked' AND NOT EXISTS (
    SELECT 1 FROM tenant_source_events e WHERE e.tenant_id=NEW.tenant_id
      AND e.source_id=NEW.source_id AND e.event_type='verified'
      AND e.id=(SELECT e2.id FROM tenant_source_events e2
        WHERE e2.tenant_id=NEW.tenant_id AND e2.source_id=NEW.source_id
        ORDER BY e2.occurred_at DESC,e2.rowid DESC LIMIT 1)
  ))
)
BEGIN SELECT RAISE(ABORT, 'source lifecycle event violates scope, authority, site grant or transition'); END;

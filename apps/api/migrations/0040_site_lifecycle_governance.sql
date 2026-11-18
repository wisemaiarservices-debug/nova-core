-- Governed tenant site deactivation/reactivation with an immutable audit ledger.
-- Only active <-> inactive is supported. Archived and unconfigured are not aliases.

CREATE TABLE tenant_site_lifecycle_events (
  id TEXT PRIMARY KEY CHECK(length(trim(id)) BETWEEN 1 AND 160),
  tenant_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  actor_subject TEXT NOT NULL CHECK(length(trim(actor_subject)) BETWEEN 1 AND 200),
  event_type TEXT NOT NULL CHECK(event_type IN ('deactivated','reactivated')),
  previous_status TEXT NOT NULL CHECK(previous_status IN ('active','inactive')),
  new_status TEXT NOT NULL CHECK(new_status IN ('active','inactive')),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000),
  idempotency_key TEXT NOT NULL CHECK(length(trim(idempotency_key)) BETWEEN 1 AND 160),
  request_id TEXT NOT NULL UNIQUE CHECK(length(trim(request_id)) BETWEEN 1 AND 160),
  occurred_at TEXT NOT NULL,
  UNIQUE(tenant_id, actor_subject, site_id, idempotency_key),
  UNIQUE(id, tenant_id, site_id, actor_subject, previous_status, new_status),
  FOREIGN KEY(tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  FOREIGN KEY(site_id) REFERENCES sites(id) ON DELETE RESTRICT,
  CHECK((event_type='deactivated' AND previous_status='active' AND new_status='inactive')
     OR (event_type='reactivated' AND previous_status='inactive' AND new_status='active'))
);

CREATE INDEX idx_tenant_site_lifecycle_timeline
 ON tenant_site_lifecycle_events(tenant_id,site_id,occurred_at DESC,id);

-- A one-to-one application row consumes each event as the authorization for
-- exactly one status transition. It prevents a historic event being replayed
-- as authority for a later direct UPDATE.
CREATE TABLE tenant_site_lifecycle_applications (
  event_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  actor_subject TEXT NOT NULL,
  previous_status TEXT NOT NULL,
  new_status TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  FOREIGN KEY(event_id,tenant_id,site_id,actor_subject,previous_status,new_status)
    REFERENCES tenant_site_lifecycle_events(id,tenant_id,site_id,actor_subject,previous_status,new_status)
    ON DELETE RESTRICT
);

CREATE TRIGGER tenant_site_lifecycle_event_insert_guard
BEFORE INSERT ON tenant_site_lifecycle_events
WHEN NOT EXISTS (
  SELECT 1
  FROM sites site
  JOIN tenants tenant ON tenant.id=site.tenant_id AND tenant.status='active'
  JOIN tenant_memberships membership ON membership.tenant_id=site.tenant_id
    AND membership.subject=NEW.actor_subject AND membership.status='active'
    AND membership.role IN ('tenant_owner','tenant_admin')
  JOIN tenant_resource_grants grant_read ON grant_read.tenant_id=site.tenant_id
    AND grant_read.subject=NEW.actor_subject AND grant_read.resource_type='site'
    AND grant_read.resource_id=site.id AND grant_read.action='read'
  WHERE site.id=NEW.site_id AND site.tenant_id=NEW.tenant_id
    AND site.status=NEW.previous_status
)
BEGIN
 SELECT RAISE(ABORT,'site lifecycle event requires active tenant, authorized admin and exact current site status');
END;

CREATE TRIGGER tenant_site_lifecycle_apply_event
AFTER INSERT ON tenant_site_lifecycle_events
BEGIN
 UPDATE sites
 SET status=NEW.new_status,
     updated_at=NEW.occurred_at
 WHERE id=NEW.site_id AND tenant_id=NEW.tenant_id
   AND status=NEW.previous_status;
 SELECT CASE WHEN NOT EXISTS (
   SELECT 1 FROM tenant_site_lifecycle_applications application
   WHERE application.event_id=NEW.id AND application.tenant_id=NEW.tenant_id
     AND application.site_id=NEW.site_id AND application.actor_subject=NEW.actor_subject
     AND application.previous_status=NEW.previous_status
     AND application.new_status=NEW.new_status
 ) THEN RAISE(ABORT,'site lifecycle event was not applied exactly once') END;
END;

CREATE TRIGGER tenant_sites_status_requires_lifecycle_event
BEFORE UPDATE OF status ON sites
WHEN NEW.status IS NOT OLD.status
 AND NOT EXISTS (
   SELECT 1 FROM tenant_site_lifecycle_events event
   WHERE event.tenant_id=OLD.tenant_id AND event.site_id=OLD.id
     AND event.previous_status=OLD.status AND event.new_status=NEW.status
     AND NOT EXISTS (
       SELECT 1 FROM tenant_site_lifecycle_applications application
       WHERE application.event_id=event.id
     )
 )
BEGIN
 SELECT RAISE(ABORT,'site status change requires an unused governed lifecycle event');
END;

CREATE TRIGGER tenant_site_lifecycle_application_insert_guard
BEFORE INSERT ON tenant_site_lifecycle_applications
WHEN NOT EXISTS (
 SELECT 1 FROM tenant_site_lifecycle_events event
 JOIN sites site ON site.id=event.site_id AND site.tenant_id=event.tenant_id
 WHERE event.id=NEW.event_id AND event.tenant_id=NEW.tenant_id
   AND event.site_id=NEW.site_id AND event.actor_subject=NEW.actor_subject
   AND event.previous_status=NEW.previous_status AND event.new_status=NEW.new_status
   AND site.status=NEW.new_status
)
BEGIN
 SELECT RAISE(ABORT,'site lifecycle application must consume an applied event');
END;

CREATE TRIGGER tenant_site_lifecycle_record_application
AFTER UPDATE OF status ON sites
WHEN NEW.status IS NOT OLD.status
BEGIN
 INSERT INTO tenant_site_lifecycle_applications
  (event_id,tenant_id,site_id,actor_subject,previous_status,new_status,applied_at)
 SELECT event.id,event.tenant_id,event.site_id,event.actor_subject,
        event.previous_status,event.new_status,event.occurred_at
 FROM tenant_site_lifecycle_events event
 WHERE event.tenant_id=OLD.tenant_id AND event.site_id=OLD.id
   AND event.previous_status=OLD.status AND event.new_status=NEW.status
   AND NOT EXISTS (
     SELECT 1 FROM tenant_site_lifecycle_applications prior
     WHERE prior.event_id=event.id
   )
 ORDER BY event.rowid DESC LIMIT 1;
END;

CREATE TRIGGER tenant_site_lifecycle_events_no_update
BEFORE UPDATE ON tenant_site_lifecycle_events
BEGIN
 SELECT RAISE(ABORT,'site lifecycle events are append-only');
END;
CREATE TRIGGER tenant_site_lifecycle_events_no_delete
BEFORE DELETE ON tenant_site_lifecycle_events
BEGIN
 SELECT RAISE(ABORT,'site lifecycle events are append-only');
END;
CREATE TRIGGER tenant_site_lifecycle_applications_no_update
BEFORE UPDATE ON tenant_site_lifecycle_applications
BEGIN
 SELECT RAISE(ABORT,'site lifecycle applications are append-only');
END;
CREATE TRIGGER tenant_site_lifecycle_applications_no_delete
BEFORE DELETE ON tenant_site_lifecycle_applications
BEGIN
 SELECT RAISE(ABORT,'site lifecycle applications are append-only');
END;

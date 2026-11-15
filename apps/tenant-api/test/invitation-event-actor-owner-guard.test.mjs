import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const invitationMigration = readFileSync(fileURLToPath(new URL("../../api/migrations/0018_tenant_membership_invitations.sql", import.meta.url)), "utf8");
const actorGuardMigration = readFileSync(fileURLToPath(new URL("../../api/migrations/0033_invitation_event_actor_owner_guard.sql", import.meta.url)), "utf8");

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE tenant_memberships (
      tenant_id TEXT NOT NULL, subject TEXT NOT NULL, role TEXT NOT NULL,
      status TEXT NOT NULL, PRIMARY KEY (tenant_id, subject)
    );
    INSERT INTO tenants VALUES ('tenant-1', 'active');
    INSERT INTO tenant_memberships VALUES ('tenant-1', 'owner-1', 'tenant_owner', 'active');
    INSERT INTO tenant_memberships VALUES ('tenant-1', 'operator-1', 'operator', 'active');
  `);
  db.exec(invitationMigration);
  db.exec(actorGuardMigration);
  return db;
}

function invitation(db, id, status, acceptedBy = null) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO tenant_membership_invitations
      (id, tenant_id, role, status, token_sha256, created_by_subject, accepted_by_subject,
       reason, request_id, expires_at, accepted_at, revoked_at)
    VALUES (?, 'tenant-1', 'analyst', ?, ?, 'owner-1', ?, 'test reason', ?, ?, ?, ?)
  `).run(
    id, status, id.padStart(64, "0").slice(-64), acceptedBy, `request-${id}`,
    new Date(Date.now() + 86400000).toISOString(),
    status === "accepted" ? now : null,
    status === "revoked" ? now : null
  );
}

function event(db, id, invitationId, type, actor, subject = null) {
  db.prepare(`
    INSERT INTO tenant_membership_invitation_events
      (id, tenant_id, invitation_id, event_type, actor_subject, subject, reason, request_id)
    VALUES (?, 'tenant-1', ?, ?, ?, ?, 'test event', ?)
  `).run(id, invitationId, type, actor, subject, `event-${id}`);
}

test("invitation creation event requires an active tenant owner", (t) => {
  const db = fixture(t);
  invitation(db, "invite-create", "pending");
  assert.doesNotThrow(() => event(db, "event-owner-create", "invite-create", "created", "owner-1"));
  assert.throws(
    () => event(db, "event-operator-create", "invite-create", "created", "operator-1"),
    /membership invitation event actor must be active tenant owner/
  );
});

test("invitation revocation event requires an active tenant owner", (t) => {
  const db = fixture(t);
  invitation(db, "invite-revoke", "revoked");
  assert.doesNotThrow(() => event(db, "event-owner-revoke", "invite-revoke", "revoked", "owner-1"));
  assert.throws(
    () => event(db, "event-operator-revoke", "invite-revoke", "revoked", "operator-1"),
    /membership invitation event actor must be active tenant owner/
  );
});

test("invitation owner events are rejected for inactive tenant or suspended owner", (t) => {
  const db = fixture(t);
  invitation(db, "invite-inactive", "pending");
  db.prepare("UPDATE tenants SET status = 'suspended' WHERE id = 'tenant-1'").run();
  assert.throws(
    () => event(db, "event-inactive-tenant", "invite-inactive", "created", "owner-1"),
    /membership invitation event actor must be active tenant owner/
  );
  db.prepare("UPDATE tenants SET status = 'active' WHERE id = 'tenant-1'").run();
  db.prepare("UPDATE tenant_memberships SET status = 'suspended' WHERE tenant_id = 'tenant-1' AND subject = 'owner-1'").run();
  assert.throws(
    () => event(db, "event-suspended-owner", "invite-inactive", "created", "owner-1"),
    /membership invitation event actor must be active tenant owner/
  );
});

test("acceptance and expiry events retain their distinct non-owner actor semantics", (t) => {
  const db = fixture(t);
  invitation(db, "invite-accepted", "accepted", "invitee-1");
  invitation(db, "invite-expired", "expired");
  db.prepare("INSERT INTO tenant_memberships VALUES ('tenant-1', 'invitee-1', 'analyst', 'active')").run();
  assert.doesNotThrow(() => event(db, "event-accepted", "invite-accepted", "accepted", "invitee-1", "invitee-1"));
  assert.doesNotThrow(() => event(db, "event-expired", "invite-expired", "expired", "external-holder-1"));
});

const validText = (value, max) => typeof value === "string" &&
  value.length > 0 && value.length <= max && value.trim() === value &&
  !/[\u0000-\u001f\u007f]/.test(value);
const validId = (value, max = 160) => validText(value, max) &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
const onlyKeys = (value, allowed) => value !== null && typeof value === "object" &&
  !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));

async function rows(statement) {
  const result = await statement.all();
  if (!result || !Array.isArray(result.results)) throw new Error("site_lifecycle_command_storage_invalid_result");
  return result.results;
}
async function one(statement) {
  const found = await rows(statement);
  if (found.length > 1) throw new Error("site_lifecycle_command_storage_conflict");
  return found[0] ?? null;
}
async function sha256(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}
function publicCommand(row, events = []) {
  return {
    id: row.id, tenant_id: row.tenant_id, site_id: row.site_id,
    action: row.action, expected_status: row.expected_status,
    status: row.status, event_id: row.event_id ?? null,
    rejection_code: row.rejection_code ?? null,
    created_at: row.created_at, updated_at: row.updated_at, events,
  };
}
async function authorize(db, tenant, site, actor) {
  const row = await one(db.prepare(
    `SELECT site.status AS site_status
       FROM sites site
       JOIN tenants tenant ON tenant.id=site.tenant_id AND tenant.status='active'
       JOIN tenant_memberships membership ON membership.tenant_id=site.tenant_id
         AND membership.subject=? AND membership.status='active'
         AND membership.role IN ('tenant_owner','tenant_admin')
       JOIN tenant_resource_grants grant_read ON grant_read.tenant_id=site.tenant_id
         AND grant_read.subject=membership.subject AND grant_read.resource_type='site'
         AND grant_read.resource_id=site.id AND grant_read.action='read'
      WHERE site.tenant_id=? AND site.id=? LIMIT 2`
  ).bind(actor, tenant, site));
  return row;
}
async function commandById(db, tenant, site, id) {
  return await one(db.prepare(
    `SELECT id,tenant_id,site_id,actor_subject,action,expected_status,reason,
            request_digest,status,event_id,rejection_code,resolved_by_subject,
            idempotency_key,created_at,updated_at
       FROM tenant_site_lifecycle_commands
      WHERE tenant_id=? AND site_id=? AND id=? LIMIT 2`
  ).bind(tenant, site, id));
}
async function commandEvents(db, commandId) {
  return await rows(db.prepare(
    `SELECT event_type,occurred_at,rejection_code,performed_by_subject
       FROM tenant_site_lifecycle_command_events
      WHERE command_id=? ORDER BY occurred_at,CASE event_type WHEN 'prepared' THEN 0 ELSE 1 END,id LIMIT 20`
  ).bind(commandId));
}
async function responseFor(db, command, status = 200) {
  return { data: publicCommand(command, await commandEvents(db, command.id)), status };
}

export function matchTenantSiteLifecycleCommandRoute(url, method) {
  const parsed = url instanceof URL ? url : new URL(url);
  if (parsed.search || parsed.hash) return null;
  let match = parsed.pathname.match(new RegExp("^/internal/v1/tenants/([^/]+)/sites/([^/]+)/lifecycle-commands$"));
  if (match && (method === "POST" || method === "GET") && validId(match[1], 120) && validId(match[2])) {
    return { tenant: match[1], site: match[2], action: method === "POST" ? "prepare" : "recover" };
  }
  match = parsed.pathname.match(new RegExp("^/internal/v1/tenants/([^/]+)/sites/([^/]+)/lifecycle-commands/([^/]+)(?:/(apply|reject))?$"));
  if (!match || !validId(match[1], 120) || !validId(match[2]) || !validId(match[3], 151)) return null;
  const action = match[4] ?? "read";
  if ((action === "read" && method !== "GET") || (action !== "read" && method !== "POST")) return null;
  return { tenant: match[1], site: match[2], commandId: match[3], action };
}

export async function prepareTenantSiteLifecycleCommand(db, {
  tenant, site, actorSubject, idempotencyKey, requestId, body, now,
}) {
  if (!validId(tenant, 120) || !validId(site) || !validText(actorSubject, 200) ||
      !validId(idempotencyKey) || !validId(requestId, 80) ||
      !onlyKeys(body, ["action", "reason"]) ||
      !["deactivate", "reactivate"].includes(body.action) ||
      !validText(body.reason, 2000) || typeof now !== "string" ||
      !Number.isFinite(Date.parse(now)) || new Date(now).toISOString() !== now) {
    return { error: "site_lifecycle_command_request_invalid", status: 400 };
  }
  const authorized = await authorize(db, tenant, site, actorSubject);
  if (!authorized) return { error: "site_not_found", status: 404 };
  const expected = body.action === "deactivate" ? "active" : "inactive";
  const digest = await sha256(JSON.stringify([
    "nova-core-site-lifecycle-command-v1", tenant, site, actorSubject,
    body.action, expected, body.reason,
  ]));
  const recoverByKey = async () => {
    const existing = await one(db.prepare(
      `SELECT id,tenant_id,site_id,actor_subject,action,expected_status,reason,
              request_digest,status,event_id,rejection_code,resolved_by_subject,
              idempotency_key,created_at,updated_at
         FROM tenant_site_lifecycle_commands
        WHERE tenant_id=? AND site_id=? AND actor_subject=? AND idempotency_key=? LIMIT 2`
    ).bind(tenant, site, actorSubject, idempotencyKey));
    if (!existing) return null;
    if (existing.request_digest !== digest) return { error: "site_lifecycle_idempotency_conflict", status: 409 };
    return await responseFor(db, existing);
  };
  const replay = await recoverByKey();
  if (replay) return replay;
  if (authorized.site_status !== expected) return { error: "site_lifecycle_state_conflict", status: 409 };
  const pending = await one(db.prepare(
    "SELECT id FROM tenant_site_lifecycle_commands WHERE tenant_id=? AND site_id=? AND status='pending' LIMIT 2"
  ).bind(tenant, site));
  if (pending) return { error: "site_lifecycle_command_pending", status: 409 };
  const id = crypto.randomUUID();
  try {
    const inserted = await db.prepare(
      `INSERT INTO tenant_site_lifecycle_commands
        (id,tenant_id,site_id,actor_subject,action,expected_status,reason,
         request_digest,status,created_at,updated_at,idempotency_key)
       VALUES(?,?,?,?,?,?,?,?,'pending',?,?,?)`
    ).bind(id, tenant, site, actorSubject, body.action, expected, body.reason,
      digest, now, now, idempotencyKey).run();
    if (!Number.isInteger(inserted?.meta?.changes) || inserted.meta.changes !== 1) {
      const raced = await recoverByKey();
      return raced ?? { error: "site_lifecycle_command_conflict", status: 409 };
    }
    const saved = await commandById(db, tenant, site, id);
    if (!saved) throw new Error("site_lifecycle_command_missing_after_prepare");
    return await responseFor(db, saved, 201);
  } catch {
    const raced = await recoverByKey();
    if (raced) return raced;
    return { error: "site_lifecycle_command_conflict", status: 409 };
  }
}

export async function recoverTenantSiteLifecycleCommand(db, { tenant, site, actorSubject }) {
  if (!validId(tenant, 120) || !validId(site) || !validText(actorSubject, 200)) {
    return { error: "site_lifecycle_command_request_invalid", status: 400 };
  }
  if (!(await authorize(db, tenant, site, actorSubject))) return { error: "site_not_found", status: 404 };
  const command = await one(db.prepare(
    `SELECT id,tenant_id,site_id,actor_subject,action,expected_status,reason,
            request_digest,status,event_id,rejection_code,resolved_by_subject,
            idempotency_key,created_at,updated_at
       FROM tenant_site_lifecycle_commands
      WHERE tenant_id=? AND site_id=? AND (status='pending' OR actor_subject=?)
      ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END,updated_at DESC,id DESC LIMIT 1`
  ).bind(tenant, site, actorSubject));
  return command ? await responseFor(db, command) : { data: null, status: 200 };
}

export async function readTenantSiteLifecycleCommand(db, { tenant, site, actorSubject, commandId }) {
  if (!validId(tenant, 120) || !validId(site) || !validText(actorSubject, 200) ||
      !validId(commandId, 151)) return { error: "site_lifecycle_command_request_invalid", status: 400 };
  if (!(await authorize(db, tenant, site, actorSubject))) return { error: "site_not_found", status: 404 };
  const command = await commandById(db, tenant, site, commandId);
  if (!command) return { error: "site_lifecycle_command_not_found", status: 404 };
  return await responseFor(db, command);
}

export async function applyTenantSiteLifecycleCommand(db, {
  tenant, site, actorSubject, commandId, requestId, now,
}) {
  if (!validId(tenant, 120) || !validId(site) || !validText(actorSubject, 200) ||
      !validId(commandId, 151) || !validId(requestId, 80) ||
      typeof now !== "string" || !Number.isFinite(Date.parse(now)) ||
      new Date(now).toISOString() !== now) {
    return { error: "site_lifecycle_command_request_invalid", status: 400 };
  }
  const authorized = await authorize(db, tenant, site, actorSubject);
  if (!authorized) return { error: "site_not_found", status: 404 };
  const command = await commandById(db, tenant, site, commandId);
  if (!command) return { error: "site_lifecycle_command_not_found", status: 404 };
  if (command.actor_subject !== actorSubject) return { error: "site_lifecycle_command_not_found", status: 404 };
  if (command.status !== "pending") return await responseFor(db, command);
  if (authorized.site_status !== command.expected_status) {
    return { error: "site_lifecycle_command_stale", status: 409 };
  }
  const previous = command.expected_status;
  const next = command.action === "deactivate" ? "inactive" : "active";
  const eventType = command.action === "deactivate" ? "deactivated" : "reactivated";
  try {
    const result = await db.prepare(
      `INSERT INTO tenant_site_lifecycle_events
        (id,tenant_id,site_id,actor_subject,event_type,previous_status,new_status,
         reason,idempotency_key,request_digest,request_id,occurred_at,command_id)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(crypto.randomUUID(), tenant, site, actorSubject, eventType, previous,
      next, command.reason, command.idempotency_key, command.request_digest,
      requestId, now, command.id).run();
    if (!Number.isInteger(result?.meta?.changes) || result.meta.changes !== 1) {
      const latest = await commandById(db, tenant, site, commandId);
      if (latest?.status === "applied") return await responseFor(db, latest);
      return { error: "site_lifecycle_command_conflict", status: 409 };
    }
    const applied = await commandById(db, tenant, site, commandId);
    if (!applied || applied.status !== "applied" || !applied.event_id) {
      throw new Error("site_lifecycle_command_not_atomically_applied");
    }
    return await responseFor(db, applied, 200);
  } catch {
    const latest = await commandById(db, tenant, site, commandId);
    if (latest?.status === "applied") return await responseFor(db, latest);
    return { error: "site_lifecycle_command_conflict", status: 409 };
  }
}

export async function rejectTenantSiteLifecycleCommand(db, {
  tenant, site, actorSubject, commandId, rejectionCode, now,
}) {
  if (!validId(tenant, 120) || !validId(site) || !validText(actorSubject, 200) ||
      !validId(commandId, 151) || !validId(rejectionCode, 120) ||
      typeof now !== "string" || !Number.isFinite(Date.parse(now)) ||
      new Date(now).toISOString() !== now) {
    return { error: "site_lifecycle_command_request_invalid", status: 400 };
  }
  if (!(await authorize(db, tenant, site, actorSubject))) return { error: "site_not_found", status: 404 };
  const command = await commandById(db, tenant, site, commandId);
  if (!command) return { error: "site_lifecycle_command_not_found", status: 404 };
  if (command.status !== "pending") return await responseFor(db, command);
  try {
    const result = await db.prepare(
      `UPDATE tenant_site_lifecycle_commands
          SET status='rejected',resolved_by_subject=?,rejection_code=?,updated_at=?
        WHERE id=? AND tenant_id=? AND site_id=? AND status='pending'`
    ).bind(actorSubject, rejectionCode, now, commandId, tenant, site).run();
    if (!Number.isInteger(result?.meta?.changes) || result.meta.changes !== 1) {
      const latest = await commandById(db, tenant, site, commandId);
      if (latest && latest.status !== "pending") return await responseFor(db, latest);
      return { error: "site_lifecycle_command_not_resolvable", status: 409 };
    }
    const rejected = await commandById(db, tenant, site, commandId);
    if (!rejected || rejected.status !== "rejected" || rejected.resolved_by_subject !== actorSubject) {
      throw new Error("site_lifecycle_command_rejection_not_recorded");
    }
    return await responseFor(db, rejected);
  } catch {
    const latest = await commandById(db, tenant, site, commandId);
    if (latest && latest.status !== "pending") return await responseFor(db, latest);
    return { error: "site_lifecycle_command_not_resolvable", status: 409 };
  }
}

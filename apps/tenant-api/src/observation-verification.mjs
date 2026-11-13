const validText = (value, max) => typeof value === "string" &&
  value.length > 0 && value.length <= max && value.trim() === value &&
  !/[\u0000-\u001f\u007f]/.test(value);
const validId = value => validText(value, 160) && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
const onlyKeys = (value, allowed) => value !== null && typeof value === "object" &&
  !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));

export async function assignObservationReviewer(db, tenant, actor, requestId, body, action) {
  const allowed = action === "assign"
    ? ["site_id", "reviewer_subject", "evidence_ref"]
    : ["site_id", "reviewer_subject", "evidence_ref", "reason"];
  if (!onlyKeys(body, allowed) || !validId(body.site_id) ||
      !validText(body.reviewer_subject, 200) || body.reviewer_subject === actor ||
      !validText(body.evidence_ref, 500) ||
      (action === "revoke" && !validText(body.reason, 2000))) {
    return { error: "observation_reviewer_request_invalid", status: 400 };
  }
  const site = await db.prepare(
    "SELECT id FROM sites WHERE tenant_id = ? AND id = ? LIMIT 1"
  ).bind(tenant, body.site_id).all();
  if (!Array.isArray(site?.results) || site.results.length !== 1) {
    return { error: "site_not_found", status: 404 };
  }
  const eventId = crypto.randomUUID();
  const first = action === "assign"
    ? db.prepare("INSERT INTO observation_reviewers (tenant_id, site_id, reviewer_subject, reviewer_role, status, assigned_by_subject, assignment_evidence_ref) VALUES (?, ?, ?, 'measurement_reviewer', 'active', ?, ?) ON CONFLICT(tenant_id, site_id, reviewer_subject, reviewer_role) DO NOTHING")
      .bind(tenant, body.site_id, body.reviewer_subject, actor, body.evidence_ref)
    : db.prepare("UPDATE observation_reviewers SET status = 'revoked' WHERE tenant_id = ? AND site_id = ? AND reviewer_subject = ? AND reviewer_role = 'measurement_reviewer' AND status = 'active'")
      .bind(tenant, body.site_id, body.reviewer_subject);
  const second = action === "assign"
    ? db.prepare("INSERT INTO observation_reviewer_events (id, tenant_id, site_id, reviewer_subject, reviewer_role, event_type, actor_subject, evidence_ref, request_id) SELECT ?, ?, ?, ?, 'measurement_reviewer', 'assigned', ?, ?, ? WHERE changes() = 1")
      .bind(eventId, tenant, body.site_id, body.reviewer_subject, actor, body.evidence_ref, requestId)
    : db.prepare("INSERT INTO observation_reviewer_events (id, tenant_id, site_id, reviewer_subject, reviewer_role, event_type, actor_subject, evidence_ref, reason, request_id) SELECT ?, ?, ?, ?, 'measurement_reviewer', 'revoked', ?, ?, ?, ? WHERE changes() = 1")
      .bind(eventId, tenant, body.site_id, body.reviewer_subject, actor, body.evidence_ref, body.reason, requestId);
  const results = await db.batch([first, second]);
  if (!Array.isArray(results) || results.length !== 2 ||
      results.some(result => !result?.meta || !Number.isInteger(result.meta.changes))) {
    throw new Error("observation_reviewer_batch_invalid");
  }
  if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1) {
    return { error: action === "assign" ? "observation_reviewer_assignment_conflict" : "active_observation_reviewer_not_found",
      status: action === "assign" ? 409 : 404 };
  }
  return { data: { tenant_id: tenant, site_id: body.site_id,
    reviewer_subject: body.reviewer_subject, reviewer_role: "measurement_reviewer",
    status: action === "assign" ? "active" : "revoked",
    event_type: action === "assign" ? "assigned" : "revoked" },
    status: action === "assign" ? 201 : 200 };
}

export async function reviewObservation(db, tenant, observationId, reviewerSubject, requestId, body) {
  if (!validId(observationId) || !onlyKeys(body, ["decision", "evidence_ref", "reason"]) ||
      !["verify", "reject", "revoke"].includes(body.decision) ||
      !validText(body.evidence_ref, 500) ||
      (body.reason !== undefined && !validText(body.reason, 2000)) ||
      (body.decision !== "verify" && !validText(body.reason, 2000))) {
    return { error: "observation_verification_request_invalid", status: 400 };
  }
  const observations = await db.prepare(
    "SELECT id, tenant_id, site_id, verification_status FROM observations WHERE tenant_id = ? AND id = ? LIMIT 2"
  ).bind(tenant, observationId).all();
  if (!Array.isArray(observations?.results) || observations.results.length !== 1) {
    return { error: "observation_not_found", status: 404 };
  }
  const observation = observations.results[0];
  const assignments = await db.prepare(
    "SELECT reviewer_subject, reviewer_role FROM observation_reviewers WHERE tenant_id = ? AND site_id = ? AND reviewer_subject = ? AND reviewer_role = 'measurement_reviewer' AND status = 'active' LIMIT 2"
  ).bind(tenant, observation.site_id, reviewerSubject).all();
  if (!Array.isArray(assignments?.results) || assignments.results.length !== 1 ||
      assignments.results[0].reviewer_subject !== reviewerSubject) {
    return { error: "observation_reviewer_assignment_not_found", status: 404 };
  }
  const ingestion = await db.prepare(
    "SELECT actor_type, actor_id FROM audit_events WHERE tenant_id = ? AND entity_type = 'observation' AND entity_id = ? AND action = 'observation.accepted' LIMIT 2"
  ).bind(tenant, observationId).all();
  if (!Array.isArray(ingestion?.results) || ingestion.results.length !== 1 ||
      ingestion.results[0].actor_type !== "service" || !validText(ingestion.results[0].actor_id, 200) ||
      ingestion.results[0].actor_id === reviewerSubject) {
    return { error: "observation_submitter_independence_not_established", status: 409 };
  }
  const transitions = {
    verify: { from: "unverified", to: "verified", event: "verified" },
    reject: { from: "unverified", to: "rejected", event: "rejected" },
    revoke: { from: "verified", to: "unverified", event: "revoked" },
  };
  const transition = transitions[body.decision];
  if (observation.verification_status !== transition.from) {
    return { error: "observation_verification_state_conflict", status: 409 };
  }
  const eventId = crypto.randomUUID();
  const event = db.prepare(
    "INSERT INTO observation_verification_events (id, tenant_id, site_id, observation_id, reviewer_subject, reviewer_role, event_type, evidence_ref, reason, request_id) VALUES (?, ?, ?, ?, ?, 'measurement_reviewer', ?, ?, ?, ?)"
  ).bind(eventId, tenant, observation.site_id, observationId, reviewerSubject,
    transition.event, body.evidence_ref, body.reason ?? null, requestId);
  const update = db.prepare(
    "UPDATE observations SET verification_status = ? WHERE id = ? AND tenant_id = ? AND site_id = ? AND verification_status = ? AND EXISTS (SELECT 1 FROM observation_verification_events e WHERE e.id = ? AND e.observation_id = observations.id AND e.tenant_id = observations.tenant_id AND e.site_id = observations.site_id AND e.event_type = ?)"
  ).bind(transition.to, observationId, tenant, observation.site_id, transition.from, eventId, transition.event);
  const results = await db.batch([event, update]);
  if (!Array.isArray(results) || results.length !== 2 ||
      results.some(result => !result?.meta || !Number.isInteger(result.meta.changes))) {
    throw new Error("observation_verification_batch_invalid");
  }
  if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1) {
    return { error: "observation_verification_state_conflict", status: 409 };
  }
  return { data: { observation_id: observationId, tenant_id: tenant,
    site_id: observation.site_id, verification_status: transition.to,
    event_type: transition.event, reviewer_subject: reviewerSubject },
    status: 201 };
}

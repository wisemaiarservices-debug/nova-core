const METRIC = /^[a-z][a-z0-9_.-]{0,119}$/;
const UNIT = /^[A-Za-z0-9%°µμ/._ -]{1,48}$/;

function validText(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}
function validId(value, max = 160) {
  return validText(value, max) && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}
function onlyKeys(value, allowed) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every(key => allowed.includes(key));
}
function instant(value) {
  if (!validText(value, 40)) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const hour = Number(match[4]), minute = Number(match[5]), second = Number(match[6]);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 ||
      calendar.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return null;
  if (match[8] !== "Z" && (Number(match[8].slice(1, 3)) > 23 || Number(match[8].slice(4, 6)) > 59)) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

export async function createSourceCalibration(db, tenantId, siteId, sourceId, actor, requestId, body) {
  if (!onlyKeys(body, ["instrument_serial", "metric", "unit", "calibration_method",
      "calibration_standard", "calibrated_at", "valid_until", "range_min", "range_max",
      "uncertainty", "evidence_ref"]) ||
      !validText(body.instrument_serial, 160) || !METRIC.test(body.metric ?? "") ||
      typeof body.unit !== "string" || !UNIT.test(body.unit) ||
      !["laboratory", "field_comparison", "manufacturer", "reference_instrument", "other"].includes(body.calibration_method) ||
      !validText(body.calibration_standard, 240) ||
      !validText(body.evidence_ref, 500) ||
      typeof body.range_min !== "number" || !Number.isFinite(body.range_min) ||
      typeof body.range_max !== "number" || !Number.isFinite(body.range_max) ||
      body.range_min > body.range_max ||
      typeof body.uncertainty !== "number" || !Number.isFinite(body.uncertainty) || body.uncertainty < 0) {
    return { error: "source_calibration_request_invalid", status: 400 };
  }
  const calibratedAt = instant(body.calibrated_at);
  const validUntil = instant(body.valid_until);
  if (!calibratedAt || !validUntil || validUntil <= calibratedAt ||
      Date.parse(calibratedAt) > Date.now() + 5 * 60 * 1000) {
    return { error: "source_calibration_dates_invalid", status: 400 };
  }
  const source = await db.prepare(
    "SELECT s.id, s.tenant_id, s.site_id, s.verification_status, st.status AS site_status FROM sources s JOIN sites st ON st.id = s.site_id AND st.tenant_id = s.tenant_id WHERE s.tenant_id = ? AND s.site_id = ? AND s.id = ? LIMIT 2"
  ).bind(tenantId, siteId, sourceId).all();
  if (!Array.isArray(source?.results) || source.results.length !== 1 ||
      source.results[0].id !== sourceId || source.results[0].tenant_id !== tenantId ||
      source.results[0].site_id !== siteId || source.results[0].site_status !== "active" || source.results[0].verification_status === "disabled") {
    return { error: "source_not_found_in_site_scope", status: 404 };
  }
  const reportRef = /^lab-report:([A-Za-z0-9][A-Za-z0-9._:-]{0,159})$/.exec(body.evidence_ref);
  if (reportRef) {
    const evidence = await db.prepare(
      "SELECT id FROM laboratory_report_evidence WHERE id = ? AND tenant_id = ? AND site_id = ? LIMIT 2"
    ).bind(reportRef[1], tenantId, siteId).all();
    if (!Array.isArray(evidence?.results) || evidence.results.length !== 1) {
      return { error: "calibration_evidence_reference_not_found", status: 404 };
    }
  }
  const id = crypto.randomUUID();
  const registrationEventId = crypto.randomUUID();
  const insert = db.prepare(
    "INSERT INTO source_calibrations (id, tenant_id, site_id, source_id, instrument_serial, metric, unit, calibration_method, calibration_standard, calibrated_at, valid_until, range_min, range_max, uncertainty, evidence_ref, created_by_subject) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, tenantId, siteId, sourceId, body.instrument_serial, body.metric, body.unit,
    body.calibration_method, body.calibration_standard, calibratedAt, validUntil,
    body.range_min, body.range_max, body.uncertainty, body.evidence_ref, actor);
  const event = db.prepare(
    "INSERT INTO source_calibration_events (id, calibration_id, tenant_id, site_id, source_id, event_type, actor_subject, evidence_ref, request_id) SELECT ?, ?, ?, ?, ?, 'registered', ?, ?, ? WHERE changes() = 1"
  ).bind(registrationEventId, id, tenantId, siteId, sourceId, actor, body.evidence_ref, requestId);
  const results = await db.batch([insert, event]);
  if (!Array.isArray(results) || results.length !== 2 ||
      results.some(item => !item?.meta || !Number.isInteger(item.meta.changes))) {
    throw new Error("source_calibration_batch_invalid");
  }
  if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1) {
    return { error: "source_calibration_registration_conflict", status: 409 };
  }
  return { data: { id, tenant_id: tenantId, site_id: siteId, source_id: sourceId,
    metric: body.metric, unit: body.unit, calibrated_at: calibratedAt,
    valid_until: validUntil, status: "unverified", evidence_ref: body.evidence_ref },
    status: 201 };
}

export async function reviewSourceCalibration(db, tenantId, siteId, sourceId,
  calibrationId, reviewerSubject, requestId, body) {
  if (!validId(calibrationId) ||
      !onlyKeys(body, ["decision", "evidence_ref", "reason"]) ||
      !["verify", "reject", "revoke"].includes(body.decision) ||
      !validText(body.evidence_ref, 500) ||
      (body.decision !== "verify" && !validText(body.reason, 2000)) ||
      (body.reason !== undefined && !validText(body.reason, 2000))) {
    return { error: "source_calibration_review_invalid", status: 400 };
  }
  const records = await db.prepare(
    "SELECT id, tenant_id, site_id, source_id, created_by_subject, status FROM source_calibrations WHERE tenant_id = ? AND site_id = ? AND source_id = ? AND id = ? LIMIT 2"
  ).bind(tenantId, siteId, sourceId, calibrationId).all();
  if (!Array.isArray(records?.results) || records.results.length !== 1) {
    return { error: "source_calibration_not_found", status: 404 };
  }
  const record = records.results[0];
  if (record.created_by_subject === reviewerSubject) {
    return { error: "source_calibration_self_review_denied", status: 403 };
  }
  const reviewers = await db.prepare(
    "SELECT r.reviewer_subject, m.status AS membership_status, t.status AS tenant_status FROM observation_reviewers r JOIN tenant_memberships m ON m.tenant_id = r.tenant_id AND m.subject = r.reviewer_subject JOIN tenants t ON t.id = r.tenant_id WHERE r.tenant_id = ? AND r.site_id = ? AND r.reviewer_subject = ? AND r.reviewer_role = 'measurement_reviewer' AND r.status = 'active' AND m.status = 'active' AND t.status = 'active' LIMIT 2"
  ).bind(tenantId, siteId, reviewerSubject).all();
  if (!Array.isArray(reviewers?.results) || reviewers.results.length !== 1 ||
      reviewers.results[0].reviewer_subject !== reviewerSubject) {
    return { error: "source_calibration_reviewer_not_assigned", status: 404 };
  }
  const transitions = {
    verify: { from: "unverified", to: "verified", event: "verified" },
    reject: { from: "unverified", to: "rejected", event: "rejected" },
    revoke: { from: "verified", to: "unverified", event: "revoked" },
  };
  const transition = transitions[body.decision];
  if (record.status !== transition.from) {
    return { error: "source_calibration_state_conflict", status: 409 };
  }
  const eventId = crypto.randomUUID();
  const event = db.prepare(
    "INSERT INTO source_calibration_events (id, calibration_id, tenant_id, site_id, source_id, event_type, actor_subject, reviewer_role, evidence_ref, reason, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'measurement_reviewer', ?, ?, ?)"
  ).bind(eventId, calibrationId, tenantId, siteId, sourceId, transition.event,
    reviewerSubject, body.evidence_ref, body.reason ?? null, requestId);
  const update = db.prepare(
    "UPDATE source_calibrations SET status = ? WHERE id = ? AND tenant_id = ? AND site_id = ? AND source_id = ? AND status = ? AND EXISTS (SELECT 1 FROM source_calibration_events e WHERE e.id = ? AND e.calibration_id = source_calibrations.id AND e.event_type = ?)"
  ).bind(transition.to, calibrationId, tenantId, siteId, sourceId,
    transition.from, eventId, transition.event);
  const results = await db.batch([event, update]);
  if (!Array.isArray(results) || results.length !== 2 ||
      results.some(item => !item?.meta || !Number.isInteger(item.meta.changes))) {
    throw new Error("source_calibration_review_batch_invalid");
  }
  if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1) {
    return { error: "source_calibration_state_conflict", status: 409 };
  }
  return { data: { id: calibrationId, status: transition.to,
    event_type: transition.event, reviewer_subject: reviewerSubject },
    status: 201 };
}

export async function assessObservationCalibration(db, tenantId, observation) {
  if (!Number.isFinite(observation.value)) return { observation_id: observation.id, status: "not_assessed", reason: "observation_value_not_numeric" };
  const rows = await db.prepare(
    "SELECT id, instrument_serial, calibration_method, calibration_standard, calibrated_at, valid_until, range_min, range_max, uncertainty, status, evidence_ref FROM source_calibrations WHERE tenant_id = ? AND site_id = ? AND source_id = ? AND metric = ? AND unit = ? AND calibrated_at <= ? AND valid_until >= ? ORDER BY calibrated_at DESC, id LIMIT 10"
  ).bind(tenantId, observation.site_id, observation.source_id, observation.metric,
    observation.unit, observation.observed_at, observation.observed_at).all();
  if (!Array.isArray(rows?.results)) throw new Error("source_calibration_query_invalid");
  const verified = rows.results.filter(item => item.status === "verified");
  const common = { id: observation.id, tenant_id: tenantId, observation_id: observation.id, source_id: observation.source_id,
    metric: observation.metric, unit: observation.unit,
    observation_verification_status: observation.verification_status,
    ingestion_quality_flags: (() => { try { const flags = JSON.parse(observation.quality_flags_json ?? "[]"); return Array.isArray(flags) ? flags : []; } catch { return []; } })() };
  if (verified.length > 1) return { ...common, status: "not_assessed",
    reason: "multiple_verified_calibrations_cover_observation_time" };
  if (verified.length === 0) return { ...common, status: "not_assessed",
    reason: rows.results.some(item => item.status === "unverified")
      ? "calibration_pending_human_review" : "no_verified_calibration_covers_observation_time" };
  const calibration = verified[0];
  if (observation.value < calibration.range_min || observation.value > calibration.range_max) {
    return { ...common, status: "not_assessed",
      reason: "observation_outside_verified_calibration_range",
      calibration_id: calibration.id, calibrated_range: {
        minimum: calibration.range_min, maximum: calibration.range_max, unit: observation.unit,
      } };
  }
  return { ...common, status: "covered_by_verified_calibration",
    calibration_id: calibration.id, calibrated_at: calibration.calibrated_at,
    valid_until: calibration.valid_until, calibration_method: calibration.calibration_method,
    calibration_standard: calibration.calibration_standard,
    uncertainty: calibration.uncertainty, evidence_ref: calibration.evidence_ref,
    calibrated_range: { minimum: calibration.range_min, maximum: calibration.range_max,
      unit: observation.unit } };
}

export async function readSourceCalibration(db, tenantId, siteId, sourceId, calibrationId) {
  const records = await db.prepare(
    "SELECT id, tenant_id, site_id, source_id, instrument_serial, metric, unit, calibration_method, calibration_standard, calibrated_at, valid_until, range_min, range_max, uncertainty, evidence_ref, created_by_subject, status, created_at FROM source_calibrations WHERE tenant_id = ? AND site_id = ? AND source_id = ? AND id = ? LIMIT 2"
  ).bind(tenantId, siteId, sourceId, calibrationId).all();
  if (!Array.isArray(records?.results) || records.results.length !== 1) return null;
  const events = await db.prepare(
    "SELECT event_type, actor_subject, reviewer_role, evidence_ref, reason, request_id, occurred_at FROM source_calibration_events WHERE tenant_id = ? AND site_id = ? AND source_id = ? AND calibration_id = ? ORDER BY occurred_at, id LIMIT 100"
  ).bind(tenantId, siteId, sourceId, calibrationId).all();
  if (!Array.isArray(events?.results)) throw new Error("source_calibration_events_query_invalid");
  return { ...records.results[0], events: events.results };
}

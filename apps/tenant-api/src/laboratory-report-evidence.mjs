const MAX_DOCUMENT_BYTES = 1024 * 1024;
const HEX_SHA256 = /^[a-f0-9]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function validText(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}
function validId(value, max = 160) {
  return validText(value, max) && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}
function decodeBase64(value) {
  if (typeof value !== "string" || value.length === 0 ||
      value.length > Math.ceil(MAX_DOCUMENT_BYTES / 3) * 4 || value.length % 4 !== 0 ||
      !BASE64.test(value)) return null;
  try {
    const binary = atob(value);
    if (binary.length === 0 || binary.length > MAX_DOCUMENT_BYTES) return null;
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch { return null; }
}
function encodeBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
  }
  return btoa(binary);
}
async function digestHex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
function validIssuedAt(value) {
  if (!validText(value, 40)) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  return calendar.getUTCFullYear() === year && calendar.getUTCMonth() === month - 1 &&
    calendar.getUTCDate() === day;
}
function onlyKeys(value, allowed) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every(key => allowed.includes(key));
}

export async function registerLaboratoryReportEvidence(db, tenantId, subject, requestId, body) {
  if (!onlyKeys(body, ["site_id", "file_name", "media_type", "laboratory_name",
      "report_number", "sample_reference", "issued_at", "document_base64"]) ||
      !validId(body.site_id) || !validText(body.file_name, 180) ||
      /[\/\\]/.test(body.file_name) || !body.file_name.toLowerCase().endsWith(".pdf") ||
      body.media_type !== "application/pdf" ||
      !validText(body.laboratory_name, 200) || !validText(body.report_number, 120) ||
      (body.sample_reference !== undefined && !validId(body.sample_reference)) ||
      !validIssuedAt(body.issued_at)) {
    return { error: "laboratory_report_evidence_request_invalid", status: 400 };
  }
  const bytes = decodeBase64(body.document_base64);
  if (!bytes || bytes[0] !== 0x25 || bytes[1] !== 0x50 || bytes[2] !== 0x44 || bytes[3] !== 0x46) {
    return { error: "laboratory_report_pdf_bytes_invalid", status: 400 };
  }
  const site = await db.prepare(
    "SELECT id FROM sites WHERE tenant_id = ? AND id = ? LIMIT 2"
  ).bind(tenantId, body.site_id).all();
  if (!Array.isArray(site?.results) || site.results.length !== 1 || site.results[0].id !== body.site_id) {
    return { error: "site_not_found", status: 404 };
  }
  const sha256 = await digestHex(bytes);
  if (!HEX_SHA256.test(sha256)) throw new Error("laboratory_report_digest_failed");
  const id = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const insertEvidence = db.prepare(
    "INSERT OR IGNORE INTO laboratory_report_evidence (id, tenant_id, site_id, evidence_type, file_name, media_type, byte_length, sha256, document_bytes, laboratory_name, report_number, sample_reference, issued_at, uploaded_by_subject) VALUES (?, ?, ?, 'laboratory_report', ?, 'application/pdf', ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, tenantId, body.site_id, body.file_name, bytes.byteLength, sha256, bytes,
    body.laboratory_name, body.report_number, body.sample_reference ?? null, body.issued_at, subject);
  const insertEvent = db.prepare(
    "INSERT INTO laboratory_report_evidence_events (id, evidence_id, tenant_id, site_id, event_type, actor_subject, request_id) SELECT ?, ?, ?, ?, 'registered', ?, ? WHERE changes() = 1"
  ).bind(eventId, id, tenantId, body.site_id, subject, requestId);
  const results = await db.batch([insertEvidence, insertEvent]);
  if (!Array.isArray(results) || results.length !== 2 ||
      results.some(result => !result?.meta || !Number.isInteger(result.meta.changes))) {
    throw new Error("laboratory_report_evidence_batch_invalid");
  }
  if (results[0].meta.changes === 0 && results[1].meta.changes === 0) {
    const existing = await db.prepare(
      "SELECT id, sha256, byte_length FROM laboratory_report_evidence WHERE tenant_id = ? AND site_id = ? AND sha256 = ? LIMIT 2"
    ).bind(tenantId, body.site_id, sha256).all();
    if (existing?.results?.length === 1) {
      return { data: { id: existing.results[0].id, evidence_ref: "lab-report:" + existing.results[0].id,
        sha256, byte_length: existing.results[0].byte_length, verification_status: "registered_unverified",
        idempotent: true }, status: 200 };
    }
    return { error: "laboratory_report_evidence_conflict", status: 409 };
  }
  if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1) {
    throw new Error("laboratory_report_evidence_batch_incomplete");
  }
  return { data: { id, evidence_ref: "lab-report:" + id, sha256,
    byte_length: bytes.byteLength, verification_status: "registered_unverified", idempotent: false },
    status: 201 };
}

export async function readLaboratoryReportEvidence(db, tenantId, subject, siteId, evidenceId) {
  if (!validId(siteId) || !validId(evidenceId)) return null;
  const result = await db.prepare(
    "SELECT e.id, e.tenant_id, e.site_id, e.evidence_type, e.file_name, e.media_type, e.byte_length, e.sha256, e.document_bytes, e.laboratory_name, e.report_number, e.sample_reference, e.issued_at, e.verification_status, e.uploaded_by_subject, e.created_at FROM laboratory_report_evidence e WHERE e.tenant_id = ? AND e.site_id = ? AND e.id = ? LIMIT 2"
  ).bind(tenantId, siteId, evidenceId).all();
  if (!Array.isArray(result?.results) || result.results.length !== 1) return null;
  const row = result.results[0];
  const bytes = row.document_bytes instanceof Uint8Array
    ? row.document_bytes : new Uint8Array(row.document_bytes);
  if (bytes.byteLength !== row.byte_length || await digestHex(bytes) !== row.sha256) {
    throw new Error("laboratory_report_persisted_digest_mismatch");
  }
  return { id: row.id, evidence_ref: "lab-report:" + row.id, tenant_id: row.tenant_id,
    site_id: row.site_id, evidence_type: row.evidence_type, file_name: row.file_name,
    media_type: row.media_type, byte_length: row.byte_length, sha256: row.sha256,
    laboratory_name: row.laboratory_name, report_number: row.report_number,
    sample_reference: row.sample_reference, issued_at: row.issued_at,
    verification_status: row.verification_status, uploaded_by_subject: row.uploaded_by_subject,
    created_at: row.created_at, document_base64: encodeBase64(bytes) };
}

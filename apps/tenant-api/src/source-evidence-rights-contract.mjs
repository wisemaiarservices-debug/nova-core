import { canonicalizeConfiguration, sha256Hex } from "./configuration-write-contract.mjs";

const MAX_DOCUMENT_BYTES = 1024 * 1024;
const DOCUMENT_TYPES = new Set([
  "data_license", "data_processing_agreement", "consent_record", "permit",
  "device_certificate", "calibration_certificate", "laboratory_report", "other",
]);
const RIGHTS_BASES = new Set(["license", "contract", "consent", "statutory_authority", "other"]);
const PERMITTED_PURPOSES = new Set([
  "measurement_ingestion", "storage", "quality_assessment", "analytics",
  "model_training", "sharing", "publication",
]);
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const validText = (value, max) => typeof value === "string" && value.length > 0 &&
  value.length <= max && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const validId = (value, max = 160) => validText(value, max) &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
const validEvidenceId = value => validId(value, 176) && value.startsWith("source-evidence:");
const validTimestamp = value => {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  const normalized = new Date(parsed).toISOString();
  return normalized === value || normalized.replace(".000Z", "Z") === value;
};
const exactKeys = (value, keys) => isRecord(value) && Object.keys(value).every(key => keys.includes(key));
const issue = (code, path) => ({ code, path });

export function validateSourceEvidenceDocumentDraft(draft) {
  const errors = [];
  const fail = (code, path) => errors.push(issue(code, path));
  const allowed = [
    "document_type", "file_name", "media_type", "issuer_name", "document_reference",
    "issued_at", "effective_from", "effective_to", "document_bytes",
  ];
  if (!exactKeys(draft, allowed) || allowed.some(key => !Object.hasOwn(draft ?? {}, key) &&
      !["effective_from", "effective_to"].includes(key))) {
    return { valid: false, errors: [issue("evidence.invalid_shape", "$")] };
  }
  if (!DOCUMENT_TYPES.has(draft.document_type)) fail("evidence.document_type_invalid", "$.document_type");
  if (!validText(draft.file_name, 180) || /[\/\\]/.test(draft.file_name) ||
      !draft.file_name.toLowerCase().endsWith(".pdf")) {
    fail("evidence.file_name_invalid", "$.file_name");
  }
  if (draft.media_type !== "application/pdf") fail("evidence.media_type_invalid", "$.media_type");
  if (!validText(draft.issuer_name, 200)) fail("evidence.issuer_invalid", "$.issuer_name");
  if (!validText(draft.document_reference, 160)) fail("evidence.document_reference_invalid", "$.document_reference");
  if (!validTimestamp(draft.issued_at)) fail("evidence.issued_at_invalid", "$.issued_at");
  if (draft.effective_from !== undefined && draft.effective_from !== null &&
      !validTimestamp(draft.effective_from)) fail("evidence.effective_from_invalid", "$.effective_from");
  if (draft.effective_to !== undefined && draft.effective_to !== null &&
      !validTimestamp(draft.effective_to)) fail("evidence.effective_to_invalid", "$.effective_to");
  if (draft.effective_from && draft.effective_to &&
      validTimestamp(draft.effective_from) && validTimestamp(draft.effective_to) &&
      draft.effective_to <= draft.effective_from) {
    fail("evidence.effective_window_invalid", "$.effective_to");
  }
  const bytes = draft.document_bytes;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 5 ||
      bytes.byteLength > MAX_DOCUMENT_BYTES ||
      bytes[0] !== 0x25 || bytes[1] !== 0x50 || bytes[2] !== 0x44 || bytes[3] !== 0x46) {
    fail("evidence.pdf_bytes_invalid", "$.document_bytes");
  }
  return { valid: errors.length === 0, errors };
}

/** Validate and hash the actual uploaded PDF bytes; never trust a caller digest. */
export async function prepareSourceEvidenceDocument({
  draft, cryptoProvider = globalThis.crypto,
}) {
  const validation = validateSourceEvidenceDocumentDraft(draft);
  if (!validation.valid) {
    const error = new Error("source_evidence_document_invalid");
    error.details = validation.errors;
    throw error;
  }
  if (!cryptoProvider?.subtle?.digest) throw new Error("source_evidence_crypto_unavailable");
  const bytes = new Uint8Array(draft.document_bytes);
  const digest = await cryptoProvider.subtle.digest("SHA-256", bytes);
  const sha256 = Array.from(new Uint8Array(digest),
    byte => byte.toString(16).padStart(2, "0")).join("");
  return Object.freeze({
    document_type: draft.document_type,
    file_name: draft.file_name,
    media_type: draft.media_type,
    issuer_name: draft.issuer_name,
    document_reference: draft.document_reference,
    issued_at: draft.issued_at,
    effective_from: draft.effective_from ?? null,
    effective_to: draft.effective_to ?? null,
    byte_length: bytes.byteLength,
    sha256,
    document_bytes: bytes,
  });
}

export function validateSourceDataRightsDraft(draft) {
  const errors = [];
  const fail = (code, path) => errors.push(issue(code, path));
  const allowed = [
    "asset_id", "supporting_evidence_id", "provider_name", "controller_name",
    "basis_type", "instrument_reference", "permitted_purposes", "restrictions",
    "effective_from", "effective_to",
  ];
  if (!exactKeys(draft, allowed) || allowed.some(key => !Object.hasOwn(draft ?? {}, key) &&
      !["asset_id", "effective_to", "restrictions"].includes(key))) {
    return { valid: false, errors: [issue("rights.invalid_shape", "$")] };
  }
  if (draft.asset_id !== undefined && draft.asset_id !== null && !validId(draft.asset_id)) {
    fail("rights.asset_id_invalid", "$.asset_id");
  }
  if (!validEvidenceId(draft.supporting_evidence_id)) {
    fail("rights.supporting_evidence_invalid", "$.supporting_evidence_id");
  }
  if (!validText(draft.provider_name, 200)) fail("rights.provider_invalid", "$.provider_name");
  if (!validText(draft.controller_name, 200)) fail("rights.controller_invalid", "$.controller_name");
  if (!RIGHTS_BASES.has(draft.basis_type)) fail("rights.basis_type_invalid", "$.basis_type");
  if (!validText(draft.instrument_reference, 200)) fail("rights.instrument_reference_invalid", "$.instrument_reference");
  if (!Array.isArray(draft.permitted_purposes) || draft.permitted_purposes.length < 1 ||
      draft.permitted_purposes.length > 16 ||
      draft.permitted_purposes.some(value => !PERMITTED_PURPOSES.has(value)) ||
      new Set(draft.permitted_purposes).size !== draft.permitted_purposes.length) {
    fail("rights.permitted_purposes_invalid", "$.permitted_purposes");
  }
  if (!Array.isArray(draft.restrictions) || draft.restrictions.length > 32 ||
      draft.restrictions.some(value => !validText(value, 500)) ||
      new Set(draft.restrictions).size !== draft.restrictions.length) {
    fail("rights.restrictions_invalid", "$.restrictions");
  }
  if (!validTimestamp(draft.effective_from)) fail("rights.effective_from_invalid", "$.effective_from");
  if (draft.effective_to !== undefined && draft.effective_to !== null &&
      !validTimestamp(draft.effective_to)) fail("rights.effective_to_invalid", "$.effective_to");
  if (draft.effective_to && validTimestamp(draft.effective_from) &&
      validTimestamp(draft.effective_to) && draft.effective_to <= draft.effective_from) {
    fail("rights.effective_window_invalid", "$.effective_to");
  }
  return { valid: errors.length === 0, errors };
}

/** Canonical declaration digest binds the rights terms to exact tenant/source evidence scope. */
export async function prepareSourceDataRightsDeclaration({
  draft, tenantId, siteId, sourceId, principalSubject, evidenceSha256,
  cryptoProvider = globalThis.crypto,
}) {
  const validation = validateSourceDataRightsDraft(draft);
  if (!validation.valid || !validId(tenantId, 120) || !validId(siteId) ||
      !validId(sourceId) || !validText(principalSubject, 200) ||
      !/^[a-f0-9]{64}$/.test(evidenceSha256 ?? "")) {
    const error = new Error("source_data_rights_declaration_invalid");
    error.details = validation.errors;
    throw error;
  }
  const normalized = {
    tenant_id: tenantId,
    site_id: siteId,
    source_id: sourceId,
    asset_id: draft.asset_id ?? null,
    supporting_evidence_id: draft.supporting_evidence_id,
    supporting_evidence_sha256: evidenceSha256,
    provider_name: draft.provider_name,
    controller_name: draft.controller_name,
    basis_type: draft.basis_type,
    instrument_reference: draft.instrument_reference,
    permitted_purposes: [...draft.permitted_purposes].sort(),
    restrictions: [...draft.restrictions].sort(),
    effective_from: draft.effective_from,
    effective_to: draft.effective_to ?? null,
    declared_by_subject: principalSubject,
  };
  const canonical = canonicalizeConfiguration(normalized);
  const declarationSha256 = await sha256Hex(canonical.canonicalJson, cryptoProvider);
  return Object.freeze({
    ...normalized,
    permitted_purposes_json: JSON.stringify(normalized.permitted_purposes),
    restrictions_json: JSON.stringify(normalized.restrictions),
    declaration_sha256: declarationSha256,
    canonical_json: canonical.canonicalJson,
  });
}

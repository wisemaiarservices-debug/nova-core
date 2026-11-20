const MODULES = new Set(["neoagro", "neogrid", "neocell", "nova-core"]);
const MEASUREMENT_KINDS = new Set(["measured", "derived"]);
const SAMPLING_MODES = new Set(["interval", "event"]);

const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, max) => typeof value === "string" && value.length > 0 &&
  value.length <= max && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const id = (value, max = 160) => text(value, max) &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
const reference = (value, max = 500) => text(value, max) &&
  /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value) &&
  !value.split("/").some(segment => segment === "." || segment === "..");
const exactKeys = (value, keys) => isRecord(value) && Object.keys(value).every(key => keys.includes(key));
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

function issue(code, path) {
  return { code, path };
}

function isSupportedTimeZone(timezone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a proposed, not-yet-persisted source capability.
 *
 * This is structural and semantic input validation only. It does not grant
 * authority, approve evidence, resolve tenant ownership, or replace the
 * required commit-time D1 capability guard.
 */
export function validateSourceCapabilityDraft(draft, source) {
  const errors = [];
  const fail = (code, path) => errors.push(issue(code, path));

  if (!isRecord(source) || !id(source.id) || !id(source.tenant_id) ||
      !id(source.site_id) || !MODULES.has(source.module) ||
      source.verification_status !== "verified") {
    return { valid: false, errors: [issue("source.not_verified_or_invalid", "$source")] };
  }

  if (!exactKeys(draft, [
    "source_id", "tenant_id", "site_id", "asset_id", "module", "metric", "unit",
    "measurement_kind", "quantity_semantics", "acquisition_protocol",
    "sampling", "timestamp", "quality", "calibration", "data_rights_ref",
    "evidence_ref", "version",
  ])) {
    return { valid: false, errors: [issue("capability.invalid_shape", "$")] };
  }

  if (draft.source_id !== source.id) fail("capability.source_mismatch", "$.source_id");
  if (draft.tenant_id !== source.tenant_id) fail("capability.tenant_mismatch", "$.tenant_id");
  if (draft.site_id !== source.site_id) fail("capability.site_mismatch", "$.site_id");
  if (draft.module !== source.module) fail("capability.module_mismatch", "$.module");
  if (draft.asset_id !== undefined && draft.asset_id !== null && !id(draft.asset_id)) {
    fail("capability.asset_id_invalid", "$.asset_id");
  }

  if (!text(draft.metric, 120) || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(draft.metric)) {
    fail("capability.metric_invalid", "$.metric");
  }
  if (!text(draft.unit, 32) || /\s/.test(draft.unit)) {
    fail("capability.unit_invalid", "$.unit");
  }
  if (!MEASUREMENT_KINDS.has(draft.measurement_kind)) {
    fail("capability.measurement_kind_invalid", "$.measurement_kind");
  }
  if (!text(draft.quantity_semantics, 500)) {
    fail("capability.quantity_semantics_invalid", "$.quantity_semantics");
  }
  if (!id(draft.acquisition_protocol, 80)) {
    fail("capability.acquisition_protocol_invalid", "$.acquisition_protocol");
  }
  if (!integer(draft.version, 1, 1000000)) {
    fail("capability.version_invalid", "$.version");
  }

  if (!exactKeys(draft.sampling, ["mode", "interval_seconds", "max_age_seconds"])) {
    fail("capability.sampling_invalid", "$.sampling");
  } else {
    if (!SAMPLING_MODES.has(draft.sampling.mode)) fail("capability.sampling_mode_invalid", "$.sampling.mode");
    if (draft.sampling.mode === "interval" &&
        !integer(draft.sampling.interval_seconds, 1, 31536000)) {
      fail("capability.interval_invalid", "$.sampling.interval_seconds");
    }
    if (draft.sampling.mode === "interval" &&
        integer(draft.sampling.interval_seconds, 1, 31536000) &&
        integer(draft.sampling.max_age_seconds, 1, 31536000) &&
        draft.sampling.max_age_seconds < draft.sampling.interval_seconds) {
      fail("capability.max_age_below_sampling_interval", "$.sampling.max_age_seconds");
    }
    if (draft.sampling.mode === "event" && draft.sampling.interval_seconds !== undefined) {
      fail("capability.event_interval_forbidden", "$.sampling.interval_seconds");
    }
    if (!integer(draft.sampling.max_age_seconds, 1, 31536000)) {
      fail("capability.max_age_invalid", "$.sampling.max_age_seconds");
    }
  }

  if (!exactKeys(draft.timestamp, ["max_future_skew_seconds", "timezone"])) {
    fail("capability.timestamp_invalid", "$.timestamp");
  } else {
    if (!integer(draft.timestamp.max_future_skew_seconds, 0, 86400)) {
      fail("capability.future_skew_invalid", "$.timestamp.max_future_skew_seconds");
    }
    if (!text(draft.timestamp.timezone, 80) ||
        !/^(UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)$/.test(draft.timestamp.timezone) ||
        !isSupportedTimeZone(draft.timestamp.timezone)) {
      fail("capability.timezone_invalid", "$.timestamp.timezone");
    }
  }

  if (!exactKeys(draft.quality, ["allowed_flags"])) {
    fail("capability.quality_invalid", "$.quality");
  } else if (!Array.isArray(draft.quality.allowed_flags) ||
      draft.quality.allowed_flags.length > 32 ||
      draft.quality.allowed_flags.some(flag => !id(flag, 64)) ||
      new Set(draft.quality.allowed_flags).size !== draft.quality.allowed_flags.length) {
    fail("capability.quality_flags_invalid", "$.quality.allowed_flags");
  }

  if (!exactKeys(draft.calibration, ["required", "profile_ref"])) {
    fail("capability.calibration_invalid", "$.calibration");
  } else {
    if (typeof draft.calibration.required !== "boolean") {
      fail("capability.calibration_required_invalid", "$.calibration.required");
    }
    if (draft.calibration.required && !reference(draft.calibration.profile_ref, 500)) {
      fail("capability.calibration_profile_required", "$.calibration.profile_ref");
    }
    if (!draft.calibration.required && draft.calibration.profile_ref !== undefined &&
        draft.calibration.profile_ref !== null && !id(draft.calibration.profile_ref, 500)) {
      fail("capability.calibration_profile_invalid", "$.calibration.profile_ref");
    }
  }

  if (!reference(draft.data_rights_ref, 500)) fail("capability.data_rights_ref_invalid", "$.data_rights_ref");
  if (!reference(draft.evidence_ref, 500)) fail("capability.evidence_ref_invalid", "$.evidence_ref");

  return { valid: errors.length === 0, errors };
}

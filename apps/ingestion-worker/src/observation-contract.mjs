const MODULES = new Set(["nova-core", "neoagro", "neogrid", "neocell"]);
const METHODS = new Set(["sensor", "manual", "provider_api", "satellite", "model", "derived"]);
const QUALITY_FLAGS = new Set([
  "estimated", "sensor_calibration_due", "sensor_fault", "outlier_suspected",
  "provider_fill_value", "manually_entered", "gridded_or_reanalysis", "time_alignment_uncertain",
]);
const TOP_LEVEL_KEYS = new Set([
  "site_id", "asset_id", "source_id", "module", "metric", "value", "unit",
  "observed_at", "idempotency_key", "provenance", "quality_flags",
]);
const PROVENANCE_KEYS = new Set(["provider", "acquisition_method", "source_record_ref"]);
const METRIC_PATTERN = /^[a-z][a-z0-9_.-]{0,119}$/;
const UNIT_PATTERN = /^[A-Za-z0-9%°µμ/._ -]{1,48}$/;
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function requiredString(value, max, field) {
  if (typeof value !== "string" || !value.trim() || value.trim() !== value || value.length > max) {
    throw new Error("invalid_" + field);
  }
}

function isValidCalendarTimestamp(value) {
  const match = RFC3339_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  const second = Number(value.slice(17, 19));
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > monthDays[month - 1]) return false;
  const zone = value.match(/(Z|[+-]\d{2}:\d{2})$/)?.[1];
  if (!zone) return false;
  if (zone !== "Z") {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }
  return true;
}

export function validateObservationPayload(payload, nowMs = Date.now()) {
  if (!isRecord(payload) || !hasOnlyKeys(payload, TOP_LEVEL_KEYS)) throw new Error("invalid_payload_shape");

  requiredString(payload.site_id, 120, "site_id");
  if (payload.asset_id !== undefined && payload.asset_id !== null) requiredString(payload.asset_id, 120, "asset_id");
  requiredString(payload.source_id, 120, "source_id");
  if (!MODULES.has(payload.module)) throw new Error("invalid_module");
  if (typeof payload.metric !== "string" || !METRIC_PATTERN.test(payload.metric)) throw new Error("invalid_metric");
  if (typeof payload.value !== "number" || !Number.isFinite(payload.value)) throw new Error("invalid_value");
  if (typeof payload.unit !== "string" || !UNIT_PATTERN.test(payload.unit)) throw new Error("invalid_unit");
  requiredString(payload.idempotency_key, 200, "idempotency_key");

  if (typeof payload.observed_at !== "string" || !isValidCalendarTimestamp(payload.observed_at)) {
    throw new Error("invalid_observed_at");
  }
  const observedAt = Date.parse(payload.observed_at);
  if (!Number.isFinite(observedAt) || observedAt > nowMs + 5 * 60 * 1000) {
    throw new Error("invalid_observed_at");
  }

  const provenance = payload.provenance;
  if (!isRecord(provenance) || !hasOnlyKeys(provenance, PROVENANCE_KEYS)) {
    throw new Error("invalid_provenance");
  }
  requiredString(provenance.provider, 120, "provenance_provider");
  if (!METHODS.has(provenance.acquisition_method)) throw new Error("invalid_acquisition_method");
  if (provenance.source_record_ref !== undefined && provenance.source_record_ref !== null) {
    requiredString(provenance.source_record_ref, 240, "source_record_ref");
  }

  const flags = payload.quality_flags === undefined ? [] : payload.quality_flags;
  if (!Array.isArray(flags) || flags.length > 16 ||
      flags.some((flag) => typeof flag !== "string" || !QUALITY_FLAGS.has(flag)) ||
      new Set(flags).size !== flags.length) {
    throw new Error("invalid_quality_flags");
  }

  return Object.freeze({
    ...payload,
    observed_at: new Date(observedAt).toISOString(),
    quality_flags: Object.freeze([...flags]),
  });
}

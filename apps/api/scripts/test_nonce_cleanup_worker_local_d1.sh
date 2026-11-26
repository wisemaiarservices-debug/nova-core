#!/usr/bin/env bash
set -euo pipefail
CONFIG="wrangler.nonce-cleanup.jsonc"
PORT="8791"
BASE_URL="http://127.0.0.1:${PORT}"
LOG_FILE="$(mktemp)"
RESULT_FILE="$(mktemp)"
SERVER_PID=""
cleanup() {
  if [[ -n "${SERVER_PID}" ]]; then kill "${SERVER_PID}" 2>/dev/null || true; wait "${SERVER_PID}" 2>/dev/null || true; fi
  rm -f "${LOG_FILE}" "${RESULT_FILE}"
}
trap cleanup EXIT

npx --yes wrangler@4 d1 migrations apply nova-core-tenant-db --local --config "${CONFIG}" --force
npx --yes wrangler@4 d1 execute nova-core-tenant-db --local --config "${CONFIG}" --command "
INSERT INTO internal_request_nonces (jti, expires_at, retained_until, consumed_at)
VALUES ('runtime-expired-nonce-0001', 1, 1, 1),
       ('runtime-retained-nonce-0001', 1, 9223372036854775807, 1);
"

npx --yes wrangler@4 dev --local --test-scheduled --ip 127.0.0.1 --port "${PORT}" --config "${CONFIG}" >"${LOG_FILE}" 2>&1 &
SERVER_PID="$!"
ready=0
for _ in $(seq 1 60); do
  if curl --silent "${BASE_URL}/" >/dev/null 2>&1; then ready=1; break; fi
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then cat "${LOG_FILE}"; echo "Wrangler exited before readiness" >&2; exit 1; fi
  sleep 1
done
if [[ "${ready}" != "1" ]]; then cat "${LOG_FILE}"; echo "Wrangler did not become ready" >&2; exit 1; fi

curl --silent --show-error --fail "${BASE_URL}/cdn-cgi/local/scheduled?cron=17+*+*+*+*&time=1800000000000&format=json"

npx --yes wrangler@4 d1 execute nova-core-tenant-db --local --config "${CONFIG}" \
  --command "SELECT
    SUM(CASE WHEN jti = 'runtime-expired-nonce-0001' THEN 1 ELSE 0 END) AS expired_remaining,
    SUM(CASE WHEN jti = 'runtime-retained-nonce-0001' THEN 1 ELSE 0 END) AS retained_remaining
    FROM internal_request_nonces;" --json >"${RESULT_FILE}"

python - "${RESULT_FILE}" <<'PY'
import json
import sys
raw = open(sys.argv[1], encoding="utf-8").read()
start = min((p for p in (raw.find("{"), raw.find("[")) if p >= 0), default=-1)
if start < 0:
    raise SystemExit(f"Wrangler did not return JSON: {raw}")
payload = json.loads(raw[start:])
rows = []
def visit(value):
    if isinstance(value, dict):
        if "expired_remaining" in value and "retained_remaining" in value: rows.append(value)
        for child in value.values(): visit(child)
    elif isinstance(value, list):
        for child in value: visit(child)
visit(payload)
if len(rows) != 1: raise SystemExit(f"Expected one D1 aggregate result, got: {payload}")
row = rows[0]
if row["expired_remaining"] != 0 or row["retained_remaining"] != 1:
    raise SystemExit(f"Unexpected cleanup state: {row}")
print("PASS: workerd scheduled() deleted the expired nonce and preserved the retained nonce.")
PY

#!/usr/bin/env bash
set -euo pipefail
CONFIG="wrangler.tenant-local-test.jsonc"
PORT="8792"
BASE_URL="http://127.0.0.1:${PORT}"
LOG_FILE="$(mktemp)"
RESULT_FILE="$(mktemp)"
SERVER_PID=""
cleanup() {
  if [[ -n "${SERVER_PID}" ]]; then kill "${SERVER_PID}" 2>/dev/null || true; wait "${SERVER_PID}" 2>/dev/null || true; fi
  rm -f "${LOG_FILE}" "${RESULT_FILE}"
}
trap cleanup EXIT

npx --yes wrangler@4 d1 migrations apply nova-core-tenant-api-local-test --local --config "${CONFIG}" --force
npx --yes wrangler@4 d1 execute nova-core-tenant-api-local-test --local --config "${CONFIG}" --command "
INSERT INTO tenants (id, display_name, status) VALUES ('tenant-local', 'Local replay test', 'active');
INSERT INTO tenant_memberships (id, tenant_id, subject, role, status)
VALUES ('membership-local', 'tenant-local', 'local-subject-0001', 'viewer', 'active');
INSERT INTO tenant_resource_grants (id, tenant_id, subject, resource_type, resource_id, action)
VALUES ('grant-local', 'tenant-local', 'local-subject-0001', 'site', 'site-local', 'read');
INSERT INTO sites (id, name, tenant_id) VALUES ('site-local', 'Local D1 replay test site', 'tenant-local');
"

npx --yes wrangler@4 dev --local --log-level debug --ip 127.0.0.1 --port "${PORT}" --config "${CONFIG}" >"${LOG_FILE}" 2>&1 &
SERVER_PID="$!"
ready=0
for attempt in $(seq 1 360); do
  if grep -Fq "Ready on ${BASE_URL}" "${LOG_FILE}"; then ready=1; break; fi
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
    echo "Wrangler exited before readiness." >&2
    cat "${LOG_FILE}" >&2
    exit 1
  fi
  sleep 1
done
if [[ "${ready}" != "1" ]]; then
  echo "Wrangler did not report readiness within 360 seconds." >&2
  cat "${LOG_FILE}" >&2
  exit 1
fi

python - "${BASE_URL}" <<'PY'
import base64
import concurrent.futures
import hashlib
import hmac
import json
import sys
import threading
import time
import urllib.error
import urllib.request

base_url = sys.argv[1]
secret = b"local-only-test-secret-material-32-bytes-minimum"
key_id = "local-test-key"
issuer = "nova-core-tenant-gateway"
audience = "nova-core-private-tenant-api"
subject = "local-subject-0001"
path = "/api/v1/tenants/tenant-local/sites/site-local"
now = int(time.time())

def b64url(value):
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")

header = {"alg": "HS256", "typ": "NOVA-Internal-Request", "kid": key_id}
claims = {
    "iss": issuer, "aud": audience, "sub": subject,
    "iat": now, "exp": now + 60, "jti": "local-d1-concurrent-replay-0001",
    "method": "GET", "path": path,
}
protected = b64url(json.dumps(header, separators=(",", ":")).encode())
payload = b64url(json.dumps(claims, separators=(",", ":")).encode())
signing_input = f"{protected}.{payload}"
signature = hmac.new(secret, signing_input.encode(), hashlib.sha256).digest()
token = f"{signing_input}.{b64url(signature)}"

workers = 12
barrier = threading.Barrier(workers)
def request_once(_):
    barrier.wait(timeout=30)
    request = urllib.request.Request(
        base_url + path,
        headers={"Authorization": "Bearer " + token, "Accept": "application/json"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            return response.status, response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8")

with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
    results = list(pool.map(request_once, range(workers)))
statuses = [status for status, _ in results]
if statuses.count(200) != 1 or statuses.count(404) != workers - 1:
    raise SystemExit(f"Expected one authorized winner and {workers - 1} replay denials; got {statuses}")
winner = next(body for status, body in results if status == 200)
resource = json.loads(winner)
if resource.get("id") != "site-local" or resource.get("tenant_id") != "tenant-local":
    raise SystemExit(f"Unexpected authorized resource response: {winner}")
print(f"PASS: {workers} simultaneous identical assertions produced exactly one 200 and {workers - 1} replay denials.")
PY

npx --yes wrangler@4 d1 execute nova-core-tenant-api-local-test --local --config "${CONFIG}" \
  --command "SELECT COUNT(*) AS nonce_count FROM internal_request_nonces WHERE jti='local-d1-concurrent-replay-0001';" --json >"${RESULT_FILE}"
python - "${RESULT_FILE}" <<'PY'
import json
import sys
raw = open(sys.argv[1], encoding="utf-8").read()
start = min((p for p in (raw.find("{"), raw.find("[")) if p >= 0), default=-1)
if start < 0: raise SystemExit(f"Wrangler did not return JSON: {raw}")
payload = json.loads(raw[start:])
rows = []
def visit(value):
    if isinstance(value, dict):
        if "nonce_count" in value: rows.append(value)
        for child in value.values(): visit(child)
    elif isinstance(value, list):
        for child in value: visit(child)
visit(payload)
if len(rows) != 1 or rows[0]["nonce_count"] != 1:
    raise SystemExit(f"Expected exactly one durable nonce row, got: {payload}")
print("PASS: local D1 contains exactly one consumed nonce for the concurrent request ID.")
PY

from __future__ import annotations

import base64
import hashlib
import hmac
import json

import pytest

from apps.api.services.internal_assertion import (
    InternalAssertionError,
    verify_internal_assertion,
)

SECRET = b"unit-test-only-secret-material-32-bytes-minimum"
KEYS = {"gateway-2026-11": SECRET}
ISSUER = "nova-core-tenant-gateway"
AUDIENCE = "nova-core-private-tenant-api"
NOW = 1_800_000_000
PATH = "/api/v1/tenants/tenant-a/sites/site-a"
CLAIMS = {
    "iss": ISSUER,
    "aud": AUDIENCE,
    "sub": "access-user-subject-123",
    "iat": NOW - 5,
    "exp": NOW + 55,
    "jti": "request-id-00000001",
    "method": "GET",
    "path": PATH,
}


def b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def token(claims=None, *, header=None, secret=SECRET, raw_payload=None):
    protected = header or {"alg": "HS256", "typ": "NOVA-Internal-Request", "kid": "gateway-2026-11"}
    header_segment = b64(json.dumps(protected, separators=(",", ":")).encode())
    payload_segment = b64(
        raw_payload if raw_payload is not None
        else json.dumps(claims or CLAIMS, separators=(",", ":")).encode()
    )
    signing_input = f"{header_segment}.{payload_segment}".encode("ascii")
    signature = b64(hmac.new(secret, signing_input, hashlib.sha256).digest())
    return f"{header_segment}.{payload_segment}.{signature}"


def verify(value=None, **overrides):
    args = {
        "key_ring": KEYS,
        "expected_issuer": ISSUER,
        "expected_audience": AUDIENCE,
        "request_method": "GET",
        "request_path": PATH,
        "now": NOW,
    }
    args.update(overrides)
    return verify_internal_assertion(token() if value is None else value, **args)


def test_valid_assertion_returns_only_verified_stable_identity_and_request_binding():
    result = verify()
    assert result.subject == CLAIMS["sub"]
    assert result.jti == CLAIMS["jti"]
    assert result.path == PATH
    assert result.method == "GET"
    assert result.key_id == "gateway-2026-11"


def test_signature_tampering_is_rejected():
    original = token()
    replacement = "A" if original[-1] != "A" else "B"
    with pytest.raises(InternalAssertionError):
        verify(original[:-1] + replacement)


def test_wrong_issuer_and_audience_are_rejected():
    for key, value in (("iss", "other-gateway"), ("aud", "public-api")):
        claims = {**CLAIMS, key: value}
        with pytest.raises(InternalAssertionError):
            verify(token(claims))


def test_expired_future_issued_and_overlong_assertions_are_rejected():
    invalid = [
        {**CLAIMS, "exp": NOW},
        {**CLAIMS, "iat": NOW + 16, "exp": NOW + 60},
        {**CLAIMS, "iat": NOW - 121, "exp": NOW + 1},
    ]
    for claims in invalid:
        with pytest.raises(InternalAssertionError):
            verify(token(claims))


def test_unknown_key_and_unsupported_algorithm_are_rejected():
    unknown = {"alg": "HS256", "typ": "NOVA-Internal-Request", "kid": "missing"}
    with pytest.raises(InternalAssertionError):
        verify(token(header=unknown))
    unsupported = {"alg": "none", "typ": "NOVA-Internal-Request", "kid": "gateway-2026-11"}
    with pytest.raises(InternalAssertionError):
        verify(token(header=unsupported))


def test_method_and_exact_path_binding_are_enforced():
    with pytest.raises(InternalAssertionError):
        verify(request_method="POST")
    with pytest.raises(InternalAssertionError):
        verify(request_path=PATH + "?tenant=other")
    with pytest.raises(InternalAssertionError):
        verify(token({**CLAIMS, "path": "/api/v1/tenants/tenant-b/sites/site-a"}))


def test_service_binding_paths_outside_the_read_only_allowlist_are_rejected():
    for path in (
        "/api/v1/tenants/tenant-a/sites/site-a/",
        "/api/v1/tenants/tenant-a/../sites/site-a",
        "/api/v1/tenants/tenant-a/sites/a%2fb",
        "/api/v1/tenants/tenant-a/memberships/member-a",
    ):
        with pytest.raises(InternalAssertionError):
            verify(token({**CLAIMS, "path": path}), request_path=path)


def test_duplicate_json_members_are_rejected_in_header_and_claims():
    duplicate_header = b64(b'{"alg":"HS256","alg":"none","typ":"NOVA-Internal-Request","kid":"gateway-2026-11"}')
    payload = b64(json.dumps(CLAIMS, separators=(",", ":")).encode())
    signed = f"{duplicate_header}.{payload}".encode("ascii")
    signature = b64(hmac.new(SECRET, signed, hashlib.sha256).digest())
    with pytest.raises(InternalAssertionError):
        verify(f"{duplicate_header}.{payload}.{signature}")

    duplicate_claims = b'{"iss":"nova-core-tenant-gateway","iss":"attacker","aud":"nova-core-private-tenant-api","sub":"subject-a","iat":1799999995,"exp":1800000055,"jti":"request-id-00000001","method":"GET","path":"/api/v1/tenants/tenant-a/sites/site-a"}'
    with pytest.raises(InternalAssertionError):
        verify(token(raw_payload=duplicate_claims))


def test_boolean_timestamps_and_extra_claims_are_rejected():
    with pytest.raises(InternalAssertionError):
        verify(token({**CLAIMS, "iat": True}))
    with pytest.raises(InternalAssertionError):
        verify(token({**CLAIMS, "role": "tenant_owner"}))


def test_malformed_tokens_and_invalid_key_material_fail_closed():
    for value in ("", "one.two", "one.two.three.four", "x" * 5000, "a.b.c"):
        with pytest.raises(InternalAssertionError):
            verify(value)
    with pytest.raises(InternalAssertionError):
        verify(key_ring={"gateway-2026-11": b"too-short"})


def test_missing_runtime_configuration_is_rejected():
    with pytest.raises(InternalAssertionError):
        verify(key_ring={})
    with pytest.raises(InternalAssertionError):
        verify(now=True)

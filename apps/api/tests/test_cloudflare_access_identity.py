import pytest

from apps.api.services.cloudflare_access_identity import (
    AccessIdentityError,
    principal_from_verified_access_claims,
)


def claims(**overrides):
    value = {
        "iss": "https://example.cloudflareaccess.com",
        "aud": ["nova-ingestion-aud"],
        "type": "app",
        "sub": "",
        "common_name": "service-token-client-id",
        "iat": 1_800_000_000,
        "exp": 1_800_000_600,
        "jti": "jwt-id-01",
    }
    value.update(overrides)
    return value


def build(value):
    return principal_from_verified_access_claims(
        value,
        expected_issuer="https://example.cloudflareaccess.com",
        expected_audience="nova-ingestion-aud",
        now_epoch=1_800_000_100,
    )


def test_maps_verified_access_service_token_claims():
    principal = build(claims())
    assert principal.service_id == "service-token-client-id"
    assert principal.issuer == "https://example.cloudflareaccess.com"
    assert principal.audience == "nova-ingestion-aud"
    assert principal.token_id == "jwt-id-01"


@pytest.mark.parametrize("changes", [
    {"iss": "https://attacker.example"},
    {"aud": ["different-audience"]},
    {"type": "org"},
    {"service_token_status": False},
    {"sub": "user-subject"},
    {"common_name": ""},
    {"exp": 1_800_000_000},
    {"iat": 1_800_000_500},
    {"exp": "1800000600"},
])
def test_rejects_invalid_or_non_service_token_claims(changes):
    with pytest.raises(AccessIdentityError):
        build(claims(**changes))


def test_accepts_expected_audience_as_single_string():
    principal = build(claims(aud="nova-ingestion-aud"))
    assert principal.audience == "nova-ingestion-aud"


def test_claim_adapter_does_not_claim_to_verify_signature():
    # This API accepts claims only; cryptographic verification is an upstream gate.
    # The function name and module documentation make that precondition explicit.
    assert callable(principal_from_verified_access_claims)

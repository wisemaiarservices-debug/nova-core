import json

import pytest

from apps.api.services.observation_contract import validate_observation_payload
from apps.api.services.service_authorization import (
    AuthorizationDenied,
    VerifiedServicePrincipal,
    authorize_observation,
    parse_service_grants,
)


def payload(module="neoagro", source_id="source-weather-01"):
    return validate_observation_payload({
        "site_id": "site-test",
        "source_id": source_id,
        "module": module,
        "metric": "weather.air_temperature",
        "value": 24.5,
        "unit": "°C",
        "observed_at": "2026-11-10T10:00:00Z",
        "idempotency_key": "ingest-0001",
        "provenance": {"provider": "gateway", "acquisition_method": "sensor"},
    })


def grants():
    return parse_service_grants(json.dumps({
        "neoagro-ingestor": {
            "neoagro": ["source-weather-01", "source-soil-01"]
        },
        "neogrid-ingestor": {
            "neogrid": ["source-meter-01"]
        },
    }))


def principal(service_id="neoagro-ingestor"):
    return VerifiedServicePrincipal(
        service_id=service_id,
        issuer="https://access.example.test",
        audience="nova-core-ingestion",
        token_id="token-123",
    )


def test_exact_service_module_source_grant_is_allowed():
    assert authorize_observation(principal(), payload(), grants()) is None


@pytest.mark.parametrize("module,source_id", [
    ("neogrid", "source-weather-01"),
    ("neoagro", "source-not-allowlisted"),
    ("neocell", "source-weather-01"),
])
def test_cross_module_or_unlisted_source_is_denied(module, source_id):
    with pytest.raises(AuthorizationDenied):
        authorize_observation(principal(), payload(module, source_id), grants())


def test_unknown_service_is_denied():
    with pytest.raises(AuthorizationDenied):
        authorize_observation(principal("unknown-service"), payload(), grants())


def test_unverified_object_is_denied():
    with pytest.raises(AuthorizationDenied):
        authorize_observation(object(), payload(), grants())


def test_incomplete_verified_principal_is_denied():
    incomplete = VerifiedServicePrincipal(service_id="", issuer="issuer", audience="audience")
    with pytest.raises(AuthorizationDenied):
        authorize_observation(incomplete, payload(), grants())


@pytest.mark.parametrize("raw", [
    "not-json",
    "{}",
    '{"svc": {"neoagro": ["*"]}}',
    '{"svc": {"neoagro": []}}',
    '{"svc": {"unknown": ["source-1"]}}',
    '{"svc": {"neoagro": ["source-1", "source-1"]}}',
])
def test_rejects_unsafe_grant_configuration(raw):
    with pytest.raises(ValueError):
        parse_service_grants(raw)

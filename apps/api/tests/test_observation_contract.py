from datetime import datetime, timedelta, timezone
import copy
import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from apps.api.services.observation_contract import validate_observation_payload


def valid_payload():
    return {
        "site_id": "site-test",
        "asset_id": "sensor-01",
        "source_id": "source-neoagro-weather",
        "module": "neoagro",
        "metric": "weather.air_temperature",
        "value": 24.5,
        "unit": "°C",
        "observed_at": datetime.now(timezone.utc).isoformat(),
        "idempotency_key": "ingest-0001",
        "provenance": {
            "provider": "field-gateway",
            "acquisition_method": "sensor",
            "source_record_ref": "packet-0001",
        },
        "quality_flags": [],
    }


def test_valid_observation_contract_normalizes_timestamp_to_utc():
    result = validate_observation_payload(valid_payload())
    assert result.module == "neoagro"
    assert result.observed_at.utcoffset() == timedelta(0)
    assert result.value == 24.5


@pytest.mark.parametrize("field,value", [
    ("module", "unknown-module"),
    ("metric", "Temperature"),
    ("metric", "weather temperature"),
    ("unit", "°C<script>"),
    ("value", float("nan")),
    ("value", float("inf")),
    ("value", "24.5"),
    ("value", True),
    ("idempotency_key", ""),
])
def test_rejects_invalid_core_fields(field, value):
    payload = valid_payload()
    payload[field] = value
    with pytest.raises(ValidationError):
        validate_observation_payload(payload)


def test_requires_timezone_aware_timestamp():
    payload = valid_payload()
    payload["observed_at"] = "2026-01-01T12:00:00"
    with pytest.raises(ValidationError):
        validate_observation_payload(payload)


def test_rejects_timestamp_far_in_future():
    payload = valid_payload()
    payload["observed_at"] = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    with pytest.raises(ValidationError):
        validate_observation_payload(payload)


def test_rejects_unknown_quality_flag_and_duplicate_flags():
    payload = valid_payload()
    payload["quality_flags"] = ["trusted"]
    with pytest.raises(ValidationError):
        validate_observation_payload(payload)
    payload["quality_flags"] = ["estimated", "estimated"]
    with pytest.raises(ValidationError):
        validate_observation_payload(payload)


def test_rejects_client_attempt_to_set_server_owned_trust_fields():
    payload = valid_payload()
    payload["verification_status"] = "verified"
    payload["actor_id"] = "admin"
    with pytest.raises(ValidationError):
        validate_observation_payload(payload)


def test_rejects_extra_nested_provenance_fields():
    payload = valid_payload()
    payload["provenance"]["verified"] = True
    with pytest.raises(ValidationError):
        validate_observation_payload(payload)


def test_provenance_does_not_claim_verification():
    result = validate_observation_payload(valid_payload())
    assert not hasattr(result, "verification_status")
    assert not hasattr(result, "actor_id")


def test_shared_v1_fixture_matrix_matches_core_api_contract():
    fixture_path = Path(__file__).parent / "fixtures" / "nova-core-observation-v1.json"
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))

    def build_payload(case=None):
        payload = copy.deepcopy(fixture["base_payload"])
        if case is not None:
            path = case.get("path", case.get("delete"))
            parent = payload
            for key in path[:-1]:
                parent = parent[key]
            if "delete" in case:
                del parent[path[-1]]
            else:
                parent[path[-1]] = case["value"]
        return payload

    validate_observation_payload(build_payload())
    for case in fixture["accepted"]:
        validate_observation_payload(build_payload(case))
    for case in fixture["rejected"]:
        with pytest.raises(ValidationError):
            validate_observation_payload(build_payload(case))

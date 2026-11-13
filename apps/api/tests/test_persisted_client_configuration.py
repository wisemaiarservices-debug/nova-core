import hashlib
import json

import pytest

from apps.api.services.persisted_client_configuration import (
    CONFIGURATION_SCHEMA,
    ConfigurationSnapshotError,
    validate_configuration_snapshot,
)


def payload():
    return {
        "configuration_schema": CONFIGURATION_SCHEMA,
        "tenant": {
            "tenant_id": "tenant-a", "display_name": "Client",
            "configuration_version": "v1",
        },
        "site": {
            "site_id": "site-a", "tenant_id": "tenant-a",
            "display_name": "Farm", "configuration_version": "v1",
            "timezone": "Africa/Tunis",
            "land_area": {"value": 2.5, "unit": "ha"},
            "crops": [{"crop_id": "crop-1", "species": "olive"}],
        },
    }


def snapshot(data=None, **overrides):
    encoded = json.dumps(data or payload(), sort_keys=True, separators=(",", ":"))
    args = {
        "tenant_id": "tenant-a",
        "site_id": "site-a",
        "configuration_version": "v1",
        "schema_id": CONFIGURATION_SCHEMA,
        "configuration_json": encoded,
        "content_sha256": hashlib.sha256(encoded.encode()).hexdigest(),
    }
    args.update(overrides)
    return args


def test_valid_immutable_snapshot_becomes_strict_typed_configuration():
    result = validate_configuration_snapshot(**snapshot())
    assert result.tenant.tenant_id == "tenant-a"
    assert result.site.site_id == "site-a"
    assert result.site.land_area.square_metres == 25_000


def test_modified_payload_is_rejected_even_when_json_remains_valid():
    args = snapshot()
    args["configuration_json"] = args["configuration_json"].replace("2.5", "3.5")
    with pytest.raises(ConfigurationSnapshotError, match="digest_mismatch"):
        validate_configuration_snapshot(**args)


def test_wrong_tenant_site_or_version_is_rejected():
    for overrides, expected in (
        ({"tenant_id": "tenant-b"}, "tenant_mismatch"),
        ({"site_id": "site-b"}, "site_mismatch"),
        ({"configuration_version": "v2"}, "version_mismatch"),
    ):
        with pytest.raises(ConfigurationSnapshotError, match=expected):
            validate_configuration_snapshot(**snapshot(**overrides))


def test_nested_site_tenant_mismatch_is_rejected():
    data = payload()
    data["site"]["tenant_id"] = "tenant-b"
    args = snapshot(data)
    with pytest.raises(ConfigurationSnapshotError, match="schema_validation_failed"):
        validate_configuration_snapshot(**args)


def test_unknown_fields_and_invalid_configuration_values_are_rejected():
    data = payload()
    data["site"]["unrecognized_equipment_defaults"] = {"battery_kwh": 999}
    with pytest.raises(ConfigurationSnapshotError, match="schema_validation_failed"):
        validate_configuration_snapshot(**snapshot(data))


def test_schema_and_digest_formats_are_explicitly_checked():
    with pytest.raises(ConfigurationSnapshotError, match="unsupported_configuration_schema"):
        validate_configuration_snapshot(**snapshot(schema_id="nova-client-configuration-v2"))
    with pytest.raises(ConfigurationSnapshotError, match="digest_invalid"):
        validate_configuration_snapshot(**snapshot(content_sha256="not-a-digest"))


def test_non_object_and_malformed_json_are_rejected():
    args = snapshot()
    args["configuration_json"] = "[]"
    args["content_sha256"] = hashlib.sha256(b"[]").hexdigest()
    with pytest.raises(ConfigurationSnapshotError, match="must_be_object"):
        validate_configuration_snapshot(**args)
    args["configuration_json"] = "{"
    args["content_sha256"] = hashlib.sha256(b"{").hexdigest()
    with pytest.raises(ConfigurationSnapshotError, match="json_invalid"):
        validate_configuration_snapshot(**args)


def test_persisted_snapshot_flows_into_onboarding_with_matching_inventory():
    from apps.api.services.equipment_capabilities import CapabilityRegistry
    from apps.api.services.persisted_client_configuration import assess_persisted_client_onboarding

    args = snapshot()
    registry = CapabilityRegistry(
        tenant_id="tenant-a", site_id="site-a", registry_version="v1",
    )
    result = assess_persisted_client_onboarding(**args, registry=registry)
    assert result.configuration.site.configuration_version == "v1"
    assert result.readiness.tenant_id == "tenant-a"
    assert result.readiness.site_id == "site-a"
    assert result.readiness.status == "needs_information"
    assert result.readiness.model_readiness == "not_assessed"


def test_persisted_snapshot_cannot_be_assessed_with_another_sites_inventory():
    from apps.api.services.equipment_capabilities import CapabilityRegistry
    from apps.api.services.persisted_client_configuration import assess_persisted_client_onboarding

    with pytest.raises(ValueError, match="tenant/site"):
        assess_persisted_client_onboarding(
            **snapshot(),
            registry=CapabilityRegistry(
                tenant_id="tenant-a", site_id="site-b", registry_version="v1",
            ),
        )

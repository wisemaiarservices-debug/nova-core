"""Validate immutable D1 configuration snapshots before onboarding assessment.

The digest is an integrity check, not proof of truth, identity or authorization.
Those guarantees are enforced at the private API boundary.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import re

from datetime import date

from pydantic import BaseModel, ConfigDict, ValidationError

from apps.api.services.client_configuration import ClientConfiguration
from apps.api.services.client_onboarding_readiness import (
    ClientOnboardingReadiness, assess_client_onboarding_readiness,
)
from apps.api.services.equipment_capabilities import CapabilityRegistry
from apps.api.services.model_applicability import AvailableFeature, ModelApplicabilityContract


CONFIGURATION_SCHEMA = "nova-client-configuration-v1"
_SHA256 = re.compile(r"^[0-9a-f]{64}$")


class ConfigurationSnapshotError(ValueError):
    """Persisted snapshot failed integrity, schema or tenant/site checks."""


def validate_configuration_snapshot(
    *,
    tenant_id: str,
    site_id: str,
    configuration_version: str,
    schema_id: str,
    configuration_json: str,
    content_sha256: str,
) -> ClientConfiguration:
    """Verify exact stored bytes, parse strict schema, and enforce DB identity.

    No missing fields are inferred and no default is promoted to observed data.
    The input JSON must be the canonical serialization whose digest was stored
    with the immutable snapshot.
    """
    if schema_id != CONFIGURATION_SCHEMA:
        raise ConfigurationSnapshotError("unsupported_configuration_schema")
    if not isinstance(configuration_json, str) or not configuration_json:
        raise ConfigurationSnapshotError("configuration_payload_missing")
    if not isinstance(content_sha256, str) or not _SHA256.fullmatch(content_sha256):
        raise ConfigurationSnapshotError("configuration_digest_invalid")

    actual = hashlib.sha256(configuration_json.encode("utf-8")).hexdigest()
    if not hmac.compare_digest(actual, content_sha256):
        raise ConfigurationSnapshotError("configuration_digest_mismatch")

    try:
        payload = json.loads(configuration_json)
    except (json.JSONDecodeError, UnicodeError) as exc:
        raise ConfigurationSnapshotError("configuration_json_invalid") from exc
    if not isinstance(payload, dict):
        raise ConfigurationSnapshotError("configuration_payload_must_be_object")

    try:
        configuration = ClientConfiguration.model_validate(payload)
    except ValidationError as exc:
        raise ConfigurationSnapshotError("configuration_schema_validation_failed") from exc

    if configuration.tenant.tenant_id != tenant_id:
        raise ConfigurationSnapshotError("configuration_tenant_mismatch")
    if configuration.site.site_id != site_id:
        raise ConfigurationSnapshotError("configuration_site_mismatch")
    if configuration.site.tenant_id != tenant_id:
        raise ConfigurationSnapshotError("configuration_site_tenant_mismatch")
    if (
        configuration.tenant.configuration_version != configuration_version
        or configuration.site.configuration_version != configuration_version
    ):
        raise ConfigurationSnapshotError("configuration_version_mismatch")
    return configuration



class PersistedClientOnboardingAssessment(BaseModel):
    """Validated immutable configuration plus deterministic onboarding result."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    configuration: ClientConfiguration
    readiness: ClientOnboardingReadiness


def assess_persisted_client_onboarding(
    *,
    tenant_id: str,
    site_id: str,
    configuration_version: str,
    schema_id: str,
    configuration_json: str,
    content_sha256: str,
    registry: CapabilityRegistry,
    assessed_on: date | None = None,
    model_contracts: tuple[ModelApplicabilityContract, ...] = (),
    available_features: tuple[AvailableFeature, ...] = (),
    climate_zone: str | None = None,
) -> PersistedClientOnboardingAssessment:
    """Validate the immutable snapshot, then assess it against its matching inventory.

    Registry tenant/site mismatch is rejected by the existing readiness service.
    No configuration or capability declaration is promoted to observed telemetry.
    """
    configuration = validate_configuration_snapshot(
        tenant_id=tenant_id,
        site_id=site_id,
        configuration_version=configuration_version,
        schema_id=schema_id,
        configuration_json=configuration_json,
        content_sha256=content_sha256,
    )
    readiness = assess_client_onboarding_readiness(
        configuration,
        registry,
        assessed_on=assessed_on,
        model_contracts=model_contracts,
        available_features=available_features,
        climate_zone=climate_zone,
    )
    return PersistedClientOnboardingAssessment(
        configuration=configuration,
        readiness=readiness,
    )

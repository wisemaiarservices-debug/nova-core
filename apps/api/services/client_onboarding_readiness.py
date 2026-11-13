"""Deterministic client onboarding readiness; declarations are not telemetry."""
from __future__ import annotations

from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict

from apps.api.services.client_configuration import ClientConfiguration
from apps.api.services.equipment_capabilities import CapabilityRegistry


IssueSeverity = Literal["information_required", "verification_required"]


class OnboardingIssue(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    code: str
    severity: IssueSeverity
    path: str
    message: str


class ClientOnboardingReadiness(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    tenant_id: str
    site_id: str
    configuration_version: str
    registry_version: str
    assessed_on: date
    status: Literal["needs_information", "needs_verification", "ready_for_review"]
    issues: tuple[OnboardingIssue, ...]
    equipment_count: int
    sensor_count: int
    declared_metric_count: int


def assess_client_onboarding_readiness(
    configuration: ClientConfiguration,
    registry: CapabilityRegistry,
    *,
    assessed_on: date | None = None,
) -> ClientOnboardingReadiness:
    """Assess supplied onboarding records without filling gaps or claiming device health.

    Information gaps and verification gaps are deliberately distinct. A
    capability declaration is not a measurement, calibration certificate,
    installed-device proof, or verified connection.
    """
    tenant_id = configuration.tenant.tenant_id
    site = configuration.site
    assessment_date = assessed_on or date.today()
    if registry.tenant_id != tenant_id or registry.site_id != site.site_id:
        raise ValueError("capability registry tenant/site must match client configuration")

    issues: list[OnboardingIssue] = []

    def add(code: str, severity: IssueSeverity, path: str, message: str) -> None:
        issues.append(OnboardingIssue(code=code, severity=severity, path=path, message=message))

    if site.land_area is None:
        add("site.land_area_missing", "information_required", "site.land_area", "Land area and its unit have not been supplied.")
    if site.boundary_geojson is None:
        add("site.boundary_missing", "information_required", "site.boundary_geojson", "A site boundary has not been supplied.")
    if not site.crops:
        add("site.crops_missing", "information_required", "site.crops", "No crop profiles have been supplied.")
    if site.irrigation is None:
        add("site.irrigation_missing", "information_required", "site.irrigation", "Irrigation or rainfed configuration has not been supplied.")
    if site.energy is None:
        add("site.energy_missing", "information_required", "site.energy", "Energy-system specifications have not been supplied.")

    if not registry.equipment:
        add("inventory.equipment_missing", "information_required", "registry.equipment", "No equipment inventory has been supplied.")
    if not registry.sensors:
        add("inventory.sensors_missing", "information_required", "registry.sensors", "No sensor capability declarations have been supplied.")

    for index, equipment in enumerate(registry.equipment):
        prefix = f"registry.equipment[{index}]"
        if not equipment.manufacturer or not equipment.model:
            add("equipment.identity_incomplete", "information_required", prefix, "Manufacturer and model are incomplete.")
        if equipment.protocol == "unknown":
            add("equipment.protocol_unknown", "information_required", f"{prefix}.protocol", "Communication protocol is unknown.")
        if not equipment.ratings:
            add("equipment.ratings_missing", "information_required", f"{prefix}.ratings", "No engineering ratings have been declared.")
        for rating_index, rating in enumerate(equipment.ratings):
            if rating.verification in ("operator_supplied", "unverified") or not rating.source_reference:
                add("equipment.rating_unverified", "verification_required", f"{prefix}.ratings[{rating_index}]", "Engineering rating needs supporting source verification.")

    declared_metric_count = sum(len(sensor.measurements) for sensor in registry.sensors)
    for index, sensor in enumerate(registry.sensors):
        prefix = f"registry.sensors[{index}]"
        if not sensor.manufacturer or not sensor.model:
            add("sensor.identity_incomplete", "information_required", prefix, "Sensor manufacturer and model are incomplete.")
        if sensor.protocol == "unknown":
            add("sensor.protocol_unknown", "information_required", f"{prefix}.protocol", "Sensor communication protocol is unknown.")
        if sensor.connectivity_status != "verified":
            add("sensor.connectivity_unverified", "verification_required", f"{prefix}.connectivity_status", "Connectivity has not been verified by an authenticated live check.")
        calibration = sensor.calibration
        if calibration.last_calibrated_on and calibration.last_calibrated_on > assessment_date:
            add("sensor.calibration_date_in_future", "verification_required", f"{prefix}.calibration", "Calibration date is later than the assessment date.")
        if calibration.status == "current" and calibration.next_calibration_due and calibration.next_calibration_due < assessment_date:
            add("sensor.calibration_expired", "verification_required", f"{prefix}.calibration", "The declared calibration due date has passed.")
        if calibration.status != "current":
            add("sensor.calibration_not_current", "verification_required", f"{prefix}.calibration", "Calibration is not declared current.")
        elif not calibration.independently_verified or not calibration.certificate_reference:
            add("sensor.calibration_evidence_missing", "verification_required", f"{prefix}.calibration", "Calibration status lacks independently verified certificate evidence.")

    has_information_gaps = any(issue.severity == "information_required" for issue in issues)
    has_verification_gaps = any(issue.severity == "verification_required" for issue in issues)
    status = (
        "needs_information" if has_information_gaps
        else "needs_verification" if has_verification_gaps
        else "ready_for_review"
    )
    return ClientOnboardingReadiness(
        tenant_id=tenant_id,
        site_id=site.site_id,
        configuration_version=site.configuration_version,
        registry_version=registry.registry_version,
        assessed_on=assessment_date,
        status=status,
        issues=tuple(issues),
        equipment_count=len(registry.equipment),
        sensor_count=len(registry.sensors),
        declared_metric_count=declared_metric_count,
    )

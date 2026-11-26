"""Compose versioned client configuration and equipment inventory into model context.

This is an in-memory, side-effect-free assessment adapter. It does not register,
authenticate, persist, discover devices, or infer evidence provenance.
"""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from apps.api.services.client_configuration import ClientConfiguration
from apps.api.services.equipment_capabilities import CapabilityRegistry
from apps.api.services.unit_normalization import convert_value
from apps.api.services.model_applicability import (
    AvailableFeature,
    ClientApplicabilityContext,
    Domain,
    ModelApplicabilityContract,
    ApplicabilityAssessment,
    assess_model_applicability,
)


class ClientCapabilityAssessment(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    tenant_id: str
    site_id: str
    configuration_version: str
    registry_version: str
    domain: Domain
    crop_species_context: str | None = None
    equipment_count: int = Field(ge=0)
    sensor_count: int = Field(ge=0)
    declared_metrics: tuple[str, ...] = ()
    assessment: ApplicabilityAssessment


def build_applicability_context(
    configuration: ClientConfiguration,
    registry: CapabilityRegistry,
    domain: Domain,
    *,
    climate_zone: str | None = None,
    available_features: tuple[AvailableFeature, ...] = (),
) -> ClientApplicabilityContext:
    """Build a model context only from matching, explicitly supplied profiles.

    A single crop species is exposed only when all configured crop profiles
    share that species. Mixed-crop sites remain ambiguous for single-crop
    applicability contracts and therefore require a richer model context.
    Sensor capability declarations do not become observed features: callers
    must separately provide features with explicit evidence classes.
    """
    tenant_id = configuration.tenant.tenant_id
    site_id = configuration.site.site_id
    if registry.tenant_id != tenant_id or registry.site_id != site_id:
        raise ValueError("capability registry tenant/site must match client configuration")

    species = {crop.species.casefold(): crop.species for crop in configuration.site.crops}
    crop_species = next(iter(species.values())) if len(species) == 1 else None
    land_area_m2 = (
        convert_value(
            configuration.site.land_area.value,
            configuration.site.land_area.unit,
            "m2",
        )
        if configuration.site.land_area is not None
        else None
    )
    equipment_classes = tuple(sorted({item.asset_class for item in registry.equipment}))

    return ClientApplicabilityContext(
        tenant_id=tenant_id,
        site_id=site_id,
        domain=domain,
        crop_species=crop_species,
        climate_zone=climate_zone,
        land_area_m2=land_area_m2,
        equipment_classes=equipment_classes,
        available_features=available_features,
    )


def assess_client_capabilities(
    configuration: ClientConfiguration,
    registry: CapabilityRegistry,
    model: ModelApplicabilityContract,
    *,
    climate_zone: str | None = None,
    available_features: tuple[AvailableFeature, ...] = (),
) -> ClientCapabilityAssessment:
    """Compose contracts and return a human-review-gated applicability result."""
    context = build_applicability_context(
        configuration,
        registry,
        model.domain,
        climate_zone=climate_zone,
        available_features=available_features,
    )
    result = assess_model_applicability(model, context)
    return ClientCapabilityAssessment(
        tenant_id=context.tenant_id,
        site_id=context.site_id,
        configuration_version=configuration.site.configuration_version,
        registry_version=registry.registry_version,
        domain=model.domain,
        crop_species_context=context.crop_species,
        equipment_count=len(registry.equipment),
        sensor_count=len(registry.sensors),
        declared_metrics=tuple(sorted({
            capability.metric
            for sensor in registry.sensors
            for capability in sensor.measurements
        })),
        assessment=result,
    )

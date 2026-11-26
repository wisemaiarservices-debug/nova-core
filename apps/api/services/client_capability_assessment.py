"""Compose client/site, equipment and model applicability contracts.

This is an in-memory, side-effect-free assessment adapter. It never promotes
sensor declarations into observations or caller-supplied provenance into proof.
"""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from apps.api.services.client_configuration import ClientConfiguration
from apps.api.services.equipment_capabilities import CapabilityRegistry
from apps.api.services.unit_normalization import convert_value
from apps.api.services.model_applicability import (
    AvailableFeature,
    ApplicabilityAssessment,
    ClientApplicabilityContext,
    Domain,
    ModelApplicabilityContract,
    assess_model_applicability,
)


class ClientCapabilityAssessment(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=True)

    tenant_id: str = Field(min_length=1, max_length=120)
    site_id: str = Field(min_length=1, max_length=120)
    configuration_version: str = Field(min_length=1, max_length=40)
    registry_version: str = Field(min_length=1, max_length=40)
    domain: Domain
    model_id: str = Field(min_length=1, max_length=120)
    model_version: str = Field(min_length=1, max_length=120)
    crop_species_context: str | None = Field(default=None, max_length=120)
    equipment_count: int = Field(ge=0, le=500)
    sensor_count: int = Field(ge=0, le=1000)
    declared_metrics: tuple[str, ...] = Field(default=(), max_length=1000)
    assessment: ApplicabilityAssessment


def build_applicability_context(
    configuration: ClientConfiguration,
    registry: CapabilityRegistry,
    domain: Domain,
    *,
    climate_zone: str | None = None,
    available_features: tuple[AvailableFeature, ...] = (),
) -> ClientApplicabilityContext:
    """Build context only from matching, explicitly supplied profiles.

    A single crop species is exposed only when all configured crop profiles
    agree. Mixed-crop sites remain ambiguous. Sensor capability declarations
    do not become observed features: callers must separately supply
    AvailableFeature records with explicit evidence classes.
    """
    if not isinstance(configuration, ClientConfiguration):
        raise ValueError("configuration must be a validated ClientConfiguration")
    if not isinstance(registry, CapabilityRegistry):
        raise ValueError("registry must be a validated CapabilityRegistry")

    tenant_id = configuration.tenant.tenant_id
    site_id = configuration.site.site_id
    if registry.tenant_id != tenant_id or registry.site_id != site_id:
        raise ValueError("capability registry tenant/site must match client configuration")

    species = {
        crop.species.casefold(): crop.species
        for crop in configuration.site.crops
    }
    crop_species = next(iter(species.values())) if len(species) == 1 else None

    land_area_m2 = None
    if configuration.site.land_area is not None:
        land_area_m2 = convert_value(
            configuration.site.land_area.value,
            configuration.site.land_area.unit,
            "m2",
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
    """Compose validated contracts and return a human-review-gated result."""
    if not isinstance(model, ModelApplicabilityContract):
        raise ValueError("model must be a validated ModelApplicabilityContract")

    context = build_applicability_context(
        configuration,
        registry,
        model.domain,
        climate_zone=climate_zone,
        available_features=available_features,
    )
    result = assess_model_applicability(model, context)
    declared_metrics = tuple(sorted({
        capability.metric
        for sensor in registry.sensors
        for capability in sensor.measurements
    }))
    if len(declared_metrics) > 1000:
        raise ValueError("declared sensor metric summary exceeds 1,000 unique metrics")

    return ClientCapabilityAssessment(
        tenant_id=context.tenant_id,
        site_id=context.site_id,
        configuration_version=configuration.site.configuration_version,
        registry_version=registry.registry_version,
        domain=model.domain,
        model_id=model.model_id,
        model_version=model.model_version,
        crop_species_context=context.crop_species,
        equipment_count=len(registry.equipment),
        sensor_count=len(registry.sensors),
        declared_metrics=declared_metrics,
        assessment=result,
    )

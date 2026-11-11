"""Evidence-gated model applicability and abstention contracts.

This evaluates a declared model envelope against a client capability context.
A scope match is not proof of scientific validity or cross-client generalization.
"""
from __future__ import annotations

import math
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


Domain = Literal["agriculture", "water", "energy", "solar", "infrastructure", "climate"]
EvidenceClass = Literal[
    "field_observation", "provider_observation", "satellite_derived",
    "reanalysis", "gridded_model_product", "model_estimate", "scenario_simulation",
]
Scope = Literal["restricted", "unrestricted", "not_required", "unknown"]
Lifecycle = Literal["research", "offline_evaluated", "independently_validated"]


class FeatureRequirement(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    metric: str = Field(min_length=1, max_length=120, pattern=r"^[a-z][a-z0-9_.-]*$")
    accepted_units: tuple[str, ...] = Field(min_length=1)
    accepted_evidence_classes: tuple[EvidenceClass, ...] = Field(min_length=1)


class AvailableFeature(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    metric: str = Field(min_length=1, max_length=120, pattern=r"^[a-z][a-z0-9_.-]*$")
    unit: str = Field(min_length=1, max_length=48)
    evidence_class: EvidenceClass


class ModelApplicabilityContract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    model_id: str = Field(min_length=1, max_length=120)
    model_version: str = Field(min_length=1, max_length=120)
    domain: Domain
    crop_scope: Scope = "unknown"
    supported_crop_species: tuple[str, ...] = ()
    climate_scope: Scope = "unknown"
    supported_climate_zones: tuple[str, ...] = ()
    equipment_scope: Scope = "unknown"
    supported_equipment_classes: tuple[str, ...] = ()
    minimum_land_area_m2: float | None = Field(default=None, gt=0)
    maximum_land_area_m2: float | None = Field(default=None, gt=0)
    required_features: tuple[FeatureRequirement, ...] = ()
    lifecycle: Lifecycle = "research"
    validation_record_reference: str | None = Field(default=None, max_length=240)

    @model_validator(mode="after")
    def validate_envelope(self) -> "ModelApplicabilityContract":
        if self.crop_scope == "restricted" and not self.supported_crop_species:
            raise ValueError("restricted crop scope requires supported_crop_species")
        if self.climate_scope == "restricted" and not self.supported_climate_zones:
            raise ValueError("restricted climate scope requires supported_climate_zones")
        if self.equipment_scope == "restricted" and not self.supported_equipment_classes:
            raise ValueError("restricted equipment scope requires supported_equipment_classes")
        if self.minimum_land_area_m2 and self.maximum_land_area_m2:
            if self.minimum_land_area_m2 > self.maximum_land_area_m2:
                raise ValueError("minimum land area cannot exceed maximum land area")
        metrics = [item.metric for item in self.required_features]
        if len(metrics) != len(set(metrics)):
            raise ValueError("required feature metrics must be unique")
        if self.lifecycle == "independently_validated" and not self.validation_record_reference:
            raise ValueError("independently validated models require a validation record reference")
        return self


class ClientApplicabilityContext(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    tenant_id: str = Field(min_length=1, max_length=120)
    site_id: str = Field(min_length=1, max_length=120)
    domain: Domain
    crop_species: str | None = Field(default=None, max_length=120)
    climate_zone: str | None = Field(default=None, max_length=120)
    land_area_m2: float | None = Field(default=None, gt=0)
    equipment_classes: tuple[str, ...] = ()
    available_features: tuple[AvailableFeature, ...] = ()

    @field_validator("land_area_m2", mode="before")
    @classmethod
    def finite_area(cls, value):
        if value is None:
            return value
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
            raise ValueError("land_area_m2 must be a finite number")
        return value

    @model_validator(mode="after")
    def unique_available_metrics(self) -> "ClientApplicabilityContext":
        metrics = [item.metric for item in self.available_features]
        if len(metrics) != len(set(metrics)):
            raise ValueError("available feature metrics must be unique")
        return self


class ApplicabilityAssessment(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    model_id: str
    model_version: str
    tenant_id: str
    site_id: str
    status: Literal[
        "not_applicable", "needs_configuration", "insufficient_data",
        "research_only", "applicable_for_review"
    ]
    recommendation: Literal["abstain", "research_only", "human_review_only"]
    reasons: tuple[str, ...]
    missing_features: tuple[str, ...] = ()
    unsupported_features: tuple[str, ...] = ()
    lifecycle: Lifecycle


def assess_model_applicability(
    model: ModelApplicabilityContract,
    context: ClientApplicabilityContext,
) -> ApplicabilityAssessment:
    """Check declared scope and evidence prerequisites; never auto-promote a model."""
    reasons: list[str] = []
    missing: list[str] = []
    unsupported: list[str] = []
    hard_mismatch = False
    needs_configuration = False
    insufficient = False

    if model.domain != context.domain:
        hard_mismatch = True
        reasons.append("client domain is outside the model domain")

    if model.crop_scope == "unknown":
        needs_configuration = True
        reasons.append("model crop applicability is not declared")
    elif model.crop_scope == "restricted":
        if context.crop_species is None:
            needs_configuration = True
            reasons.append("client crop species is required")
        elif context.crop_species.casefold() not in {v.casefold() for v in model.supported_crop_species}:
            hard_mismatch = True
            reasons.append("crop species is outside the model's declared applicability")

    if model.climate_scope == "unknown":
        needs_configuration = True
        reasons.append("model climate applicability is not declared")
    elif model.climate_scope == "restricted":
        if context.climate_zone is None:
            needs_configuration = True
            reasons.append("client climate zone is required")
        elif context.climate_zone.casefold() not in {v.casefold() for v in model.supported_climate_zones}:
            hard_mismatch = True
            reasons.append("climate zone is outside the model's declared applicability")

    if model.equipment_scope == "unknown":
        needs_configuration = True
        reasons.append("model equipment applicability is not declared")
    elif model.equipment_scope == "restricted":
        unsupported_equipment = sorted(set(context.equipment_classes) - set(model.supported_equipment_classes))
        if unsupported_equipment:
            hard_mismatch = True
            reasons.append("client equipment classes exceed the model's declared applicability")
    elif model.equipment_scope == "restricted" and not context.equipment_classes:
        needs_configuration = True
        reasons.append("client equipment classes are required")

    if model.minimum_land_area_m2 is not None or model.maximum_land_area_m2 is not None:
        if context.land_area_m2 is None:
            needs_configuration = True
            reasons.append("client land area is required by the model applicability envelope")
        elif model.minimum_land_area_m2 is not None and context.land_area_m2 < model.minimum_land_area_m2:
            hard_mismatch = True
            reasons.append("client land area is below the model applicability envelope")
        elif model.maximum_land_area_m2 is not None and context.land_area_m2 > model.maximum_land_area_m2:
            hard_mismatch = True
            reasons.append("client land area exceeds the model applicability envelope")

    available = {item.metric: item for item in context.available_features}
    for requirement in model.required_features:
        feature = available.get(requirement.metric)
        if feature is None:
            missing.append(requirement.metric)
            continue
        if feature.unit not in requirement.accepted_units:
            unsupported.append(f"{requirement.metric}:unit={feature.unit}")
        if feature.evidence_class not in requirement.accepted_evidence_classes:
            unsupported.append(f"{requirement.metric}:evidence={feature.evidence_class}")

    if missing:
        insufficient = True
        reasons.append("one or more required model inputs are missing")
    if unsupported:
        needs_configuration = True
        reasons.append("one or more model inputs have unsupported units or evidence classes")

    if hard_mismatch:
        status = "not_applicable"
        recommendation = "abstain"
    elif needs_configuration:
        status = "needs_configuration"
        recommendation = "abstain"
    elif insufficient:
        status = "insufficient_data"
        recommendation = "abstain"
    elif model.lifecycle != "independently_validated":
        status = "research_only"
        recommendation = "research_only"
        reasons.append("model has not completed independent validation")
    else:
        status = "applicable_for_review"
        recommendation = "human_review_only"
        reasons.append("scope checks passed; human review remains mandatory")

    return ApplicabilityAssessment(
        model_id=model.model_id,
        model_version=model.model_version,
        tenant_id=context.tenant_id,
        site_id=context.site_id,
        status=status,
        recommendation=recommendation,
        reasons=tuple(reasons),
        missing_features=tuple(missing),
        unsupported_features=tuple(unsupported),
        lifecycle=model.lifecycle,
    )

from datetime import date

import pytest
from pydantic import ValidationError

from apps.api.services.client_configuration import (
    ClientConfiguration,
    CropProfile,
    EnergySystemProfile,
    LandArea,
    SiteMetadataEntry,
    SiteProfile,
    TenantProfile,
)

TENANT = TenantProfile(
    tenant_id="tenant-example",
    display_name="Example customer",
    configuration_version="v1",
)
SITE = {
    "site_id": "site-example",
    "tenant_id": "tenant-example",
    "display_name": "Example site",
    "configuration_version": "v1",
    "timezone": "Africa/Tunis",
}


def test_configuration_accepts_different_land_sizes_and_partial_unknown_specs():
    small = LandArea(value=0.5, unit="ha")
    large = LandArea(value=125, unit="acre")
    assert small.square_metres == pytest.approx(5000)
    assert large.square_metres == pytest.approx(505857.0528)

    profile = ClientConfiguration(
        tenant=TENANT,
        site=SiteProfile(**SITE, land_area=large),
    )
    assert profile.site.energy is None
    assert profile.site.crops == ()


def test_site_rejects_tenant_mismatch():
    with pytest.raises(ValidationError, match="tenant_id"):
        ClientConfiguration(
            tenant=TENANT,
            site=SiteProfile(**{**SITE, "tenant_id": "another-tenant"}),
        )


@pytest.mark.parametrize("value", [0, -1, float("nan"), float("inf"), True])
def test_land_area_requires_finite_positive_numeric_value(value):
    with pytest.raises(ValidationError):
        LandArea(value=value, unit="ha")


def test_land_area_rejects_conversion_overflow_and_unreasonable_area():
    with pytest.raises(ValidationError, match="site-area limit"):
        LandArea(value=1e308, unit="ha")
    with pytest.raises(ValidationError, match="site-area limit"):
        LandArea(value=100_000_000_000_001, unit="m2")


def test_site_requires_valid_timezone_and_structurally_valid_boundary():
    with pytest.raises(ValidationError, match="IANA timezone"):
        SiteProfile(**{**SITE, "timezone": "Mars/Olympus"})
    invalid = {
        "type": "Polygon",
        "coordinates": [[[10, 36], [11, 36], [12, 36], [10, 36]]],
    }
    with pytest.raises(ValidationError, match="structurally valid"):
        SiteProfile(**SITE, boundary_geojson=invalid)


def test_crop_dates_and_energy_specs_are_validated():
    with pytest.raises(ValidationError, match="harvest date"):
        CropProfile(
            crop_id="crop-1",
            species="tomato",
            planting_date=date(2026, 6, 1),
            expected_harvest_date=date(2026, 5, 1),
        )
    with pytest.raises(ValidationError):
        EnergySystemProfile(pv_capacity_kw=-5)


def test_unknown_crop_cultivar_and_energy_specs_remain_explicitly_unknown():
    profile = SiteProfile(
        **SITE,
        crops=({"crop_id": "crop-1", "species": "wheat"},),
        energy={"grid_phase": "unknown"},
    )
    assert profile.crops[0].cultivar is None
    assert profile.energy.pv_capacity_kw is None
    assert profile.energy.nominal_voltage_v is None


def test_configuration_rejects_unrecognized_fields():
    with pytest.raises(ValidationError):
        SiteProfile(**SITE, arbitrary_capacity_kw=42)


@pytest.mark.parametrize("value", [True, float("nan"), float("inf"), -float("inf")])
def test_energy_and_irrigation_ratings_reject_nonfinite_or_boolean_values(value):
    from apps.api.services.client_configuration import IrrigationProfile

    with pytest.raises(ValidationError):
        EnergySystemProfile(pv_capacity_kw=value)
    with pytest.raises(ValidationError):
        IrrigationProfile(design_flow_m3_per_hour=value)


def test_site_profile_collections_are_immutable_and_unique():
    crop = CropProfile(crop_id="crop-1", species="wheat")
    profile = SiteProfile(
        **SITE,
        crops=(crop,),
        metadata=(SiteMetadataEntry(key="climate_zone", value="semi_arid"),),
    )
    assert isinstance(profile.crops, tuple)
    assert isinstance(profile.metadata, tuple)
    with pytest.raises(AttributeError):
        profile.crops.append(crop)
    with pytest.raises(AttributeError):
        profile.metadata.append(SiteMetadataEntry(key="x", value="y"))
    with pytest.raises(ValidationError, match="crop IDs must be unique"):
        SiteProfile(**SITE, crops=(crop, crop))
    with pytest.raises(ValidationError, match="metadata keys must be unique"):
        SiteProfile(
            **SITE,
            metadata=(
                SiteMetadataEntry(key="zone", value="A"),
                SiteMetadataEntry(key="zone", value="B"),
            ),
        )


def test_geojson_boundary_is_deeply_immutable_and_rejects_boolean_coordinates():
    geometry = {
        "type": "Polygon",
        "coordinates": [[[10, 36], [11, 36], [11, 37], [10, 37], [10, 36]]],
    }
    site = SiteProfile(**SITE, boundary_geojson=geometry)
    assert isinstance(site.boundary_geojson.coordinates, tuple)
    with pytest.raises(AttributeError):
        site.boundary_geojson.coordinates[0].append((12.0, 38.0))
    invalid = {
        "type": "Polygon",
        "coordinates": [[[10, 36], [True, 36], [11, 37], [10, 36]]],
    }
    with pytest.raises(ValidationError):
        SiteProfile(**SITE, boundary_geojson=invalid)


def test_client_and_site_configuration_versions_must_match():
    with pytest.raises(ValidationError, match="configuration_version"):
        ClientConfiguration(
            tenant=TENANT,
            site=SiteProfile(**{**SITE, "configuration_version": "v2"}),
        )

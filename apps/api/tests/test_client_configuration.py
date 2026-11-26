from datetime import date

import pytest
from pydantic import ValidationError

from apps.api.services.client_configuration import (
    ClientConfiguration,
    CropProfile,
    EnergySystemProfile,
    LandArea,
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


def test_site_requires_valid_timezone_and_structurally_valid_boundary():
    with pytest.raises(ValidationError, match="IANA timezone"):
        SiteProfile(**{**SITE, "timezone": "Mars/Olympus"})
    invalid = {
        "type": "Polygon",
        "coordinates": [[[10, 36], [11, 36], [12, 36], [10, 36]]],
    }
    with pytest.raises(ValidationError, match="structurally invalid"):
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



def test_boundary_and_metadata_are_recursively_immutable_and_detached_from_inputs():
    boundary = {
        "type": "Polygon",
        "coordinates": [[[10, 36], [11, 36], [11, 37], [10, 37], [10, 36]]],
    }
    metadata = {"operator": "team-a", "irrigation_note": "verified by caller"}
    profile = SiteProfile(**SITE, boundary_geojson=boundary, metadata=metadata)

    boundary["coordinates"][0][0][0] = 99
    metadata["operator"] = "mutated"
    assert profile.boundary_geojson.coordinates[0][0][0] == 10.0
    assert profile.metadata[0].value == "verified by caller"
    assert profile.model_dump(mode="json")["metadata"] == {
        "irrigation_note": "verified by caller",
        "operator": "team-a",
    }
    with pytest.raises(TypeError):
        profile.boundary_geojson.coordinates[0][0][0] = 12.0
    with pytest.raises(ValidationError):
        profile.metadata[0].value = "mutated"


def test_site_metadata_keys_are_unique_and_bounded():
    with pytest.raises(ValidationError, match="unique"):
        SiteProfile(
            **SITE,
            metadata=(
                {"key": "operator", "value": "a"},
                {"key": "operator", "value": "b"},
            ),
        )
    with pytest.raises(ValidationError):
        SiteProfile(**SITE, metadata={f"key-{i}": "v" for i in range(101)})
    with pytest.raises(ValidationError):
        SiteProfile(**SITE, metadata={"k" * 81: "value"})
    with pytest.raises(ValidationError):
        SiteProfile(**SITE, metadata={"key": "v" * 501})


def test_boundary_geometry_rejects_nonfinite_and_boolean_positions():
    nonfinite = {
        "type": "Polygon",
        "coordinates": [[[10, 36], [11, 36], [11, float("nan")], [10, 37], [10, 36]]],
    }
    boolean = {
        "type": "Polygon",
        "coordinates": [[[10, 36], [11, 36], [11, True], [10, 37], [10, 36]]],
    }
    with pytest.raises(ValidationError):
        SiteProfile(**SITE, boundary_geojson=nonfinite)
    with pytest.raises(ValidationError):
        SiteProfile(**SITE, boundary_geojson=boolean)


def test_land_area_has_a_finite_upper_bound_and_conversion():
    with pytest.raises(ValidationError):
        LandArea(value=1_000_000_001, unit="km2")
    assert LandArea(value=1_000_000_000, unit="km2").square_metres == 1e15


def test_crop_collection_is_bounded():
    crops = tuple({"crop_id": f"crop-{i}", "species": "wheat"} for i in range(101))
    with pytest.raises(ValidationError):
        SiteProfile(**SITE, crops=crops)

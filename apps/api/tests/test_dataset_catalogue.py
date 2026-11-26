import asyncio

import httpx

from apps.api.main import app, read_dataset_catalogue
from apps.api.services.dataset_catalogue import (
    DatasetRecord,
    catalogue_summary,
    list_datasets,
)


def test_catalogue_contains_integrated_and_candidate_sources():
    summary = catalogue_summary()
    assert summary == {"total": 6, "integrated": 1, "candidate": 4, "reference_only": 1}
    records = list_datasets()
    assert all(isinstance(record, DatasetRecord) for record in records)
    assert {record.dataset_id for record in records} >= {
        "nasa-power-daily",
        "jrc-pvgis-6",
        "fao-wapor-v3",
        "copernicus-era5-land",
        "copernicus-sentinel-2",
    }


def test_candidate_datasets_are_not_misrepresented_as_integrated():
    by_id = {record.dataset_id: record for record in list_datasets()}
    assert by_id["jrc-pvgis-6"].status == "candidate"
    assert "beta" in by_id["jrc-pvgis-6"].version.lower()
    assert any("model estimate" in item.lower() or "modelled" in item.lower()
               for item in by_id["jrc-pvgis-6"].limitations)
    assert by_id["fao-wapor-v3"].status == "candidate"
    assert by_id["copernicus-era5-land"].evidence_class == "reanalysis"


def test_catalogue_domain_filter_is_narrow_and_case_insensitive():
    records = list_datasets("SOLAR")
    assert records
    assert all("solar" in record.domains for record in records)
    assert {record.dataset_id for record in records} == {
        "nasa-power-daily", "jrc-pvgis-6"
    }


def test_unknown_domain_is_rejected():
    try:
        list_datasets("telemetry")
    except ValueError as exc:
        assert "unsupported dataset domain" in str(exc)
    else:
        raise AssertionError("unknown domain should be rejected")


def test_api_exposes_catalogue_without_claiming_live_ingestion():
    response = read_dataset_catalogue()
    assert response["status"] == "catalogue_available"
    assert response["summary"]["integrated"] == 1
    assert response["returned"] == 6
    assert any("not mean" in item for item in response["limitations"])


def test_api_returns_filtered_catalogue_and_rejects_bad_domain():
    response = read_dataset_catalogue("energy")
    assert response["returned"] == 3
    assert all("energy" in item["domains"] for item in response["records"])
    try:
        read_dataset_catalogue("unknown")
    except Exception as exc:
        assert getattr(exc, "status_code", None) == 422
    else:
        raise AssertionError("unknown domain should return HTTP 422")



def test_catalogue_nested_collections_are_immutable():
    record = list_datasets()[0]
    original_domains = record.domains
    assert isinstance(record.domains, tuple)
    assert isinstance(record.variables, tuple)
    assert isinstance(record.limitations, tuple)
    try:
        record.domains.append("water")
    except AttributeError:
        pass
    else:
        raise AssertionError("catalogue domains must not be mutable")
    try:
        record.variables[0].label = "tampered"
    except Exception:
        pass
    else:
        raise AssertionError("nested catalogue variables must be immutable")
    assert record.domains == original_domains
    assert list_datasets()[0].domains == original_domains


def test_blank_domain_is_normalized_to_no_filter():
    assert len(list_datasets("   ")) == catalogue_summary()["total"]
    response = read_dataset_catalogue("   ")
    assert response["returned"] == catalogue_summary()["total"]
    assert response["domain_filter"] is None



def test_catalogue_http_route_serializes_immutable_collections_as_json_arrays():
    async def request_catalogue():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://test"
        ) as client:
            return await client.get(
                "/api/v1/data/catalogue", params={"domain": "solar"}
            )

    response = asyncio.run(request_catalogue())
    assert response.status_code == 200
    payload = response.json()
    assert payload["domain_filter"] == "solar"
    assert payload["returned"] == 2
    assert isinstance(payload["records"][0]["domains"], list)
    assert isinstance(payload["records"][0]["variables"], list)



def test_wapor_catalogue_metadata_matches_fao_v3_access_guidance():
    record = next(item for item in list_datasets() if item.dataset_id == "fao-wapor-v3")
    assert record.status == "candidate"
    assert record.authentication_required is False
    assert "global" in record.spatial_coverage.lower()
    assert "300 m" in record.spatial_resolution
    assert "100 m" in record.spatial_resolution
    assert "20 m" in record.spatial_resolution
    assert "2018" in record.temporal_coverage
    assert "dekadal" in record.temporal_cadence.lower()
    assert {item.code for item in record.variables} >= {
        "AETI", "RET", "NPP", "E", "T", "I"
    }
    assert any("without an api key" in item.lower() for item in record.limitations)
    assert any("corrections" in item.lower() for item in record.limitations)
    assert "no NOVA WaPOR connector" in record.implementation_note

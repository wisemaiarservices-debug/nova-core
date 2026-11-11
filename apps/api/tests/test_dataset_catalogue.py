from apps.api.main import read_dataset_catalogue
from apps.api.services.dataset_catalogue import (
    DatasetRecord,
    catalogue_summary,
    list_datasets,
)


def test_catalogue_contains_integrated_and_candidate_sources():
    summary = catalogue_summary()
    assert summary == {"total": 7, "integrated": 1, "candidate": 5, "reference_only": 1}
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
    assert response["returned"] == 7
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

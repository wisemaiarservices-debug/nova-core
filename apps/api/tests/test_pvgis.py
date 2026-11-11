import asyncio
from datetime import date

import pytest

from apps.api.main import pvgis_broadband_performance
from apps.api.services import pvgis


def test_pvgis_request_validation_rejects_invalid_coordinates():
    with pytest.raises(ValueError, match="latitude"):
        pvgis.validate_request(91, 10, date(2024, 1, 1), date(2024, 1, 2))
    with pytest.raises(ValueError, match="longitude"):
        pvgis.validate_request(36, 181, date(2024, 1, 1), date(2024, 1, 2))


def test_pvgis_request_validation_enforces_provider_period_and_range():
    with pytest.raises(ValueError, match="2014-2025"):
        pvgis.validate_request(36, 10, date(2013, 12, 31), date(2014, 1, 1))
    with pytest.raises(ValueError, match="2014-2025"):
        pvgis.validate_request(36, 10, date(2025, 12, 31), date(2026, 1, 1))
    with pytest.raises(ValueError, match="367"):
        pvgis.validate_request(36, 10, date(2024, 1, 1), date(2025, 1, 3))
    with pytest.raises(ValueError, match="on or after"):
        pvgis.validate_request(36, 10, date(2024, 1, 2), date(2024, 1, 1))


def test_pvgis_response_parser_rejects_non_object_empty_and_error_payloads():
    with pytest.raises(ValueError):
        pvgis.parse_response([])
    with pytest.raises(ValueError):
        pvgis.parse_response({})
    with pytest.raises(ValueError):
        pvgis.parse_response({"status": "error", "error": "bad request"})


def test_pvgis_result_is_explicitly_modelled_and_not_field_telemetry():
    payload = {"outputs": {"monthly": [{"month": 1, "E_m": 100.0}]}}
    result = pvgis.build_research_result(
        payload, 36.8, 10.2, date(2024, 1, 1), date(2024, 1, 31)
    )
    assert result["dataset_id"] == "jrc-pvgis-6"
    assert result["evidence_class"] == "gridded_model_product"
    assert "not measured inverter output" in result["interpretation"]
    assert result["data"] == payload
    assert result["request"]["latitude"] == 36.8
    assert result["limitations"]


def test_pvgis_endpoint_returns_provenance_and_does_not_persist(monkeypatch):
    payload = {"outputs": {"monthly": [{"month": 1, "E_m": 100.0}]}}
    async def fake_fetch(*args):
        return payload
    monkeypatch.setattr(
        "apps.api.main.fetch_broadband_performance_async", fake_fetch
    )
    result = asyncio.run(
        pvgis_broadband_performance(
            36.8, 10.2, date(2024, 1, 1), date(2024, 1, 31)
        )
    )
    assert result["status"] == "retrieved"
    assert result["data"] == payload
    assert result["evidence_class"] == "gridded_model_product"
    assert "persisted" in result["limitations"][-1]


def test_pvgis_endpoint_maps_invalid_request_to_422():
    async def invalid_fetch(*args):
        raise ValueError("PVGIS 6 time series is limited to calendar years 2014-2025")
    from fastapi import HTTPException
    import apps.api.main as main
    original = main.fetch_broadband_performance_async
    main.fetch_broadband_performance_async = invalid_fetch
    try:
        with pytest.raises(HTTPException) as exc:
            asyncio.run(
                main.pvgis_broadband_performance(
                    36.8, 10.2, date(2013, 1, 1), date(2013, 1, 2)
                )
            )
        assert exc.value.status_code == 422
    finally:
        main.fetch_broadband_performance_async = original

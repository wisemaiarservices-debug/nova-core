import asyncio
from datetime import date

import pytest
from fastapi import HTTPException

from apps.api.main import wapor_mapsets, wapor_rasters
from apps.api.services import wapor


def _page(items, next_url=None):
    links = [{"rel": "next", "href": next_url}] if next_url else []
    return {"response": {"items": items, "links": links}}


def test_wapor_mapset_discovery_uses_provider_pagination_and_provenance():
    calls = []
    def fake(url):
        calls.append(url)
        if url == wapor.BASE_URL:
            return _page([{"code": "L1-AETI-D", "caption": "Global dekadal AETI"}],
                         wapor.BASE_URL + "?page=2")
        return _page([{"code": "L2-AETI-D", "caption": "National dekadal AETI"}])
    result = wapor.list_mapsets(fake)
    assert len(calls) == 2
    assert {item["code"] for item in result["mapsets"]} == {"L1-AETI-D", "L2-AETI-D"}
    assert result["evidence_class"] == "satellite_derived"
    assert result["truncated"] is False
    assert "no site or asset" in result["limitations"][-1]


def test_wapor_rejects_untrusted_pagination_urls():
    for url in (
        "https://attacker.example/gismgr/api/v2/catalog/workspaces/WAPOR-3/mapsets",
        "http://data.apps.fao.org/gismgr/api/v2/catalog/workspaces/WAPOR-3/mapsets",
        "https://data.apps.fao.org.evil.test/gismgr/api/v2/catalog/workspaces/WAPOR-3/mapsets",
        "https://data.apps.fao.org/gismgr/api/v2/catalog/workspaces/WAPOR-3/mapsets-evil",
        "https://user@data.apps.fao.org/gismgr/api/v2/catalog/workspaces/WAPOR-3/mapsets",
        "https://data.apps.fao.org/gismgr/api/v2/catalog/workspaces/WAPOR-3/mapsets#fragment",
    ):
        with pytest.raises(RuntimeError, match="untrusted"):
            wapor._validate_api_url(url)


def test_wapor_mapset_code_is_strict_and_normalized():
    assert wapor.validate_mapset_code("l2-aeti-d") == "L2-AETI-D"
    with pytest.raises(ValueError):
        wapor.validate_mapset_code("../L2-AETI-D")
    with pytest.raises(ValueError):
        wapor.validate_mapset_code("L2-AETI-D/rasters")


def test_wapor_raster_listing_requires_current_catalogue_mapset_and_filters_dates():
    def fake(url):
        if url == wapor.BASE_URL:
            return _page([{"code": "L2-AETI-D"}])
        if url == wapor.BASE_URL + "/L2-AETI-D/rasters":
            return _page([
                {"code": "WAPOR-3.L2-AETI-D.2024-01-D1", "downloadUrl": "https://storage.googleapis.com/sample.tif"},
                {"code": "WAPOR-3.L2-AETI-D.2024-01-D2", "downloadUrl": "https://storage.googleapis.com/sample2.tif"},
                {"code": "WAPOR-3.L2-AETI-D.2024-02-D1", "downloadUrl": "https://storage.googleapis.com/sample3.tif"},
            ])
        raise AssertionError(url)
    result = wapor.list_rasters(
        "l2-aeti-d", date(2024, 1, 11), date(2024, 1, 31), fake
    )
    assert [item["period_start"] for item in result["rasters"]] == ["2024-01-11"]
    assert result["rasters"][0]["code"].endswith("2024-01-D2")
    assert result["evidence_class"] == "satellite_derived"
    assert "GeoTIFF pixel data is not downloaded" in result["limitations"][0]


def test_wapor_rejects_unknown_mapset_and_reversed_dates():
    def fake(url):
        return _page([{"code": "L1-AETI-D"}])
    with pytest.raises(ValueError, match="not present"):
        wapor.list_rasters("L2-AETI-D", request_json=fake)
    with pytest.raises(ValueError, match="on or after"):
        wapor.list_rasters("L1-AETI-D", date(2024, 2, 1), date(2024, 1, 1), fake)


def test_wapor_dekad_date_is_period_start_not_instantaneous_timestamp():
    assert wapor._raster_date("WAPOR-3.L1-AETI-D.2024-02-D3") == date(2024, 2, 21)
    assert wapor._raster_date("WAPOR-3.L1-AETI-M.2024-02") == date(2024, 2, 1)
    assert wapor._raster_date("unrecognized-code") is None


def test_wapor_page_collection_is_bounded():
    calls = []
    def fake(url):
        calls.append(url)
        return _page([{"code": "L1-AETI-D"}], url + "?next=1")
    result = wapor._collect_pages(wapor.BASE_URL, fake)
    assert result["pages_read"] == wapor.MAX_PAGES
    assert result["truncated"] is True
    assert len(calls) == wapor.MAX_PAGES


def test_wapor_api_endpoint_maps_provider_failure_and_invalid_inputs(monkeypatch):
    async def fail():
        raise RuntimeError("provider unavailable")
    monkeypatch.setattr("apps.api.main.list_mapsets_async", fail)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(wapor_mapsets())
    assert exc.value.status_code == 502

    async def invalid(*args):
        raise ValueError("invalid mapset")
    monkeypatch.setattr("apps.api.main.list_rasters_async", invalid)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(wapor_rasters("invalid", None, None))
    assert exc.value.status_code == 422

import asyncio
from datetime import date

import pytest
from fastapi import HTTPException

from apps.api.main import wapor_mapsets, wapor_rasters
from apps.api.services import wapor


def _page(items, next_url=None, links=None):
    if links is None:
        links = [{"rel": "next", "href": next_url}] if next_url else []
    return {"response": {"items": items, "links": links}}


def test_wapor_mapset_discovery_uses_provider_pagination_and_provenance():
    calls = []

    def fake(url):
        calls.append(url)
        if url == wapor.BASE_URL:
            return _page(
                [{"code": "L1-AETI-D", "caption": "Global dekadal AETI"}],
                wapor.BASE_URL + "?page=2",
            )
        return _page([{"code": "L2-AETI-D", "caption": "National dekadal AETI"}])

    result = wapor.list_mapsets(fake)
    assert len(calls) == 2
    assert {item["code"] for item in result["mapsets"]} == {"L1-AETI-D", "L2-AETI-D"}
    assert result["evidence_class"] == "satellite_derived"
    assert result["truncated"] is False
    assert "no site or asset" in result["limitations"][-1]


def test_wapor_url_validation_rejects_host_and_path_prefix_confusion():
    invalid = [
        "https://attacker.example" + wapor.ALLOWED_PATH,
        "http://data.apps.fao.org" + wapor.ALLOWED_PATH,
        "https://data.apps.fao.org.evil.test" + wapor.ALLOWED_PATH,
        "https://data.apps.fao.org" + wapor.ALLOWED_PATH + ".evil",
        "https://data.apps.fao.org" + wapor.ALLOWED_PATH + "/../admin",
        "https://user@data.apps.fao.org" + wapor.ALLOWED_PATH,
    ]
    for url in invalid:
        with pytest.raises(RuntimeError, match="untrusted"):
            wapor._validate_api_url(url)
    wapor._validate_api_url(wapor.BASE_URL + "?page=2")
    wapor._validate_api_url(wapor.BASE_URL + "/L2-AETI-D/rasters")


def test_wapor_mapset_code_is_strict_and_normalized():
    assert wapor.validate_mapset_code("l2-aeti-d") == "L2-AETI-D"
    for value in ("../L2-AETI-D", "L2-AETI-D/rasters", "L4-AETI-D", "L2-AETI-D?x=1"):
        with pytest.raises(ValueError):
            wapor.validate_mapset_code(value)


def test_wapor_raster_listing_filters_periods_and_sanitizes_download_references():
    def fake(url):
        if url == wapor.BASE_URL:
            return _page([{"code": "L2-AETI-D"}])
        if url == wapor.BASE_URL + "/L2-AETI-D/rasters":
            return _page(
                [
                    {
                        "code": "WAPOR-3.L2-AETI-D.2024-01-D1",
                        "downloadUrl": "https://storage.googleapis.com/sample.tif",
                        "gsutilUri": "gs://wapor-bucket/sample.tif",
                    },
                    {
                        "code": "WAPOR-3.L2-AETI-D.2024-01-D2",
                        "downloadUrl": "https://evil.example/sample2.tif",
                        "gsutilUri": "gs://bad bucket/sample2.tif",
                    },
                    {"code": "WAPOR-3.L2-AETI-D.unknown"},
                    {"code": "WAPOR-3.L2-AETI-D.2024-02-D1"},
                ]
            )
        raise AssertionError(url)

    result = wapor.list_rasters(
        "l2-aeti-d", date(2024, 1, 1), date(2024, 1, 31), fake
    )
    assert [item["period_start"] for item in result["rasters"]] == ["2024-01-01", "2024-01-11"]
    assert result["rasters"][0]["download_url"] == "https://storage.googleapis.com/sample.tif"
    assert result["rasters"][0]["gsutil_uri"] == "gs://wapor-bucket/sample.tif"
    assert result["rasters"][1]["code"].endswith("2024-01-D2")
    assert result["rasters"][1]["download_url"] is None
    assert result["rasters"][1]["gsutil_uri"] is None
    assert result["unparsed_date_count"] == 1
    assert result["evidence_class"] == "satellite_derived"
    assert "GeoTIFF pixel data is not downloaded" in result["limitations"][0]


def test_wapor_rejects_unknown_mapset_and_reversed_dates():
    def fake(url):
        return _page([{"code": "L1-AETI-D"}])

    with pytest.raises(ValueError, match="not present"):
        wapor.list_rasters("L2-AETI-D", request_json=fake)
    with pytest.raises(ValueError, match="on or after"):
        wapor.list_rasters("L1-AETI-D", date(2024, 2, 1), date(2024, 1, 1), fake)


def test_wapor_truncated_catalogue_cannot_be_used_to_claim_mapset_absence():
    def fake(url):
        return _page([{"code": "L1-AETI-D"}], url + "?next=1")

    with pytest.raises(RuntimeError, match="truncated"):
        wapor.list_rasters("L2-AETI-D", request_json=fake)


def test_wapor_dekad_date_parser_handles_invalid_and_supported_periods():
    assert wapor._raster_date("WAPOR-3.L1-AETI-D.2024-02-D3") == date(2024, 2, 21)
    assert wapor._raster_date("WAPOR-3.L1-AETI-M.2024-02") == date(2024, 2, 1)
    assert wapor._raster_date("WAPOR-3.L1-AETI-D.2024-02-31") is None
    assert wapor._raster_date("unrecognized-code") is None


def test_wapor_page_collection_is_bounded_and_reports_truncation_only_when_needed():
    calls = []

    def paginated(url):
        calls.append(url)
        return _page([{"code": "L1-AETI-D"}], url + f"?page={len(calls) + 1}")

    result = wapor._collect_pages(wapor.BASE_URL, paginated)
    assert result["pages_read"] == wapor.MAX_PAGES
    assert result["truncated"] is True
    assert len(calls) == wapor.MAX_PAGES

    exact = wapor._collect_pages(
        wapor.BASE_URL,
        lambda url: _page([{"code": f"L1-AETI-D-{i}"} for i in range(wapor.MAX_ITEMS)]),
    )
    assert len(exact["items"]) == wapor.MAX_ITEMS
    assert exact["truncated"] is False


def test_wapor_pagination_rejects_cycles_and_malformed_links():
    with pytest.raises(RuntimeError, match="cycle"):
        wapor._collect_pages(wapor.BASE_URL, lambda url: _page([], url))
    with pytest.raises(RuntimeError, match="links collection"):
        wapor._collect_pages(
            wapor.BASE_URL,
            lambda url: {"response": {"items": [], "links": "not-a-list"}},
        )
    with pytest.raises(RuntimeError, match="pagination link"):
        wapor._collect_pages(
            wapor.BASE_URL,
            lambda url: _page([], links=[{"rel": "next", "href": 42}]),
        )


def test_wapor_mapset_summaries_reject_invalid_codes_and_bound_text():
    result = wapor.list_mapsets(
        lambda url: _page(
            [
                {"code": "../bad", "caption": "unsafe"},
                {"code": "L1-AETI-D", "caption": "x" * 1000},
            ]
        )
    )
    assert len(result["mapsets"]) == 1
    assert len(result["mapsets"][0]["caption"]) == 200


def test_wapor_async_local_fallback_uses_bounded_sync_transport(monkeypatch):
    monkeypatch.setattr(
        wapor,
        "_request_json",
        lambda url: _page([{"code": "L1-AETI-D"}]),
    )
    result = asyncio.run(wapor.list_mapsets_async())
    assert result["mapsets"][0]["code"] == "L1-AETI-D"


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



def test_sync_discovery_deadline_is_shared_across_pages(monkeypatch):
    now = [0.0]
    monkeypatch.setattr(wapor.time, "monotonic", lambda: now[0])
    calls = []
    def slow_page(url):
        calls.append(url)
        now[0] += 20
        return _page([{"code": "L1-AETI-D"}], url + f"?page={len(calls) + 1}")
    with pytest.raises(RuntimeError, match="60-second operation deadline"):
        wapor._collect_pages(wapor.BASE_URL, slow_page)
    assert len(calls) == 3


def test_sync_list_rasters_shares_deadline_across_catalogue_and_index(monkeypatch):
    now = [0.0]
    monkeypatch.setattr(wapor.time, "monotonic", lambda: now[0])
    calls = []
    def slow_page(url):
        calls.append(url)
        now[0] += 31
        if url == wapor.BASE_URL:
            return _page([{"code": "L1-AETI-D"}])
        return _page([])
    with pytest.raises(RuntimeError, match="60-second operation deadline"):
        wapor.list_rasters("L1-AETI-D", request_json=slow_page)
    assert len(calls) == 2


def test_sync_request_reduces_socket_timeout_before_each_read(monkeypatch):
    now = [100.0]
    monkeypatch.setattr(wapor.time, "monotonic", lambda: now[0])
    class Socket:
        def __init__(self): self.timeouts = []
        def settimeout(self, value): self.timeouts.append(value)
    class Raw:
        def __init__(self, sock): self._sock = sock
    class File:
        def __init__(self, sock): self.raw = Raw(sock)
    class Response:
        headers = {"Content-Type": "application/json"}
        def __init__(self, sock):
            self.fp = File(sock)
            self.parts = [b'{"response":', b'{"items":[],"links":[]}}', b""]
        def __enter__(self): return self
        def __exit__(self, *args): return False
        def read(self, size):
            now[0] += 2
            return self.parts.pop(0)
    sock = Socket()
    response = Response(sock)
    class Opener:
        def open(self, request, timeout):
            assert timeout == 10.0
            return response
    monkeypatch.setattr(wapor, "build_opener", lambda *args: Opener())
    result = wapor._request_json(wapor.BASE_URL, deadline=110.0)
    assert result["response"]["items"] == []
    assert sock.timeouts == [10.0, 8.0, 6.0]

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

def test_wapor_async_endpoints_use_async_fetch_and_preserve_bounds(monkeypatch):
    calls = []

    async def fake_async(url):
        calls.append(url)
        if url == wapor.BASE_URL:
            return _page([{"code": "L2-AETI-D"}])
        if url == wapor.BASE_URL + "/L2-AETI-D/rasters":
            return _page([
                {"code": "WAPOR-3.L2-AETI-D.2024-01-D1"},
                {"code": "WAPOR-3.L2-AETI-D.2024-01-D2"},
            ])
        raise AssertionError(url)

    monkeypatch.setattr(wapor, "_request_json_async", fake_async)
    async def run():
        mapsets = await wapor.list_mapsets_async()
        assert [item["code"] for item in mapsets["mapsets"]] == ["L2-AETI-D"]
        return await wapor.list_rasters_async(
            "L2-AETI-D", date(2024, 1, 11), date(2024, 1, 20)
        )

    rasters = asyncio.run(run())
    assert [item["period_start"] for item in rasters["rasters"]] == ["2024-01-11"]
    assert calls == [
        wapor.BASE_URL,
        wapor.BASE_URL,
        wapor.BASE_URL + "/L2-AETI-D/rasters",
    ]


def test_wapor_async_pagination_remains_bounded(monkeypatch):
    calls = []

    async def fake_async(url):
        calls.append(url)
        return _page([{"code": "L1-AETI-D"}], url + "?next=1")

    result = asyncio.run(wapor._collect_pages_async(wapor.BASE_URL, fake_async))
    assert result["pages_read"] == wapor.MAX_PAGES
    assert result["truncated"] is True
    assert len(calls) == wapor.MAX_PAGES

def test_wapor_worker_response_stream_is_bounded_and_releases_reader():
    class Chunk:
        def __init__(self, value):
            self.value = value
            self.byteLength = len(value)
        def to_py(self):
            return self.value

    class Reader:
        def __init__(self, chunks):
            self.chunks = iter(chunks)
            self.released = False
            self.cancelled = False
        async def read(self):
            try:
                value = next(self.chunks)
                return type("ReadResult", (), {"done": False, "value": Chunk(value)})()
            except StopIteration:
                return type("ReadResult", (), {"done": True, "value": None})()
        async def cancel(self):
            self.cancelled = True
        def releaseLock(self):
            self.released = True

    class Body:
        def __init__(self, reader):
            self.reader = reader
        def getReader(self):
            return self.reader

    async def run():
        reader = Reader([b'{"response":', b'{"items":[]}}'])
        response = type("Response", (), {"body": Body(reader)})()
        raw = await wapor._read_bounded_response(response)
        assert raw == b'{"response":{"items":[]}}'
        assert reader.released is True
        assert reader.cancelled is False

        class OversizedChunk:
            byteLength = wapor.MAX_RESPONSE_BYTES + 1
            def to_py(self):
                raise AssertionError("oversized chunk must be rejected before conversion")

        class OversizedReader(Reader):
            async def read(self):
                return type("ReadResult", (), {"done": False, "value": OversizedChunk()})()

        overflow = OversizedReader([])
        response = type("Response", (), {"body": Body(overflow)})()
        with pytest.raises(RuntimeError, match="1 MiB"):
            await wapor._read_bounded_response(response)
        assert overflow.cancelled is True
        assert overflow.released is True

    asyncio.run(run())



def test_wapor_async_mapsets_enforces_total_operation_deadline(monkeypatch):
    cancelled = False

    async def slow_request(url):
        nonlocal cancelled
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled = True
            raise

    monkeypatch.setattr(wapor, "TOTAL_OPERATION_TIMEOUT_SECONDS", 0.01)
    monkeypatch.setattr(wapor, "_request_json_async", slow_request)

    with pytest.raises(RuntimeError, match="total deadline"):
        asyncio.run(wapor.list_mapsets_async())

    assert cancelled is True


def test_wapor_async_rasters_total_deadline_covers_catalogue_and_raster_pages(monkeypatch):
    calls = []

    async def slow_after_catalogue(url):
        calls.append(url)
        if url == wapor.BASE_URL:
            return _page([{"code": "L2-AETI-D"}])
        await asyncio.Event().wait()

    monkeypatch.setattr(wapor, "TOTAL_OPERATION_TIMEOUT_SECONDS", 0.01)
    monkeypatch.setattr(wapor, "_request_json_async", slow_after_catalogue)

    with pytest.raises(RuntimeError, match="total deadline"):
        asyncio.run(wapor.list_rasters_async("L2-AETI-D"))

    assert calls == [wapor.BASE_URL, wapor.BASE_URL + "/L2-AETI-D/rasters"]


@pytest.mark.parametrize(
    ("content_type", "expected"),
    [
        ("application/json", True),
        ("application/json; charset=utf-8", True),
        ("application/geo+json", True),
        ("application/notjson", False),
        ("application/jsonp", False),
        ("text/json", False),
        ("", False),
    ],
)
def test_wapor_json_content_type_is_strict(content_type, expected):
    assert wapor._is_json_content_type(content_type) is expected


def test_wapor_worker_fetch_options_use_manual_redirects():
    captured = {}
    marker = object()

    def fake_to_js(value, *, dict_converter):
        captured["value"] = value
        captured["converter"] = dict_converter
        return value

    options = wapor._worker_fetch_options(fake_to_js, marker)
    assert options["method"] == "GET"
    assert options["headers"]["Accept"] == "application/json"
    assert options["redirect"] == "manual"
    assert captured["converter"] is marker


def test_wapor_worker_fetch_cancels_unread_body_on_http_and_media_type_rejection():
    from types import SimpleNamespace

    class Body:
        def __init__(self):
            self.cancelled = False

        async def cancel(self):
            self.cancelled = True

        def getReader(self):
            raise AssertionError("rejected body must not be read")

    async def check(response, message):
        async def fake_fetch(url, options):
            return response

        with pytest.raises(RuntimeError, match=message):
            await wapor._fetch_worker_payload(fake_fetch, "https://example.invalid", {})
        assert response.body.cancelled is True

    async def run():
        non_success_body = Body()
        await check(
            SimpleNamespace(
                ok=False,
                status=503,
                headers=SimpleNamespace(get=lambda key: "application/json"),
                body=non_success_body,
            ),
            "HTTP 503",
        )
        invalid_type_body = Body()
        await check(
            SimpleNamespace(
                ok=True,
                status=200,
                headers=SimpleNamespace(get=lambda key: "application/jsonp"),
                body=invalid_type_body,
            ),
            "non-JSON content type",
        )

    asyncio.run(run())


def test_wapor_worker_fetch_aborts_underlying_request_on_cancellation():
    class Controller:
        aborted = False
        def abort(self):
            self.aborted = True

    controller = Controller()

    async def blocked_fetch(url, options):
        await asyncio.Event().wait()

    async def run():
        task = asyncio.create_task(
            wapor._fetch_worker_payload_with_abort(
                blocked_fetch, "https://example.invalid", {}, controller
            )
        )
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(run())
    assert controller.aborted is True


def test_wapor_worker_fetch_options_attach_abort_signal():
    captured = {}
    signal = object()

    def fake_to_js(value, *, dict_converter):
        captured["value"] = value
        return value

    options = wapor._worker_fetch_options(fake_to_js, object(), signal)
    assert options["redirect"] == "manual"
    assert options["signal"] is signal



def test_wapor_worker_fetch_aborts_underlying_request_on_timeout():
    class Controller:
        aborted = False
        def abort(self):
            self.aborted = True

    controller = Controller()

    async def blocked_fetch(url, options):
        await asyncio.Event().wait()

    async def run():
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(
                wapor._fetch_worker_payload_with_abort(
                    blocked_fetch, "https://example.invalid", {}, controller
                ),
                timeout=0.01,
            )

    asyncio.run(run())
    assert controller.aborted is True

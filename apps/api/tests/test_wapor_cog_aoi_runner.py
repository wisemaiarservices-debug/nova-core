from datetime import date

import pytest

from scripts.wapor_cog_aoi import (
    MAX_COG_OBJECT_BYTES,
    ResearchProcessingError,
    _masked_statistics,
    _validate_initial_range,
    _validate_provider_period,
    dekadal_period,
    validate_wapor_download_url,
)


MAPSET = "L2-T-D"
RASTER = "WAPOR-3.L2-T-D.2022-01-D1"
URL = (
    "https://storage.googleapis.com/fao-gismgr-wapor-3-data/"
    "DATA/WAPOR-3/MAPSET/L2-T-D/WAPOR-3.L2-T-D.2022-01-D1.tif"
)


def test_accepts_only_exact_fao_wapor_v3_cog_object_path():
    assert validate_wapor_download_url(URL, MAPSET, RASTER) == URL


@pytest.mark.parametrize(
    "url",
    [
        URL.replace("storage.googleapis.com", "storage.googleapis.com.evil.example"),
        URL.replace("/fao-gismgr-wapor-3-data/", "/other-bucket/"),
        URL + "?redirect=https://evil.example",
        URL.replace("https://", "http://"),
        URL.replace("L2-T-D/", "L2-AETI-D/"),
        URL.replace(".tif", ".tif;parameter=1"),
        URL.replace(".tif", ".tif%2f"),
        URL.replace("storage.googleapis.com", "user@storage.googleapis.com"),
        URL.replace("storage.googleapis.com", "storage.googleapis.com:444"),
    ],
)
def test_rejects_non_allowlisted_or_mismatched_download_urls(url):
    with pytest.raises(ResearchProcessingError):
        validate_wapor_download_url(url, MAPSET, RASTER)


def test_raster_code_must_belong_to_requested_mapset():
    with pytest.raises(ResearchProcessingError, match="does not belong"):
        validate_wapor_download_url(URL, "L2-AETI-D", RASTER)


@pytest.mark.parametrize(
    "raster_code,start,end",
    [
        ("WAPOR-3.L2-T-D.2024-02-D1", date(2024, 2, 1), date(2024, 2, 10)),
        ("WAPOR-3.L2-T-D.2024-02-D2", date(2024, 2, 11), date(2024, 2, 20)),
        ("WAPOR-3.L2-T-D.2024-02-D3", date(2024, 2, 21), date(2024, 2, 29)),
    ],
)
def test_decodes_leap_year_dekadal_periods(raster_code, start, end):
    assert dekadal_period(raster_code) == (start, end)


@pytest.mark.parametrize("raster_code", [
    "WAPOR-3.L2-T-D.2024-13-D1",
    "WAPOR-3.L2-T-D.0000-01-D1",
    "WAPOR-3.L2-T-D.2024-02-D4",
    "WAPOR-3.L2-T-D.2024-02",
])
def test_rejects_invalid_or_non_dekadal_periods(raster_code):
    with pytest.raises(ResearchProcessingError):
        dekadal_period(raster_code)


def test_catalogue_period_must_match_dekadal_raster_code():
    assert _validate_provider_period(RASTER, "2022-01-01") == (
        date(2022, 1, 1),
        date(2022, 1, 10),
    )
    with pytest.raises(ResearchProcessingError, match="does not match"):
        _validate_provider_period(RASTER, "2022-01-02")


@pytest.mark.parametrize(
    "content_range,prefix,expected_size",
    [
        ("bytes 0-3/1024", b"II*\x00", 1024),
        ("bytes 0-3/1024 ", b"MM\x00*", 1024),
    ],
)
def test_initial_range_requires_exact_range_and_head_size(content_range, prefix, expected_size):
    _validate_initial_range(content_range, prefix, expected_size)


@pytest.mark.parametrize(
    "content_range,prefix,expected_size",
    [
        ("bytes 0-3/2048", b"II*\x00", 1024),
        ("bytes 0-4/1024", b"II*\x00", 1024),
        ("bytes 0-3/*", b"II*\x00", 1024),
        ("bytes 0-3/1024, bytes 0-3/1024", b"II*\x00", 1024),
        ("bytes 0-3/1024", b"II*\x00x", 1024),
        ("bytes 0-3/1024", b"NOPE", 1024),
    ],
)
def test_initial_range_rejects_mismatch_partial_or_invalid_tiff(content_range, prefix, expected_size):
    with pytest.raises(ResearchProcessingError):
        _validate_initial_range(content_range, prefix, expected_size)


def test_remote_cog_object_limit_is_256_mib():
    assert MAX_COG_OBJECT_BYTES == 256 * 1024 * 1024


def test_masked_statistics_exclude_nodata_and_outside_pixels():
    np = pytest.importorskip("numpy")
    samples = np.array([[1, 2], [3, -9999]], dtype=np.int16)
    inside = np.array([[True, True], [True, True]])
    provider_mask = np.ones((2, 2), dtype=bool)
    result = _masked_statistics(samples, inside, provider_mask, -9999)
    assert result["valid_pixel_count"] == 3
    assert result["nodata_pixel_count"] == 1
    assert result["outside_aoi_pixel_count"] == 0
    assert result["raw_min"] == 1
    assert result["raw_max"] == 3
    assert result["raw_mean"] == pytest.approx(2)
    assert result["_valid_mask"].tolist() == [[True, True], [True, False]]


def test_masked_statistics_separates_outside_aoi_from_nodata():
    np = pytest.importorskip("numpy")
    samples = np.array([[1, 2], [3, 90]], dtype=np.int16)
    inside = np.array([[True, True], [True, False]])
    provider_mask = np.ones((2, 2), dtype=bool)
    result = _masked_statistics(samples, inside, provider_mask, None)
    assert result["valid_pixel_count"] == 3
    assert result["nodata_pixel_count"] == 0
    assert result["outside_aoi_pixel_count"] == 1
    assert result["raw_mean"] == pytest.approx(2)


def test_masked_statistics_rejects_unsupported_dtype_and_stably_averages_large_finite_values():
    np = pytest.importorskip("numpy")
    inside = np.ones((2, 2), dtype=bool)
    with pytest.raises(ResearchProcessingError, match="dtype"):
        _masked_statistics(np.ones((2, 2), dtype=np.int64), inside, inside, None)
    result = _masked_statistics(
        np.array([[1e308, 1e308], [1e308, 1e308]], dtype=np.float64),
        inside,
        inside,
        None,
    )
    assert result["raw_mean"] == pytest.approx(1e308)



def test_processed_window_digest_commits_to_exact_validity_mask():
    np = pytest.importorskip("numpy")
    from scripts.wapor_cog_aoi import _window_digest

    samples = np.array([[1, 2], [3, -9999]], dtype=np.int16)
    inside = np.ones((2, 2), dtype=bool)
    first_valid = np.array([[True, True], [True, False]])
    second_valid = np.array([[True, False], [True, False]])
    common = {
        "crs": "EPSG:4326",
        "transform": (10, 0.1, 0, 37, 0, -0.1),
        "window": (0, 0, 2, 2),
    }
    first = _window_digest(samples, inside, first_valid, **common)
    second = _window_digest(samples, inside, second_valid, **common)
    assert first != second



def test_preflight_requires_matching_head_and_range_metadata(monkeypatch):
    import scripts.wapor_cog_aoi as runner

    class FakeResponse:
        def __init__(self, status, headers, body=b""):
            self.status = status
            self.headers = headers
            self.body = body

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self, count):
            return self.body[:count]

    class FakeOpener:
        def __init__(self, responses):
            self.responses = iter(responses)

        def open(self, request, timeout):
            return next(self.responses)

    responses = [
        FakeResponse(200, {"Content-Length": "1024", "Content-Type": "image/tiff"}),
        FakeResponse(206, {"Content-Length": "4", "Content-Range": "bytes 0-3/1024"}, b"II*\x00"),
    ]
    monkeypatch.setattr(runner, "build_opener", lambda *args: FakeOpener(responses))
    assert runner._preflight_cog(URL) == 1024


def test_preflight_rejects_range_size_mismatch(monkeypatch):
    import scripts.wapor_cog_aoi as runner

    class FakeResponse:
        def __init__(self, status, headers, body=b""):
            self.status = status
            self.headers = headers
            self.body = body

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self, count):
            return self.body[:count]

    class FakeOpener:
        def __init__(self):
            self.responses = iter([
                FakeResponse(200, {"Content-Length": "1024", "Content-Type": "image/tiff"}),
                FakeResponse(206, {"Content-Length": "4", "Content-Range": "bytes 0-3/2048"}, b"II*\x00"),
            ])

        def open(self, request, timeout):
            return next(self.responses)

    monkeypatch.setattr(runner, "build_opener", lambda *args: FakeOpener())
    with pytest.raises(ResearchProcessingError, match="inconsistent"):
        runner._preflight_cog(URL)



def test_canonical_aoi_hash_enforces_size_even_for_direct_call():
    from scripts.wapor_cog_aoi import _canonical_aoi_hash

    geometry = {
        "type": "Polygon",
        "coordinates": [[
            [10, 36], [11, 36], [11, 37], [10, 37], [10, 36],
        ]],
        "unused_metadata": "x" * (1024 * 1024 + 1),
    }
    with pytest.raises(ResearchProcessingError, match="1 MiB"):
        _canonical_aoi_hash(geometry)


@pytest.mark.parametrize(
    "discovery,key,code,label,expected",
    [
        ({"mapsets": [{"code": "L2-T-D"}], "truncated": False}, "mapsets", "L2-T-D", "mapset catalogue", None),
        ({"mapsets": [], "truncated": False}, "mapsets", "L2-T-D", "mapset catalogue", "not present in the complete"),
        ({"mapsets": [], "truncated": True}, "mapsets", "L2-T-D", "mapset catalogue", "truncated"),
        ({"rasters": [{"code": "WAPOR-3.L2-T-D.2022-01-D1"}], "truncated": False}, "rasters", "WAPOR-3.L2-T-D.2022-01-D1", "raster index", None),
        ({"rasters": [], "truncated": False}, "rasters", "WAPOR-3.L2-T-D.2022-01-D1", "raster index", "not present in the complete"),
        ({"rasters": [], "truncated": True}, "rasters", "WAPOR-3.L2-T-D.2022-01-D1", "raster index", "truncated"),
    ],
)
def test_discovery_absence_is_only_authoritative_when_enumeration_is_complete(
    discovery, key, code, label, expected
):
    from scripts.wapor_cog_aoi import _require_discovered_record

    if expected is None:
        assert _require_discovered_record(
            discovery, key, code, resource_label=label
        ) == discovery[key][0]
    else:
        with pytest.raises(ResearchProcessingError, match=expected):
            _require_discovered_record(discovery, key, code, resource_label=label)

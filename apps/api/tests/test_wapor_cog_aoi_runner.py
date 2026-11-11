from datetime import date

import pytest

from scripts.wapor_cog_aoi import (
    ResearchProcessingError,
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


def test_rejects_non_dekadal_periods_for_first_runner_version():
    with pytest.raises(ResearchProcessingError, match="dekadal"):
        dekadal_period("WAPOR-3.L2-T-M.2024-02")

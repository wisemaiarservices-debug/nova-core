from datetime import date

import numpy as np
import rasterio
from rasterio.io import MemoryFile
from rasterio.transform import from_origin

from scripts import wapor_cog_aoi as runner


MAPSET = "L2-T-D"
RASTER = "WAPOR-3.L2-T-D.2024-02-D1"
URL = (
    "https://storage.googleapis.com/fao-gismgr-wapor-3-data/"
    "DATA/WAPOR-3/MAPSET/L2-T-D/WAPOR-3.L2-T-D.2024-02-D1.tif"
)
AOI = {
    "type": "Polygon",
    "coordinates": [[[0, 2], [2, 2], [2, 4], [0, 4], [0, 2]]],
}


def test_processes_local_cog_window_and_emits_truthful_provenance(monkeypatch):
    samples = np.array(
        [
            [1, 2, 90, 90],
            [3, -9999, 90, 90],
            [80, 80, 80, 80],
            [70, 70, 70, 70],
        ],
        dtype=np.int16,
    )
    memory_file = MemoryFile()
    with memory_file.open(
        driver="GTiff",
        height=4,
        width=4,
        count=1,
        dtype="int16",
        crs="EPSG:4326",
        transform=from_origin(0, 4, 1, 1),
        nodata=-9999,
    ) as dataset:
        dataset.write(samples, 1)

    monkeypatch.setattr(
        runner,
        "list_mapsets",
        lambda: {"mapsets": [{"code": MAPSET, "unit": "mm/day", "caption": "Evapotranspiration"}]},
    )
    monkeypatch.setattr(
        runner,
        "list_rasters",
        lambda code: {
            "rasters": [
                {
                    "code": RASTER,
                    "download_url": URL,
                    "gsutil_uri": "gs://fao-gismgr-wapor-3-data/example.tif",
                    "period_start": "2024-02-01",
                }
            ]
        },
    )
    monkeypatch.setattr(runner, "_preflight_cog", lambda url: 1024)
    monkeypatch.setattr(rasterio, "open", lambda *args, **kwargs: memory_file.open())

    result = runner.process_wapor_aoi(
        MAPSET,
        RASTER,
        AOI,
        processing_code_commit="a" * 40,
    )
    manifest = result["manifest"]

    assert result["status"] == "research_result"
    assert manifest["provider_period_start"] == date(2024, 2, 1).isoformat()
    assert manifest["provider_period_end"] == date(2024, 2, 10).isoformat()
    assert manifest["width"] == 2
    assert manifest["height"] == 2
    assert manifest["source_width"] == 4
    assert manifest["source_height"] == 4
    assert manifest["valid_pixel_count"] == 3
    assert manifest["nodata_pixel_count"] == 1
    assert manifest["outside_aoi_pixel_count"] == 0
    assert manifest["raw_min"] == 1
    assert manifest["raw_max"] == 3
    assert manifest["raw_mean"] == 2
    assert manifest["units"] == "mm/day"
    assert manifest["evidence_class"] == "satellite_derived"
    assert manifest["site_id"] is None
    assert manifest["source_object_sha256"] is None
    assert len(manifest["processed_window_sha256"]) == 64
    assert result["source"]["object_sha256"] is None
    assert "not a field sensor" in " ".join(result["limitations"])

    memory_file.close()

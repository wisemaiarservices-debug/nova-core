"""Versioned catalogue of research datasets available to NOVA.

The catalogue describes source products; it does not imply that they have been
retrieved, persisted, validated for a site, or connected to a field device.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


EvidenceClass = Literal[
    "provider_observation",
    "satellite_derived",
    "reanalysis",
    "gridded_model_product",
    "historical_aggregated",
]


class DatasetVariable(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    code: str = Field(min_length=1, max_length=80)
    label: str = Field(min_length=1, max_length=160)
    unit: str | None = Field(default=None, max_length=48)
    notes: str | None = Field(default=None, max_length=300)


class DatasetRecord(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    dataset_id: str = Field(pattern=r"^[a-z0-9][a-z0-9._-]{1,79}$")
    provider: str = Field(min_length=1, max_length=120)
    title: str = Field(min_length=1, max_length=180)
    version: str = Field(min_length=1, max_length=160)
    status: Literal["integrated", "candidate", "reference_only"]
    evidence_class: EvidenceClass
    domains: list[Literal["agriculture", "water", "solar", "energy", "climate", "land"]]
    access_type: Literal["public_http_api", "public_download", "reference_dataset"]
    authentication_required: bool | None
    source_url: str
    documentation_url: str
    attribution: str
    licence_status: Literal["documented_open", "terms_to_verify", "reference_only"]
    spatial_coverage: str
    spatial_resolution: str
    temporal_coverage: str
    temporal_cadence: str
    variables: list[DatasetVariable]
    limitations: list[str]
    implementation_note: str


_DATASETS: tuple[DatasetRecord, ...] = (
    DatasetRecord(
        dataset_id="nasa-power-daily",
        provider="NASA POWER",
        title="POWER Daily Point meteorology and solar parameters",
        version="Daily API (current provider service; response metadata retained per retrieval)",
        status="integrated",
        evidence_class="gridded_model_product",
        domains=["agriculture", "water", "solar", "climate"],
        access_type="public_http_api",
        authentication_required=False,
        source_url="https://power.larc.nasa.gov/api/temporal/daily/point",
        documentation_url="https://power.larc.nasa.gov/docs/services/api/",
        attribution="NASA POWER Project",
        licence_status="documented_open",
        spatial_coverage="Global; availability and parameter coverage vary",
        spatial_resolution="Gridded product; parameter-specific, not a local station measurement",
        temporal_coverage="Provider-maintained archive; requested dates must be checked against the live response",
        temporal_cadence="Daily",
        variables=[
            DatasetVariable(code="T2M", label="2 m air temperature", unit="°C"),
            DatasetVariable(code="T2M_MAX", label="Daily maximum 2 m air temperature", unit="°C"),
            DatasetVariable(code="T2M_MIN", label="Daily minimum 2 m air temperature", unit="°C"),
            DatasetVariable(code="RH2M", label="2 m relative humidity", unit="%"),
            DatasetVariable(code="PRECTOTCORR", label="Corrected precipitation", unit="mm/day"),
            DatasetVariable(code="WS10M", label="10 m wind speed", unit="m/s"),
            DatasetVariable(code="ALLSKY_SFC_SW_DWN", label="All-sky surface shortwave downward radiation", unit="kWh/m²/day"),
        ],
        limitations=[
            "Gridded/model and satellite-derived product; not a field sensor or weather-station observation.",
            "Parameter values may contain provider fill values and require quality checks.",
            "Daily aggregates must not be interpreted as instantaneous measurements.",
        ],
        implementation_note="Existing read-only API integration; retrieval is not persistent storage or site registration.",
    ),
    DatasetRecord(
        dataset_id="jrc-pvgis-6",
        provider="European Commission Joint Research Centre",
        title="Photovoltaic Geographical Information System (PVGIS) API",
        version="PVGIS 6 beta; provider announced beta in June 2026 and expected full version in 2027",
        status="candidate",
        evidence_class="gridded_model_product",
        domains=["solar", "energy", "climate"],
        access_type="public_http_api",
        authentication_required=False,
        source_url="https://photovoltaic-geographical-information-system.ec.europa.eu/",
        documentation_url="https://joint-research-centre.ec.europa.eu/photovoltaic-geographical-information-system-pvgis/using-pvgis-6/using-pvgis_en",
        attribution="European Commission Joint Research Centre (JRC), PVGIS",
        licence_status="terms_to_verify",
        spatial_coverage="Global land coverage subject to endpoint/product availability",
        spatial_resolution="Location-based model output; underlying solar and meteorological grids vary by product",
        temporal_coverage="PVGIS 6 release notes report time series extended through 2025",
        temporal_cadence="Hourly, monthly, annual, or typical meteorological year depending on endpoint",
        variables=[
            DatasetVariable(code="solar_irradiation", label="Solar irradiation", unit="endpoint-defined"),
            DatasetVariable(code="pv_energy", label="Modelled photovoltaic energy", unit="endpoint-defined"),
            DatasetVariable(code="temperature", label="Meteorological temperature", unit="endpoint-defined"),
        ],
        limitations=[
            "PV output is a model estimate, not measured inverter production or a verified plant baseline.",
            "PVGIS 6 is beta; provider notes changed request methods and response schemas during 2026.",
            "Connector must pin endpoint/schema and test current OpenAPI before use; do not silently fall back to PVGIS 5.",
        ],
        implementation_note="Candidate only; no connector or retrieval job is implemented.",
    ),
    DatasetRecord(
        dataset_id="fao-wapor-v3",
        provider="Food and Agriculture Organization of the United Nations",
        title="WaPOR v3 water productivity database",
        version="WaPOR v3",
        status="candidate",
        evidence_class="satellite_derived",
        domains=["agriculture", "water", "land"],
        access_type="public_http_api",
        authentication_required=False,
        source_url="https://wapor.apps.fao.org/",
        documentation_url="https://www.fao.org/in-action/remote-sensing-for-water-productivity/wapor-data-access/en",
        attribution="FAO WaPOR; cite the specific layer and version used",
        licence_status="terms_to_verify",
        spatial_coverage="Level 1: global at approximately 300 m; Level 2: Africa and Near East at approximately 100 m; Level 3: selected irrigation schemes/sub-basins at approximately 20 m. Layer availability must be checked in the live catalogue.",
        spatial_resolution="Level-dependent: approximately 300 m (L1), 100 m (L2), 20 m (L3); individual layer metadata is authoritative",
        temporal_coverage="Layer-specific archive; FAO reports WaPOR v3 L1/L2 coverage from 2018 onward, subject to layer availability",
        temporal_cadence="Daily, dekadal, monthly, seasonal or annual depending on the layer",
        variables=[
            DatasetVariable(code="AETI", label="Actual evapotranspiration and interception", unit="layer-defined"),
            DatasetVariable(code="RET", label="Reference evapotranspiration", unit="layer-defined"),
            DatasetVariable(code="NPP", label="Net primary production", unit="layer-defined"),
            DatasetVariable(code="E", label="Evaporation", unit="layer-defined"),
            DatasetVariable(code="T", label="Transpiration", unit="layer-defined"),
            DatasetVariable(code="I", label="Interception", unit="layer-defined"),
        ],
        limitations=[
            "Satellite-derived and model-processed geospatial products, not direct field measurements.",
            "Coverage, resolution, units, processing latency and temporal aggregation differ by layer and level.",
            "WaPOR v3 API access is documented by FAO as requiring no API token or credentials; legacy v2 instructions requesting tokens are not applicable.",
            "Layer metadata, methodology, licence terms and attribution must be captured for each retrieval.",
            "Near-real-time dekadal products may later be replaced by final quality-improved products.",
        ],
        implementation_note="Candidate; read-only mapset/raster-index discovery is implemented. GeoTIFF retrieval, pixel processing, persistence and site linkage are not implemented.",
    ),
    DatasetRecord(
        dataset_id="copernicus-era5-land",
        provider="Copernicus Climate Change Service / ECMWF",
        title="ERA5 and ERA5-Land reanalysis",
        version="Provider-maintained ERA5 / ERA5-Land products",
        status="candidate",
        evidence_class="reanalysis",
        domains=["agriculture", "water", "energy", "climate"],
        access_type="public_download",
        authentication_required=True,
        source_url="https://cds.climate.copernicus.eu/",
        documentation_url="https://confluence.ecmwf.int/display/CKB/ERA5%3A+data+documentation",
        attribution="Copernicus Climate Change Service (C3S), implemented by ECMWF",
        licence_status="terms_to_verify",
        spatial_coverage="Global",
        spatial_resolution="ERA5 approximately 0.25°; ERA5-Land approximately 9 km",
        temporal_coverage="Provider-maintained historical reanalysis; verify requested product availability",
        temporal_cadence="Hourly native product; aggregated products also available",
        variables=[
            DatasetVariable(code="2m_temperature", label="2 m air temperature", unit="K"),
            DatasetVariable(code="total_precipitation", label="Total precipitation", unit="m"),
            DatasetVariable(code="surface_solar_radiation_downwards", label="Surface solar radiation downwards", unit="J/m²"),
        ],
        limitations=[
            "Reanalysis is a model-data synthesis, not a direct station observation.",
            "ERA5 and ERA5-Land have different grids, variable availability and land representation.",
            "Access workflow, licence and attribution must be checked for each downloaded product.",
        ],
        implementation_note="Candidate batch connector; no credentials or downloads are configured.",
    ),
    DatasetRecord(
        dataset_id="copernicus-sentinel-2",
        provider="Copernicus / European Space Agency",
        title="Sentinel-2 multispectral optical imagery",
        version="Sentinel-2 mission product collection; processing baseline must be recorded per item",
        status="candidate",
        evidence_class="satellite_derived",
        domains=["agriculture", "land", "water"],
        access_type="public_download",
        authentication_required=None,
        source_url="https://dataspace.copernicus.eu/",
        documentation_url="https://sentinels.copernicus.eu/web/sentinel/user-guides/sentinel-2-msi",
        attribution="Copernicus Sentinel data, processed by ESA",
        licence_status="terms_to_verify",
        spatial_coverage="Global land coverage with acquisition, cloud and product-availability constraints",
        spatial_resolution="10 m, 20 m and 60 m bands depending on spectral band",
        temporal_coverage="Mission archive; item-level acquisition dates and processing baselines required",
        temporal_cadence="Nominal revisit depends on latitude, constellation and acquisition availability",
        variables=[
            DatasetVariable(code="B04", label="Red band", unit="reflectance"),
            DatasetVariable(code="B08", label="Near-infrared band", unit="reflectance"),
            DatasetVariable(code="SCL", label="Scene classification layer", unit="class"),
        ],
        limitations=[
            "Optical observations are affected by clouds, haze, shadows and acquisition timing.",
            "Vegetation indices are derived features and are not direct crop-yield or plant-health measurements.",
            "Record product level, processing baseline, cloud mask and pixel quality for reproducibility.",
        ],
        implementation_note="Candidate geospatial/batch pipeline; no imagery is currently ingested.",
    ),
    DatasetRecord(
        dataset_id="open-power-system-data",
        provider="Open Power System Data",
        title="Open Power System Data time series",
        version="Dataset release and package version must be pinned per analysis",
        status="reference_only",
        evidence_class="historical_aggregated",
        domains=["energy"],
        access_type="public_download",
        authentication_required=False,
        source_url="https://open-power-system-data.org/",
        documentation_url="https://data.open-power-system-data.org/",
        attribution="Open Power System Data",
        licence_status="terms_to_verify",
        spatial_coverage="Primarily European electricity-system datasets; not a Tunisia telemetry source",
        spatial_resolution="Country/system level and dataset-dependent",
        temporal_coverage="Historical archive; dataset-specific",
        temporal_cadence="Hourly or other dataset-specific intervals",
        variables=[
            DatasetVariable(code="load", label="Electricity load", unit="MW"),
            DatasetVariable(code="generation", label="Electricity generation by source", unit="MW"),
        ],
        limitations=[
            "Not a Tunisia-specific source and not live telemetry.",
            "Dataset coverage, country definitions and revisions differ across releases.",
            "Do not use as a substitute for NeoGrid site meter or inverter measurements.",
        ],
        implementation_note="Research benchmark/reference only until a relevant dataset and scope are selected.",
    ),
)


def list_datasets(domain: str | None = None) -> list[DatasetRecord]:
    """Return immutable catalogue records, optionally filtered by domain."""
    normalized = domain.strip().lower() if domain else None
    if normalized and normalized not in {"agriculture", "water", "solar", "energy", "climate", "land"}:
        raise ValueError("unsupported dataset domain")
    records = _DATASETS
    if normalized:
        records = tuple(record for record in records if normalized in record.domains)
    return list(records)


def catalogue_summary() -> dict[str, int]:
    return {
        "total": len(_DATASETS),
        "integrated": sum(item.status == "integrated" for item in _DATASETS),
        "candidate": sum(item.status == "candidate" for item in _DATASETS),
        "reference_only": sum(item.status == "reference_only" for item in _DATASETS),
    }

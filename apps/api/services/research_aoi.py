"""Structural validation for explicitly supplied WGS84 research AOIs.

This is not a topology engine: it validates GeoJSON ring structure and bounds,
but does not prove polygon non-self-intersection or perform raster clipping.
"""
from __future__ import annotations

import math
from typing import Any

MAX_POLYGONS = 20
MAX_RINGS_PER_POLYGON = 100
MAX_POSITIONS = 10_000


class AOIValidationError(ValueError):
    """Raised when a caller-supplied research area is malformed or unbounded."""


def validate_research_aoi(geometry: dict[str, Any]) -> dict[str, Any]:
    """Validate a GeoJSON Polygon/MultiPolygon in longitude/latitude order."""
    if not isinstance(geometry, dict):
        raise AOIValidationError("AOI must be a GeoJSON geometry object")
    kind = geometry.get("type")
    coordinates = geometry.get("coordinates")
    if kind == "Polygon":
        polygons = [coordinates]
    elif kind == "MultiPolygon":
        polygons = coordinates
    else:
        raise AOIValidationError("Only GeoJSON Polygon and MultiPolygon AOIs are supported")
    if not isinstance(polygons, list) or not polygons or len(polygons) > MAX_POLYGONS:
        raise AOIValidationError("AOI polygon count is empty or exceeds the supported limit")

    positions = 0
    longitudes: list[float] = []
    latitudes: list[float] = []
    ring_count = 0

    for polygon in polygons:
        if not isinstance(polygon, list) or not polygon or len(polygon) > MAX_RINGS_PER_POLYGON:
            raise AOIValidationError("Each polygon must contain a bounded exterior ring and optional holes")
        for ring in polygon:
            ring_count += 1
            if not isinstance(ring, list) or len(ring) < 4:
                raise AOIValidationError("Each linear ring must contain at least four positions")
            if ring[0] != ring[-1]:
                raise AOIValidationError("GeoJSON linear rings must be closed")
            numeric_ring: list[tuple[float, float]] = []
            for position in ring:
                positions += 1
                if positions > MAX_POSITIONS:
                    raise AOIValidationError("AOI exceeds the 10,000-position limit")
                if (
                    not isinstance(position, (list, tuple))
                    or len(position) != 2
                    or any(isinstance(value, bool) or not isinstance(value, (int, float)) for value in position)
                ):
                    raise AOIValidationError("AOI positions must be two-dimensional numeric [longitude, latitude]")
                longitude, latitude = float(position[0]), float(position[1])
                if not math.isfinite(longitude) or not math.isfinite(latitude):
                    raise AOIValidationError("AOI coordinates must be finite")
                if not -180 <= longitude <= 180 or not -90 <= latitude <= 90:
                    raise AOIValidationError("AOI coordinates fall outside WGS84 longitude/latitude bounds")
                numeric_ring.append((longitude, latitude))
                longitudes.append(longitude)
                latitudes.append(latitude)
            if any(numeric_ring[i] == numeric_ring[i - 1] for i in range(1, len(numeric_ring))):
                raise AOIValidationError("AOI ring contains consecutive duplicate positions")
            if any(abs(numeric_ring[i][0] - numeric_ring[i - 1][0]) > 180 for i in range(1, len(numeric_ring))):
                raise AOIValidationError("Antimeridian-crossing AOIs require a separately normalized geometry")
            twice_area = sum(
                numeric_ring[i - 1][0] * numeric_ring[i][1] - numeric_ring[i][0] * numeric_ring[i - 1][1]
                for i in range(1, len(numeric_ring))
            )
            if abs(twice_area) < 1e-12:
                raise AOIValidationError("AOI ring has zero planar area in longitude/latitude coordinates")

    return {
        "status": "structurally_valid",
        "geometry_type": kind,
        "crs": "OGC:CRS84 (WGS84 longitude/latitude coordinate order)",
        "bbox": [min(longitudes), min(latitudes), max(longitudes), max(latitudes)],
        "polygon_count": len(polygons),
        "ring_count": ring_count,
        "position_count": positions,
        "site_id": None,
        "limitations": [
            "This validates GeoJSON structure and coordinate bounds, not polygon topology or self-intersections.",
            "No area calculation, raster intersection, clipping, reprojection or zonal statistics are performed.",
            "The AOI is caller-supplied research geometry and is not a registered customer site or pilot location.",
            "Antimeridian-crossing geometries must be normalized before submission.",
        ],
    }

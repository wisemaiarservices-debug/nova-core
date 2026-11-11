# NOVA research-area geometry validation

`apps/api/services/research_aoi.py` validates caller-supplied GeoJSON Polygon and MultiPolygon geometry for bounded research workflows.

## Contract

- Requires WGS84 longitude/latitude coordinate order (OGC:CRS84).
- Accepts two-dimensional finite numeric positions only.
- Enforces longitude [-180, 180], latitude [-90, 90], closed rings, nonzero planar ring area, no consecutive duplicate positions, and no unnormalized antimeridian crossing.
- Bounds input to 20 polygons, 100 rings per polygon and 10,000 positions.
- Returns a derived bounding box and structural counts. It does not assign a site ID.

## Explicit limitations

This is structural validation, not a complete computational-geometry validity test. It does not detect every self-intersection, validate hole containment or ring topology, calculate geodesic area, reproject, intersect with rasters, clip pixels, or compute zonal statistics. Do not treat `structurally_valid` as proof of topological validity or scientific suitability.

The geometry is an explicitly supplied research AOI, not an approved pilot/customer site. It must not create or populate the NOVA Core site/asset/source registry.

## Next steps

Use a maintained geometry engine only after checking dependency/runtime compatibility and license implications. Then validate topology, CRS, raster footprint intersection, pixel-count budgets and study-area-specific layer coverage before clipping or zonal calculations.

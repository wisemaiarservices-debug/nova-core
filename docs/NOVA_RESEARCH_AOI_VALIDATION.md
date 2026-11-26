# NOVA research-area geometry validation

`apps/api/services/research_aoi.py` validates explicitly caller-supplied GeoJSON Polygon and MultiPolygon geometry for bounded research workflows.

## Structural contract

- Requires WGS84 longitude/latitude coordinate order (OGC:CRS84); legacy GeoJSON `crs` overrides are rejected.
- Accepts two-dimensional finite numeric positions only; booleans and values that overflow float conversion are rejected.
- Enforces longitude [-180, 180], latitude [-90, 90], normalized ring closure, at least three distinct vertices, no consecutive duplicates, nonzero planar ring area, and no unnormalized antimeridian crossing.
- Bounds input to 20 polygons, 100 rings per polygon and 10,000 total positions.
- Returns a bounding box derived from coordinates and structural counts. It does not trust a caller-supplied bbox.
- Does not assign a site ID.

## Explicit limitations

This is structural validation, not a complete computational-geometry validity test. It does not detect every self-intersection, validate hole containment or ring orientation, detect overlapping MultiPolygon components, calculate geodesic area, reproject, intersect with rasters, clip pixels, or compute zonal statistics. Do not treat `structurally_valid` as proof of topological validity or scientific suitability.

The planar ring-area check is only a degeneracy check in longitude/latitude coordinate space; it is not a physical area calculation. Tiny but nonzero valid rings are accepted. Antimeridian-crossing geometries must be normalized before submission.

The geometry is an explicitly supplied research AOI, not an approved pilot/customer site. It must not create or populate the NOVA Core site/asset/source registry.

## Next steps

Use a maintained geometry engine only after checking dependency/runtime compatibility and license implications. Then validate topology, CRS, raster footprint intersection, pixel-count budgets and study-area-specific layer coverage before clipping or zonal calculations.

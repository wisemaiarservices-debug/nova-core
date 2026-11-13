# Irrigation-zone spatial evidence

Irrigation zones may carry a GeoJSON `boundary` with an explicit CRS. The structural configuration validator checks its Polygon or MultiPolygon ring structure; spatial sample assessment currently accepts only EPSG:4326 / OGC CRS84 and does not reproject coordinates.

`assessIrrigationSpatialCoverage(payload)` reports geometric relationships between soil samples in the zone's explicitly linked `soil_profile_id` and the zone polygon. Each sample is classified as `inside`, `outside`, `boundary_ambiguous`, or `unlocated`. Polygon holes and MultiPolygon components are respected. Points on outer or hole boundaries are not silently treated as inside.

The result includes counts and the number of distinct valid coordinate pairs. It deliberately does not calculate sampling density, infer sample representativeness, interpolate soil properties, or establish that a profile characterizes the zone. No universal sampling-adequacy threshold is imposed. A zone without a supported boundary, linked profile, or valid sample coordinates remains `spatial_coverage_unassessed`.

This is a deterministic geometry relationship only—not an agronomic interpretation, irrigation schedule, engineering approval, or operational recommendation. Coordinate accuracy, datum provenance, boundary survey quality, sample collection protocol, and spatial representativeness require independent verification.

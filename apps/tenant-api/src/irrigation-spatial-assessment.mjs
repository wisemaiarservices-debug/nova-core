const GEOGRAPHIC_CRS = new Set(["EPSG:4326", "URN:OGC:DEF:CRS:OGC:1.3:CRS84", "OGC:CRS84"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function geometryOf(boundary) {
  if (!isObject(boundary) || typeof boundary.crs !== "string" ||
      !GEOGRAPHIC_CRS.has(boundary.crs.trim().toUpperCase())) return null;
  const geometry = boundary.type === "Feature" ? boundary.geometry : boundary;
  if (!isObject(geometry) || !["Polygon", "MultiPolygon"].includes(geometry.type) ||
      !Array.isArray(geometry.coordinates)) return null;
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  if (!polygons.length) return null;
  for (const polygon of polygons) {
    if (!Array.isArray(polygon) || polygon.length === 0) return null;
    for (const ring of polygon) {
      if (!Array.isArray(ring) || ring.length < 4 ||
          ring.some(point => !Array.isArray(point) || point.length < 2 ||
            !Number.isFinite(point[0]) || !Number.isFinite(point[1]) ||
            point[0] < -180 || point[0] > 180 || point[1] < -90 || point[1] > 90) ||
          ring[0][0] !== ring[ring.length - 1][0] ||
          ring[0][1] !== ring[ring.length - 1][1]) return null;
      const unique = new Set(ring.slice(0, -1).map(point => point[0] + "," + point[1]));
      if (unique.size < 3) return null;
    }
  }
  return polygons;
}

function onSegment(point, a, b) {
  const cross = (point[1] - a[1]) * (b[0] - a[0]) -
    (point[0] - a[0]) * (b[1] - a[1]);
  const scale = Math.max(1, Math.abs(a[0]), Math.abs(a[1]), Math.abs(b[0]), Math.abs(b[1]));
  if (Math.abs(cross) > Number.EPSILON * 16 * scale * scale) return false;
  return point[0] >= Math.min(a[0], b[0]) - Number.EPSILON * scale * 16 &&
    point[0] <= Math.max(a[0], b[0]) + Number.EPSILON * scale * 16 &&
    point[1] >= Math.min(a[1], b[1]) - Number.EPSILON * scale * 16 &&
    point[1] <= Math.max(a[1], b[1]) + Number.EPSILON * scale * 16;
}

function ringRelation(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i];
    if (onSegment(point, a, b)) return "boundary";
    if ((a[1] > point[1]) !== (b[1] > point[1]) &&
        point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) {
      inside = !inside;
    }
  }
  return inside ? "inside" : "outside";
}

function pointRelation(point, polygons) {
  let boundary = false;
  for (const polygon of polygons) {
    const outer = ringRelation(point, polygon[0]);
    if (outer === "boundary") { boundary = true; continue; }
    if (outer !== "inside") continue;
    let inHole = false;
    let holeBoundary = false;
    for (const hole of polygon.slice(1)) {
      const relation = ringRelation(point, hole);
      if (relation === "boundary") holeBoundary = true;
      if (relation === "inside") inHole = true;
    }
    if (holeBoundary) boundary = true;
    else if (!inHole) return "inside";
  }
  return boundary ? "boundary_ambiguous" : "outside";
}

/**
 * Reports only geometric relationships between located soil samples and
 * explicitly linked irrigation-zone polygons. It does not infer representativeness.
 */
export function assessIrrigationSpatialCoverage(payload) {
  const systems = Array.isArray(payload?.site?.irrigation_systems)
    ? payload.site.irrigation_systems : [];
  const profiles = Array.isArray(payload?.site?.soil_profiles)
    ? payload.site.soil_profiles : [];
  const zones = [];
  for (const system of systems) {
    if (!isObject(system) || !Array.isArray(system.zones)) continue;
    for (const zone of system.zones) {
      if (!isObject(zone)) continue;
      const path = "site.irrigation_systems/" + system.id + "/zones/" + zone.id;
      const polygons = geometryOf(zone.boundary);
      const profile = profiles.find(item => isObject(item) && item.id === zone.soil_profile_id);
      const samples = profile && Array.isArray(profile.samples) ? profile.samples : [];
      if (!polygons || !profile || !samples.length) {
        zones.push(Object.freeze({
          irrigation_system_id: system.id, zone_id: zone.id,
          soil_profile_id: zone.soil_profile_id ?? null,
          status: "spatial_coverage_unassessed",
          reason: !polygons ? "valid_epsg4326_zone_boundary_required" :
            !profile ? "linked_soil_profile_required" : "soil_samples_required",
          counts: Object.freeze({ inside_zone: 0, outside_zone: 0, boundary_ambiguous: 0, unlocated: 0, unique_locations: 0 }),
          samples: Object.freeze([]),
          path,
        }));
        continue;
      }
      const counts = { inside_zone: 0, outside_zone: 0, boundary_ambiguous: 0, unlocated: 0 };
      const locations = new Set();
      const assessed = samples.map((sample, index) => {
        const point = sample?.sampling_point;
        let relation = "unlocated";
        if (isObject(point) && point.crs === "EPSG:4326" &&
            Array.isArray(point.coordinates) && point.coordinates.length === 2 &&
            point.coordinates.every(Number.isFinite) &&
            point.coordinates[0] >= -180 && point.coordinates[0] <= 180 &&
            point.coordinates[1] >= -90 && point.coordinates[1] <= 90) {
          relation = pointRelation(point.coordinates, polygons);
          locations.add(point.coordinates[0] + "," + point.coordinates[1]);
        }
        counts[relation === "inside" ? "inside_zone" :
          relation === "outside" ? "outside_zone" :
          relation === "boundary_ambiguous" ? "boundary_ambiguous" : "unlocated"]++;
        return Object.freeze({ sample_id: sample?.id ?? null, relation });
      });
      const located = counts.inside_zone + counts.outside_zone + counts.boundary_ambiguous;
      zones.push(Object.freeze({
        irrigation_system_id: system.id, zone_id: zone.id,
        soil_profile_id: profile.id,
        status: located > 0 ? "geometric_relationships_assessed" : "spatial_coverage_unassessed",
        reason: located > 0 ? null : "no_valid_sample_coordinates",
        counts: Object.freeze({ ...counts, unique_locations: locations.size }),
        samples: Object.freeze(assessed),
        path,
      }));
    }
  }
  return Object.freeze({
    status: zones.length ? "assessed_with_limits" : "spatial_coverage_unassessed",
    zones: Object.freeze(zones),
    limitations: Object.freeze([
      "point_in_polygon_is_a_geometry_relation_only",
      "sample_inside_zone_does_not_establish_spatial_representativeness",
      "no_sampling_density_or_adequacy_threshold_is_inferred",
      "no_reprojection_or_coordinate_transformation_is_performed",
      "no_agronomic_or_irrigation_recommendation_is_made",
    ]),
  });
}

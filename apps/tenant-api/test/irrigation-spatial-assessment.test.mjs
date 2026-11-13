import test from "node:test";
import assert from "node:assert/strict";
import { assessIrrigationSpatialCoverage } from "../src/irrigation-spatial-assessment.mjs";

const square = {
  type: "Polygon", crs: "EPSG:4326",
  coordinates: [[[0,0],[4,0],[4,4],[0,4],[0,0]]],
};
function payload({ boundary = square, points = [[1,1]], holes = false, crs = "EPSG:4326" } = {}) {
  const polygon = holes ? { ...square, coordinates: [
    square.coordinates[0], [[1.5,1.5],[2.5,1.5],[2.5,2.5],[1.5,2.5],[1.5,1.5]],
  ] } : { ...boundary, crs };
  return {
    site: {
      soil_profiles: [{ id: "soil-1", samples: points.map((coordinates, i) => ({
        id: "sample-" + i,
        ...(coordinates ? { sampling_point: { crs: "EPSG:4326", coordinates } } : {}),
      })) }],
      irrigation_systems: [{ id: "system-1", zones: [{
        id: "zone-1", soil_profile_id: "soil-1", boundary: polygon,
      }] }],
    },
  };
}

test("classifies samples inside, outside and on the zone boundary without claiming representativeness", () => {
  const result = assessIrrigationSpatialCoverage(payload({
    points: [[1,1],[5,5],[0,2],[3,3]],
  }));
  const zone = result.zones[0];
  assert.equal(zone.status, "geometric_relationships_assessed");
  assert.deepEqual(zone.counts, {
    inside_zone: 2, outside_zone: 1, boundary_ambiguous: 1,
    unlocated: 0, unique_locations: 4,
  });
  assert.ok(result.limitations.includes("sample_inside_zone_does_not_establish_spatial_representativeness"));
});

test("respects polygon holes and multipolygon components", () => {
  const withHole = assessIrrigationSpatialCoverage(payload({
    holes: true, points: [[1,1],[2,2],[5,5]],
  }));
  assert.deepEqual(withHole.zones[0].samples.map(x => x.relation),
    ["inside", "outside", "outside"]);
  const multi = {
    type: "MultiPolygon", crs: "EPSG:4326",
    coordinates: [
      square.coordinates,
      [[[10,10],[12,10],[12,12],[10,12],[10,10]]],
    ],
  };
  const result = assessIrrigationSpatialCoverage(payload({
    boundary: multi, points: [[11,11],[5,5]],
  }));
  assert.deepEqual(result.zones[0].samples.map(x => x.relation), ["inside", "outside"]);
});

test("marks missing or unsupported geometry and unlocated samples as unassessed", () => {
  const missingBoundary = payload();
  delete missingBoundary.site.irrigation_systems[0].zones[0].boundary;
  assert.equal(assessIrrigationSpatialCoverage(missingBoundary).zones[0].status,
    "spatial_coverage_unassessed");
  const projected = assessIrrigationSpatialCoverage(payload({ crs: "EPSG:3857" }));
  assert.equal(projected.zones[0].reason, "valid_epsg4326_zone_boundary_required");
  const unlocated = assessIrrigationSpatialCoverage(payload({ points: [null] }));
  assert.equal(unlocated.zones[0].counts.unlocated, 1);
  assert.equal(unlocated.zones[0].status, "spatial_coverage_unassessed");
});

test("requires a linked soil profile and never counts invalid coordinates as located", () => {
  const noProfile = payload();
  noProfile.site.irrigation_systems[0].zones[0].soil_profile_id = "missing";
  assert.equal(assessIrrigationSpatialCoverage(noProfile).zones[0].reason,
    "linked_soil_profile_required");
  const invalid = assessIrrigationSpatialCoverage(payload({ points: [[181,0]] }));
  assert.equal(invalid.zones[0].counts.unlocated, 1);
});

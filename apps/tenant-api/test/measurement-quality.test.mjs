import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { registerMeasurementQualityPolicy, reviewMeasurementQualityPolicy, assessMeasurementQuality } from "../src/measurement-quality.mjs";
globalThis.crypto ??= webcrypto;
function dbFixture({observation={id:"obs-1",site_id:"site-1",source_id:"source-1",metric:"temperature",value:22,unit:"degC",observed_at:"2026-06-01T10:00:00Z",verification_status:"verified",provenance_json:"{}"},mapping=[{id:"map-1",asset_id:"asset-1",sensor_id:"sensor-1",parameter:"temperature",unit:"degC"}],calibration=[{id:"cal-1",calibrated_at:"2026-01-01T00:00:00Z",valid_until:"2026-12-01T00:00:00Z",uncertainty:null}],policy=[{id:"policy-1",minimum_value:0,maximum_value:40,version:"v1"}]}={}){
 const calls=[];
 return {calls,prepare(sql){return {sql,values:[],bind(...v){this.values=v;return this;},async all(){
  if(sql.includes("FROM assets"))return {results:[{id:"asset-1"}]};
  if(sql.includes("FROM measurement_quality_assessments WHERE"))return {results:[]};
  if(sql.includes("FROM observations WHERE"))return {results:observation?[observation]:[]};
  if(sql.includes("FROM sensor_source_identity_mappings m JOIN"))return {results:mapping};
  if(sql.includes("FROM sensor_calibrations c JOIN"))return {results:calibration};
  if(sql.includes("FROM measurement_quality_policies p JOIN"))return {results:policy};
  if(sql.includes("FROM measurement_quality_policies WHERE"))return {results:[{id:"policy-1",registered_by_subject:"author"}]};
  if(sql.includes("FROM observation_reviewers"))return {results:[{reviewer_subject:"reviewer"}]};
  if(sql.includes("FROM measurement_quality_policy_events"))return {results:[]};
  throw Error("unhandled query: "+sql);
 },async run(){calls.push({sql,values:this.values});return {meta:{changes:1}};}};}};
}
const policyBody={id:"policy-1",sensor_id:"sensor-1",parameter:"temperature",unit:"degC",version:"v1",minimum_value:0,maximum_value:40,effective_from:"2026-01-01T00:00:00Z",method:"approved operating envelope",evidence_ref:"spec-1"};
test("policy registration accepts explicit scoped bounds and remains unverified",async()=>{
 const db=dbFixture();const r=await registerMeasurementQualityPolicy(db,"tenant-1","site-1","asset-1","author",policyBody);
 assert.equal(r.status,201);assert.equal(r.data.status,"registered_unverified");assert.equal(db.calls.length,1);
});
test("policy registration rejects absent, inverted or non-finite limits",async()=>{
 for(const body of [{...policyBody,minimum_value:undefined,maximum_value:undefined},{...policyBody,minimum_value:50,maximum_value:40},{...policyBody,minimum_value:NaN}]) {
  const r=await registerMeasurementQualityPolicy(dbFixture(),"tenant-1","site-1","asset-1","author",body);
  assert.equal(r.status,400);
 }
});
test("policy submitter cannot approve own policy",async()=>{
 const r=await reviewMeasurementQualityPolicy(dbFixture(),"tenant-1","site-1","asset-1","policy-1","author","req-1",{decision:"verify",evidence_ref:"spec-1"});
 assert.equal(r.error,"policy_submitter_cannot_review");
});
test("verified observation with exact mapping, current verified calibration and approved policy passes",async()=>{
 const r=await assessMeasurementQuality(dbFixture(),"tenant-1","obs-1","req-1");
 assert.equal(r.status,201);assert.equal(r.data.status,"passed");assert.equal(r.data.reason_code,"within_approved_policy_bounds");
});
test("out-of-policy measurement fails without changing the observation",async()=>{
 const db=dbFixture({observation:{id:"obs-1",site_id:"site-1",source_id:"source-1",metric:"temperature",value:41,unit:"degC",observed_at:"2026-06-01T10:00:00Z",verification_status:"verified",provenance_json:"{}"}});
 const r=await assessMeasurementQuality(db,"tenant-1","obs-1","req-1");
 assert.equal(r.data.status,"failed");assert.equal(r.data.reason_code,"outside_approved_policy_bounds");
 assert.equal(db.calls.length,1);assert.match(db.calls[0].sql,/INSERT INTO measurement_quality_assessments/);
});
test("unverified observation is never assessed against policy",async()=>{
 const db=dbFixture({observation:{id:"obs-1",site_id:"site-1",source_id:"source-1",metric:"temperature",value:22,unit:"degC",observed_at:"2026-06-01T10:00:00Z",verification_status:"unverified",provenance_json:"{}"}});
 const r=await assessMeasurementQuality(db,"tenant-1","obs-1","req-1");
 assert.equal(r.data.status,"not_assessed");assert.equal(r.data.reason_code,"observation_not_verified");
});
test("missing or ambiguous sensor mapping remains not assessed",async()=>{
 for(const mapping of [[],[{},{}]]) {
  const r=await assessMeasurementQuality(dbFixture({mapping}),"tenant-1","obs-1","req-1");
  assert.equal(r.data.status,"not_assessed");
 }
});
test("synthetic provenance is not promoted to field measurement quality",async()=>{
 const db=dbFixture({observation:{id:"obs-1",site_id:"site-1",source_id:"source-1",metric:"temperature",value:22,unit:"degC",observed_at:"2026-06-01T10:00:00Z",verification_status:"verified",provenance_json:'{"provenance_class":"synthetic"}'}});
 const r=await assessMeasurementQuality(db,"tenant-1","obs-1","req-1");
 assert.equal(r.data.status,"not_assessed");assert.equal(r.data.reason_code,"non_field_evidence");
});

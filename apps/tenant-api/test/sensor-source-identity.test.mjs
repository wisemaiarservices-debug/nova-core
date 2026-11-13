import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { registerSensorSourceMapping, reviewSensorSourceMapping, resolveVerifiedSensorSourceMapping } from "../src/sensor-source-identity.mjs";
globalThis.crypto ??= webcrypto;
function dbFixture({owner="admin",reviewer="reviewer",history=[],matches=[]}={}){
 const calls=[];
 return {calls,prepare(sql){return {sql,values:[],bind(...v){this.values=v;return this;},async all(){
  if(sql.includes("FROM assets"))return {results:[{id:"asset-1"}]};
  if(sql.includes("FROM sources"))return {results:[{id:"source-1",site_id:"site-1"}]};
  if(sql.includes("FROM sensor_source_identity_mappings WHERE"))return {results:[{id:"map-1",source_id:"source-1",registered_by_subject:owner}]};
  if(sql.includes("FROM sensor_source_mapping_reviewers"))return {results:[{reviewer_subject:reviewer}]};
  if(sql.includes("FROM sensor_source_identity_mappings m JOIN"))return {results:matches};
  if(sql.includes("FROM sensor_source_mapping_events"))return {results:history};
  throw Error(sql);
 },async run(){calls.push({sql,values:this.values});return {meta:{changes:1}};}};},async batch(stmts){calls.push(...stmts.map(x=>({sql:x.sql,values:x.values})));return stmts.map(()=>({meta:{changes:1}}));}};
}
const mapping={id:"map-1",source_id:"source-1",sensor_id:"sensor-7",parameter:"air_temperature",unit:"degC",effective_from:"2026-01-01T00:00:00.000Z",mapping_method:"commissioning inspection",evidence_ref:"evidence-7"};
test("mapping registration requires exact explicit identity fields and writes immutable record plus audit",async()=>{
 const db=dbFixture();const r=await registerSensorSourceMapping(db,"tenant-1","site-1","asset-1","admin","req-1",mapping);
 assert.equal(r.status,201);assert.equal(r.data.status,"registered_unverified");assert.equal(db.calls.length,1);
});
test("mapping registration rejects ambiguous or malformed effective dates",async()=>{
 const r=await registerSensorSourceMapping(dbFixture(),"tenant-1","site-1","asset-1","admin","req-1",{...mapping,effective_from:"yesterday"});
 assert.equal(r.error,"sensor_source_mapping_request_invalid");
});
test("mapping submitter cannot independently verify their own mapping",async()=>{
 const r=await reviewSensorSourceMapping(dbFixture(),"tenant-1","site-1","asset-1","map-1","admin","req-1",{decision:"verify",evidence_ref:"evidence-7"});
 assert.equal(r.error,"sensor_source_mapping_submitter_cannot_review");
});
test("mapping verification requires an assigned independent reviewer",async()=>{
 const r=await reviewSensorSourceMapping(dbFixture(),"tenant-1","site-1","asset-1","map-1","reviewer","req-1",{decision:"verify",evidence_ref:"evidence-7"});
 assert.equal(r.status,201);assert.equal(r.data.status,"verified");
});
test("rejected mapping cannot be revoked as if it had been verified",async()=>{
 const r=await reviewSensorSourceMapping(dbFixture({history:[{event_type:"rejected"}]}),"tenant-1","site-1","asset-1","map-1","reviewer","req-1",{decision:"revoke",evidence_ref:"evidence-7",reason:"withdraw"});
 assert.equal(r.error,"sensor_source_mapping_state_conflict");
});
test("resolver requires one exact verified mapping and returns its declared sensor identity",async()=>{
 const db=dbFixture({matches:[{id:"map-1",sensor_id:"sensor-7",parameter:"air_temperature",unit:"degC",effective_from:"2026-01-01T00:00:00.000Z",effective_to:null}]});
 const result=await resolveVerifiedSensorSourceMapping(db,"tenant-1",{site_id:"site-1",asset_id:"asset-1",source_id:"source-1",metric:"air_temperature",unit:"degC",observed_at:"2026-02-01T00:00:00.000Z"});
 assert.equal(result.sensor_id,"sensor-7");
});
test("resolver fails closed when zero or multiple verified mappings match",async()=>{
 const obs={site_id:"site-1",asset_id:"asset-1",source_id:"source-1",metric:"air_temperature",unit:"degC",observed_at:"2026-02-01T00:00:00.000Z"};
 assert.equal(await resolveVerifiedSensorSourceMapping(dbFixture({matches:[]}),"tenant-1",obs),null);
 assert.equal(await resolveVerifiedSensorSourceMapping(dbFixture({matches:[{},{}]}),"tenant-1",obs),null);
});

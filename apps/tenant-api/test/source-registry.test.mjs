import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { registerTenantSource, assignTenantSourceReviewer, reviewTenantSource } from "../src/source-registry.mjs";
globalThis.crypto ??= webcrypto;

function fixture({owner=true,site=true,prior=[],reviewer=true,source=true,registrant="owner-sub",history=[{event_type:"registered"}]}={}){
 const calls=[];
 return {calls,prepare(sql){return {sql,values:[],bind(...values){this.values=values;return this;},
  async all(){
   if(sql.includes("FROM tenant_memberships m JOIN tenants"))return {results:owner?[{subject:"owner-sub"}]:[]};
   if(sql.includes("FROM sites WHERE"))return {results:site?[{id:"site-a"}]:[]};
   if(sql.includes("tenant_source_registration_requests"))return {results:prior};
   if(sql.includes("FROM tenant_source_reviewers"))return {results:reviewer?[{reviewer_subject:"reviewer-sub"}]:[]};
   if(sql.includes("FROM sources WHERE"))return {results:source?[{id:"source-a",registered_by_subject:registrant}]:[]};
   if(sql.includes("FROM tenant_source_events"))return {results:history};
   throw Error("unexpected query "+sql);
  },
  async run(){calls.push({sql,values:this.values});return {meta:{changes:1}};}
 };},async batch(statements){calls.push(...statements.map(x=>({sql:x.sql,values:x.values})));return statements.map(()=>({meta:{changes:1}}));}};
}
const body={module:"neoagro",provider:"gateway-vendor",source_type:"sensor_gateway",display_name:"North greenhouse gateway",license_reference:"licence-record-1",evidence_ref:"evidence/source-commissioning-1"};
test("source registration is tenant/site scoped, unverified and atomic",async()=>{
 const db=fixture();const r=await registerTenantSource(db,"tenant-a","site-a","owner-sub","request-a","source-create-1","a".repeat(64),body);
 assert.equal(r.status,201);assert.equal(r.data.verification_status,"unverified");assert.equal(r.data.site_id,"site-a");
 assert.equal(db.calls.length,3);assert.match(db.calls[0].sql,/registered_by_subject/);assert.match(db.calls[1].sql,/registered/);assert.match(db.calls[2].sql,/tenant_source_registration_requests/);
});
test("source registration fails closed for non-admin actor or inactive site",async()=>{
 assert.equal((await registerTenantSource(fixture({owner:false}),"tenant-a","site-a","owner-sub","request-a","key-a","a".repeat(64),body)).status,404);
 assert.equal((await registerTenantSource(fixture({site:false}),"tenant-a","site-a","owner-sub","request-a","key-a","a".repeat(64),body)).status,404);
});
test("source registration replay returns same source and changed body conflicts",async()=>{
 const prior=[{source_id:"source-a",request_sha256:"a".repeat(64)}];
 const replay=await registerTenantSource(fixture({prior}),"tenant-a","site-a","owner-sub","request-b","key-a","a".repeat(64),body);
 assert.equal(replay.status,200);assert.equal(replay.replayed,true);assert.equal(replay.data.id,"source-a");
 const conflict=await registerTenantSource(fixture({prior}),"tenant-a","site-a","owner-sub","request-b","key-a","b".repeat(64),body);
 assert.equal(conflict.status,409);
});
test("source registration rejects caller-supplied endpoint or credential fields",async()=>{
 const r=await registerTenantSource(fixture(),"tenant-a","site-a","owner-sub","request-a","key-a","a".repeat(64),{...body,endpoint_reference:"https://example.invalid"});
 assert.equal(r.status,400);
});
test("source review checks assigned reviewer before reading protected source",async()=>{
 const db=fixture({reviewer:false});const r=await reviewTenantSource(db,"tenant-a","site-a","source-a","reviewer-sub","review-a",{decision:"verify",evidence_ref:"evidence/verification-1"});
 assert.equal(r.status,404);assert.equal(db.calls.length,0);
});
test("source registrant cannot verify own source",async()=>{
 const r=await reviewTenantSource(fixture(),"tenant-a","site-a","source-a","owner-sub","review-a",{decision:"verify",evidence_ref:"evidence/verification-1"});
 assert.equal(r.status,409);
});
test("independent reviewer can verify a registered source",async()=>{
 const db=fixture();const r=await reviewTenantSource(db,"tenant-a","site-a","source-a","reviewer-sub","review-a",{decision:"verify",evidence_ref:"evidence/verification-1"});
 assert.equal(r.status,201);assert.equal(r.data.status,"verified");
});
test("rejected source cannot be revoked or re-verified",async()=>{
 const rejected=await reviewTenantSource(fixture({history:[{event_type:"rejected"}]}),"tenant-a","site-a","source-a","reviewer-sub","review-b",{decision:"revoke",evidence_ref:"evidence/revoke-1",reason:"invalid"});
 assert.equal(rejected.status,409);
 const reverify=await reviewTenantSource(fixture({history:[{event_type:"rejected"}]}),"tenant-a","site-a","source-a","reviewer-sub","review-c",{decision:"verify",evidence_ref:"evidence/reverify-1"});
 assert.equal(reverify.status,409);
});

import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { reserveMeasurementAssessmentOperation, readMeasurementAssessmentOperation, claimMeasurementAssessmentOperation } from "../src/measurement-assessment-operations.mjs";
globalThis.crypto ??= webcrypto;

function fakeDb({prior=[],active=[],events=[],batchResults=[{meta:{changes:1}},{meta:{changes:1}}]}={}){
 const prepared=[];const batches=[];
 return {prepared,batches,
  prepare(sql){const statement={sql,values:[],bind(...values){this.values=values;return this;},async all(){
   prepared.push({sql,values:this.values});
   if(sql.includes("request_digest=?"))return {results:prior};
   if(sql.includes("state IN ('reserved','running')"))return {results:active};
   if(sql.includes("FROM measurement_assessment_operations operation")&&sql.includes("operation.operation_id=?"))return {results:prior};
   if(sql.includes("FROM measurement_assessment_operation_events"))return {results:events};
   throw new Error("unhandled query: "+sql);
  }};return statement;},
  async batch(statements){batches.push(statements.map(x=>({sql:x.sql,values:x.values})));return batchResults;}
 };
}

const op={operation_id:"f1c1b8f4-33e8-4ef3-8a7f-fcf3c7fdb09a",tenant_id:"tenant-1",site_id:"site-1",
 observation_id:"obs-1",actor_subject:"access-subject-1",request_digest:"a".repeat(64),state:"reserved",
 assessment_id:null,predecessor_operation_id:null,lease_version:0,lease_expires_at:null,attempt_count:0};

test("reservation atomically batches the operation row and its first immutable event",async()=>{
 const db=fakeDb();
 const result=await reserveMeasurementAssessmentOperation(db,"tenant-1","site-1","obs-1","access-subject-1","a".repeat(64),"transport-1");
 assert.equal(result.status,201);
 assert.equal(result.data.state,"reserved");
 assert.equal(db.batches.length,1);
 assert.equal(db.batches[0].length,2);
 assert.match(db.batches[0][0].sql,/INSERT INTO measurement_assessment_operations/);
 assert.match(db.batches[0][0].sql,/tenant_resource_grants/);
 assert.match(db.batches[0][0].sql,/predecessor.state IN \('completed','not_assessed'\)/);
 assert.match(db.batches[0][1].sql,/INSERT INTO measurement_assessment_operation_events/);
 assert.equal(db.batches[0][1].values[1],"transport-1");
});

test("lost reservation response resolves the same actor, scope and digest without a second insert",async()=>{
 const db=fakeDb({prior:[{...op,state:"completed",assessment_id:"assessment-1"}]});
 const result=await reserveMeasurementAssessmentOperation(db,"tenant-1","site-1","obs-1","access-subject-1","a".repeat(64),"transport-retry");
 assert.equal(result.status,200);
 assert.equal(result.data.operation_id,op.operation_id);
 assert.equal(result.data.state,"completed");
 assert.equal(db.batches.length,0);
});

test("reservation conflict returns the actor's existing active operation only for the same digest",async()=>{
 const db=fakeDb({batchResults:[{meta:{changes:0}},{meta:{changes:0}}],active:[{...op,request_digest:"b".repeat(64)}]});
 const result=await reserveMeasurementAssessmentOperation(db,"tenant-1","site-1","obs-1","access-subject-1","a".repeat(64),"transport-2");
 assert.equal(result.status,409);
 assert.equal(result.error,"assessment_operation_conflict");
});

test("reservation rejects malformed scope, actor, digest and transport nonce",async()=>{
 const db=fakeDb();
 for(const args of [
  ["tenant-1","site-1","obs-1","actor","A".repeat(64),"req-1"],
  ["tenant-1","site-1","obs-1","actor","a".repeat(64),"bad request"],
  ["tenant-1","site-1","bad id","actor","a".repeat(64),"req-1"]
 ]){
  const result=await reserveMeasurementAssessmentOperation(db,...args);
  assert.equal(result.status,400);
 }
 assert.equal(db.batches.length,0);
});

test("operation read is bound to active actor membership and exact site read grant",async()=>{
 const db=fakeDb({prior:[op],events:[{event_id:"event-1",from_state:null,to_state:"reserved",event_type:"reserved",request_id:"req-1"}]});
 const result=await readMeasurementAssessmentOperation(db,"tenant-1","access-subject-1",op.operation_id);
 assert.equal(result.status,200);
 assert.equal(result.data.events.length,1);
 assert.match(db.prepared[0].sql,/membership.status='active'/);
 assert.match(db.prepared[0].sql,/grant_read.resource_type='site'/);
 assert.deepEqual(db.prepared[0].values,["tenant-1","access-subject-1",op.operation_id]);
});

test("claim atomically advances a reserved operation and appends a fenced claim event",async()=>{
 const db=fakeDb({prior:[{...op,state:"reserved",lease_version:0,attempt_count:0,lease_expires_at:null,lease_request_id:null}]});
 const result=await claimMeasurementAssessmentOperation(db,"tenant-1","access-subject-1",op.operation_id,
  "transport-claim","2026-11-18T12:00:00.000Z","2026-11-18T12:02:00.000Z");
 assert.equal(result.status,200);
 assert.equal(result.data.state,"running");
 assert.equal(result.data.lease_request_id,"transport-claim");
 assert.equal(result.data.lease_version,1);
 assert.equal(db.batches.length,1);
 assert.equal(db.batches[0].length,2);
 assert.match(db.batches[0][0].sql,/state='reserved' AND lease_expires_at IS NULL/);
 assert.match(db.batches[0][0].sql,/tenant_resource_grants/);
 assert.match(db.batches[0][1].sql,/lease_request_id=\?/);
 assert.equal(db.batches[0][1].values[2],"claimed");
});

test("claim recovers only an expired running lease using its exact prior version and expiry",async()=>{
 const prior={...op,state:"running",lease_version:3,attempt_count:3,
  lease_expires_at:"2026-11-18T11:59:00.000Z",lease_request_id:"old-transport"};
 const db=fakeDb({prior:[prior]});
 const result=await claimMeasurementAssessmentOperation(db,"tenant-1","access-subject-1",op.operation_id,
  "transport-recovery","2026-11-18T12:00:00.000Z","2026-11-18T12:02:00.000Z");
 assert.equal(result.status,200);
 assert.equal(result.data.lease_version,4);
 assert.equal(result.data.attempt_count,4);
 assert.equal(result.data.lease_request_id,"transport-recovery");
 assert.match(db.batches[0][0].sql,/lease_version=\? AND lease_expires_at=\? AND lease_expires_at<=\?/);
 assert.equal(db.batches[0][1].values[2],"lease_recovered");
});

test("claim refuses an unexpired running operation and terminal operation",async()=>{
 for(const current of [
  {...op,state:"running",lease_version:1,attempt_count:1,lease_expires_at:"2026-11-18T12:01:00.000Z",lease_request_id:"active"},
  {...op,state:"completed",lease_version:1,attempt_count:1,lease_expires_at:null,lease_request_id:null}
 ]){
  const db=fakeDb({prior:[current]});
  const result=await claimMeasurementAssessmentOperation(db,"tenant-1","access-subject-1",op.operation_id,
   "transport-next","2026-11-18T12:00:00.000Z","2026-11-18T12:02:00.000Z");
  assert.equal(result.status,409);
  assert.equal(db.batches.length,0);
 }
});

test("a losing concurrent claim update returns conflict and appends no event",async()=>{
 const db=fakeDb({prior:[{...op,state:"reserved",lease_version:0,attempt_count:0,lease_expires_at:null}],
  batchResults:[{meta:{changes:0}},{meta:{changes:0}}]});
 const result=await claimMeasurementAssessmentOperation(db,"tenant-1","access-subject-1",op.operation_id,
  "loser-transport","2026-11-18T12:00:00.000Z","2026-11-18T12:02:00.000Z");
 assert.equal(result.status,409);
 assert.equal(db.batches.length,1);
});

test("claim rejects invalid or excessive lease windows before storage writes",async()=>{
 const db=fakeDb({prior:[{...op,state:"reserved",lease_version:0,attempt_count:0,lease_expires_at:null}]});
 for(const expiry of ["2026-11-18T11:59:00.000Z","2026-11-18T12:06:00.000Z","not-a-time"]){
  const result=await claimMeasurementAssessmentOperation(db,"tenant-1","access-subject-1",op.operation_id,
   "transport-claim","2026-11-18T12:00:00.000Z",expiry);
  assert.equal(result.status,400);
 }
 assert.equal(db.batches.length,0);
});

test("operation read hides another actor's operation",async()=>{
 const db=fakeDb({prior:[]});
 const result=await readMeasurementAssessmentOperation(db,"tenant-1","different-actor",op.operation_id);
 assert.equal(result.status,404);
});

import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { completeMeasurementAssessmentOperation } from "../src/measurement-assessment-completion.mjs";

globalThis.crypto ??= webcrypto;

const operation={
 operation_id:"operation-1",tenant_id:"tenant-1",site_id:"site-1",observation_id:"observation-1",
 actor_subject:"access-subject-1",state:"running",assessment_id:null,site_status:"active",lease_version:2,
 lease_expires_at:"2026-11-18T12:05:00.000Z",lease_request_id:"lease-transport-1"
};
const observation={
 id:"observation-1",tenant_id:"tenant-1",site_id:"site-1",source_id:"source-1",
 module:"neoagro",metric:"temperature",value:22,unit:"degC",
 observed_at:"2026-11-18T11:00:00.000Z",verification_status:"verified",provenance_json:"{}"
};
const mapping={id:"mapping-1",asset_id:"asset-1",sensor_id:"sensor-1",parameter:"temperature",unit:"degC"};
const calibration={id:"calibration-1",calibrated_at:"2026-01-01T00:00:00.000Z",
 valid_until:"2026-12-01T00:00:00.000Z",uncertainty:null};
const policy={id:"policy-1",minimum_value:0,maximum_value:40,version:"policy-v1"};
const saved={id:"assessment-1",tenant_id:"tenant-1",site_id:"site-1",
 observation_id:"observation-1",status:"passed",reason_code:"within_approved_policy_bounds",
 mapping_id:"mapping-1",calibration_id:"calibration-1",policy_id:"policy-1",
 method_version:"1.0.0",request_id:"operation-1"};

function fixture({currentOperation=operation,sourcePresent=true,insertChanges=1,existingAssessment=null}={}){
 const calls={all:[],run:[]};let inserted=false;
 const db={
  calls,
  prepare(sql){
   return {
    sql,values:[],
    bind(...values){this.values=values;return this;},
    async all(){
     calls.all.push({sql,values:this.values});
     if(sql.includes("FROM measurement_assessment_operations operation"))return {results:[currentOperation]};
     if(sql.includes("FROM observations WHERE tenant_id=? AND id=?"))return {results:[observation]};
     if(sql.includes("FROM sources s JOIN tenants"))return {results:sourcePresent?[{id:"source-1"}]:[]};
     if(sql.includes("FROM sensor_source_identity_mappings m JOIN"))return {results:[mapping]};
     if(sql.includes("FROM sensor_calibrations c JOIN"))return {results:[calibration]};
     if(sql.includes("FROM measurement_quality_policies p JOIN"))return {results:[policy]};
     if(sql.includes("FROM measurement_quality_assessments")&&sql.includes("operation_actor_subject=?"))
      return {results:existingAssessment?[existingAssessment]:(inserted?[saved]:[])};
     throw new Error("unhandled query: "+sql);
    },
    async run(){
     calls.run.push({sql,values:this.values});
     if(sql.includes("WITH operation_context AS")&&sql.includes("INSERT INTO measurement_quality_assessments"))
      inserted=insertChanges===1;return {meta:{changes:insertChanges}};
     throw new Error("unhandled write: "+sql);
    }
   };
  }
 };
 return db;
}

const input={
 tenant:"tenant-1",actorSubject:"access-subject-1",operationId:"operation-1",
 expectedLeaseVersion:2,expectedLeaseRequestId:"lease-transport-1",
 terminalRequestId:"terminal-transport-1",now:"2026-11-18T12:00:00.000Z"
};

test("completion uses one assessment insert whose database trigger terminalizes the operation",async()=>{
 const db=fixture();
 const result=await completeMeasurementAssessmentOperation(db,input);
 assert.equal(result.status,201);
 assert.equal(result.data.id,"assessment-1");
 assert.equal(db.calls.run.length,1);
 const write=db.calls.run[0];
 assert.match(write.sql,/WITH operation_context AS/);
 assert.match(write.sql,/operation\.lease_version=\?/);
 assert.match(write.sql,/operation\.lease_request_id=\?/);
 assert.match(write.sql,/tenant_resource_grants/);
 assert.match(write.sql,/measurement_quality_policy_events/);
 assert.match(write.sql,/operation_terminal_request_id/);
 assert.match(write.sql,/WHERE 1=1\s+ON CONFLICT/);
 assert.equal(write.values[0],"operation-1");
 assert.equal(write.values[1],"tenant-1");
 assert.equal(write.values[2],"access-subject-1");
 assert.equal(write.values[3],2);
 assert.equal(write.values[4],"lease-transport-1");
 assert.equal(write.values[5],input.now);
 assert.equal(write.values.at(-2),input.terminalRequestId);
 assert.equal(write.values.at(-1),input.now);
});

test("governance evidence that becomes unavailable is persisted as not_assessed",async()=>{
 const db=fixture({sourcePresent:false});
 const result=await completeMeasurementAssessmentOperation(db,input);
 assert.equal(result.status,201);
 assert.equal(result.data.id,"assessment-1");
 const write=db.calls.run[0];
 assert.match(write.sql,/governance_state_changed_before_assessment/);
 assert.equal(write.values[6],"not_assessed");
});

test("terminal operation retry returns its original actor-scoped assessment",async()=>{
 const prior={...operation,state:"completed",assessment_id:"assessment-1"};
 const db=fixture({currentOperation:prior,existingAssessment:saved});
 const result=await completeMeasurementAssessmentOperation(db,input);
 assert.equal(result.status,200);
 assert.equal(result.data.id,"assessment-1");
 assert.equal(db.calls.run.length,0);
});

test("stale lease is rejected before evaluation or persistence",async()=>{
 const stale={...operation,lease_version:3,lease_request_id:"new-lease"};
 const db=fixture({currentOperation:stale});
 const result=await completeMeasurementAssessmentOperation(db,input);
 assert.equal(result.status,409);
 assert.equal(db.calls.run.length,0);
 assert.equal(db.calls.all.length,1);
});

test("zero-row insert returns the existing exact operation result or a conflict",async()=>{
 const db=fixture({insertChanges:0});
 const result=await completeMeasurementAssessmentOperation(db,input);
 assert.equal(result.status,409);
 assert.equal(db.calls.run.length,1);
});

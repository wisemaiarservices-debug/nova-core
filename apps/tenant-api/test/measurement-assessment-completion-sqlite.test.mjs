import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";
import { reserveMeasurementAssessmentOperation, claimMeasurementAssessmentOperation } from "../src/measurement-assessment-operations.mjs";
import { completeMeasurementAssessmentOperation } from "../src/measurement-assessment-completion.mjs";

globalThis.crypto ??= webcrypto;

const migrationDir=new URL("../../api/migrations/",import.meta.url);
const migrations=[
 "0036_measurement_assessment_operations.sql",
 "0037_measurement_assessment_operation_lease_fencing.sql",
 "0038_measurement_assessment_operation_terminal_audit.sql",
 "0039_measurement_assessment_insert_terminalizes_operation.sql"
].map(name=>readFileSync(fileURLToPath(new URL(name,migrationDir)),"utf8"));

const tenant="tenant-completion-sqlite";
const site="site-completion-sqlite";
const actor="access-subject-completion-sqlite";
const observation="observation-completion-sqlite";
const now="2026-11-18T12:00:00.000Z";
const leaseExpiry="2026-11-18T12:05:00.000Z";

function d1Adapter(sqlite){
 let batchTail=Promise.resolve();
 return {
  prepare(sql){
   return {
    bind(...args){
     return {
      async all(){return {results:sqlite.prepare(sql).all(...args)};},
      async run(){const result=sqlite.prepare(sql).run(...args);return {meta:{changes:Number(result.changes)}};}
     };
    }
   };
  },
  batch(statements){
   const execute=async()=>{
    sqlite.exec("BEGIN");
    try{
     const results=[];
     for(const statement of statements)results.push(await statement.run());
     sqlite.exec("COMMIT");
     return results;
    }catch(error){sqlite.exec("ROLLBACK");throw error;}
   };
   const pending=batchTail.then(execute,execute);
   batchTail=pending.then(()=>undefined,()=>undefined);
   return pending;
  }
 };
}

function fixture(t){
 const sqlite=new DatabaseSync(":memory:");
 t.after(()=>sqlite.close());
 sqlite.exec("PRAGMA foreign_keys=ON");
 sqlite.exec(`
  CREATE TABLE tenants(id TEXT PRIMARY KEY,status TEXT NOT NULL);
  CREATE TABLE sites(id TEXT NOT NULL,tenant_id TEXT NOT NULL,status TEXT NOT NULL,
   PRIMARY KEY(id,tenant_id),UNIQUE(id,tenant_id));
  CREATE TABLE assets(id TEXT NOT NULL,tenant_id TEXT NOT NULL,site_id TEXT NOT NULL,status TEXT NOT NULL,
   PRIMARY KEY(id,tenant_id,site_id));
  CREATE TABLE tenant_memberships(tenant_id TEXT NOT NULL,subject TEXT NOT NULL,status TEXT NOT NULL,
   PRIMARY KEY(tenant_id,subject));
  CREATE TABLE tenant_resource_grants(tenant_id TEXT NOT NULL,subject TEXT NOT NULL,
   resource_type TEXT NOT NULL,resource_id TEXT NOT NULL,action TEXT NOT NULL);
  CREATE TABLE observations(
   id TEXT NOT NULL,tenant_id TEXT NOT NULL,site_id TEXT NOT NULL,source_id TEXT NOT NULL,
   module TEXT NOT NULL,metric TEXT NOT NULL,value REAL,unit TEXT NOT NULL,observed_at TEXT NOT NULL,
   verification_status TEXT NOT NULL,provenance_json TEXT,
   PRIMARY KEY(id,tenant_id,site_id),UNIQUE(id,tenant_id,site_id));
  CREATE TABLE sources(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,site_id TEXT,module TEXT NOT NULL,
   verification_status TEXT NOT NULL);
  CREATE TABLE sensor_source_identity_mappings(
   id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,site_id TEXT NOT NULL,source_id TEXT NOT NULL,
   asset_id TEXT NOT NULL,sensor_id TEXT NOT NULL,parameter TEXT NOT NULL,unit TEXT NOT NULL,
   effective_from TEXT NOT NULL,effective_to TEXT);
  CREATE TABLE sensor_source_mapping_events(
   id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,mapping_id TEXT NOT NULL,event_type TEXT NOT NULL,
   occurred_at TEXT NOT NULL);
  CREATE TABLE sensor_calibrations(
   id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,site_id TEXT NOT NULL,asset_id TEXT NOT NULL,
   sensor_id TEXT NOT NULL,parameter TEXT NOT NULL,unit TEXT NOT NULL,
   calibrated_at TEXT NOT NULL,valid_until TEXT NOT NULL,uncertainty REAL);
  CREATE TABLE sensor_calibration_verification_events(
   id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,calibration_id TEXT NOT NULL,event_type TEXT NOT NULL,
   occurred_at TEXT NOT NULL);
  CREATE TABLE measurement_quality_policies(
   id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,site_id TEXT NOT NULL,asset_id TEXT NOT NULL,
   sensor_id TEXT NOT NULL,parameter TEXT NOT NULL,unit TEXT NOT NULL,
   minimum_value REAL,maximum_value REAL,version TEXT NOT NULL,
   effective_from TEXT NOT NULL,effective_to TEXT);
  CREATE TABLE measurement_quality_policy_events(
   id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,policy_id TEXT NOT NULL,event_type TEXT NOT NULL,
   occurred_at TEXT NOT NULL);
  CREATE TABLE measurement_quality_assessments(
   id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,site_id TEXT NOT NULL,observation_id TEXT NOT NULL,
   mapping_id TEXT,calibration_id TEXT,policy_id TEXT,status TEXT NOT NULL,reason_code TEXT NOT NULL,
   observed_value REAL,unit TEXT,assessed_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
   method_version TEXT NOT NULL,request_id TEXT NOT NULL,
   UNIQUE(tenant_id,request_id),
   UNIQUE(id,tenant_id,site_id,observation_id,request_id),
   FOREIGN KEY(observation_id,tenant_id,site_id) REFERENCES observations(id,tenant_id,site_id));
 `);
 for(const migration of migrations)sqlite.exec(migration);
 sqlite.prepare("INSERT INTO tenants VALUES (?,'active')").run(tenant);
 sqlite.prepare("INSERT INTO sites VALUES (?,?,'active')").run(site,tenant);
 sqlite.prepare("INSERT INTO assets VALUES (? ,?,?,'active')").run("asset-1",tenant,site);
 sqlite.prepare("INSERT INTO tenant_memberships VALUES (?,?, 'active')").run(tenant,actor);
 sqlite.prepare("INSERT INTO tenant_resource_grants VALUES (?,?, 'site',?,'read')").run(tenant,actor,site);
 sqlite.prepare("INSERT INTO observations VALUES (?,?,?,?,?,?,?,?,?,'verified','{}')").run(
  observation,tenant,site,"source-1","neoagro","temperature",22,"degC","2026-06-01T10:00:00.000Z"
 );
 sqlite.prepare("INSERT INTO sources VALUES ('source-1',?,NULL,'neoagro','verified')").run(tenant);
 sqlite.prepare("INSERT INTO sensor_source_identity_mappings VALUES ('mapping-1',?,?,?,?,?,'temperature','degC','2026-01-01T00:00:00.000Z',NULL)")
  .run(tenant,site,"source-1","asset-1","sensor-1");
 sqlite.prepare("INSERT INTO sensor_source_mapping_events VALUES ('map-event-1',?,'mapping-1','verified','2026-01-01T00:00:00.000Z')").run(tenant);
 sqlite.prepare("INSERT INTO sensor_calibrations VALUES ('calibration-1',?,?,?,?,'temperature','degC','2026-01-01T00:00:00.000Z','2026-12-01T00:00:00.000Z',NULL)")
  .run(tenant,site,"asset-1","sensor-1");
 sqlite.prepare("INSERT INTO sensor_calibration_verification_events VALUES ('cal-event-1',?,'calibration-1','verified','2026-01-01T00:00:00.000Z')").run(tenant);
 sqlite.prepare("INSERT INTO measurement_quality_policies VALUES ('policy-1',?,?,?,?,'temperature','degC',0,40,'policy-v1','2026-01-01T00:00:00.000Z',NULL)")
  .run(tenant,site,"asset-1","sensor-1");
 sqlite.prepare("INSERT INTO measurement_quality_policy_events VALUES ('policy-event-1',?,'policy-1','verified','2026-01-01T00:00:00.000Z')").run(tenant);
 return {sqlite,db:d1Adapter(sqlite)};
}

async function createRunningOperation(db){
 const reserved=await reserveMeasurementAssessmentOperation(db,tenant,site,observation,actor,
  "a".repeat(64),"reserve-transport");
 assert.equal(reserved.status,201);
 const claimed=await claimMeasurementAssessmentOperation(db,tenant,actor,reserved.data.operation_id,
  "claim-transport",now,leaseExpiry);
 assert.equal(claimed.status,200);
 return reserved.data.operation_id;
}

function completionInput(operationId){
 return {tenant,actorSubject:actor,operationId,expectedLeaseVersion:1,
  expectedLeaseRequestId:"claim-transport",terminalRequestId:"terminal-transport",now};
}

test("real SQLite/D1-adapter completion persists a passed result and terminal audit atomically",async t=>{
 const {sqlite,db}=fixture(t);
 const operationId=await createRunningOperation(db);
 const result=await completeMeasurementAssessmentOperation(db,completionInput(operationId));
 assert.equal(result.status,201);
 assert.equal(result.data.status,"passed");
 const operation=sqlite.prepare("SELECT state,assessment_id,lease_request_id,terminal_request_id FROM measurement_assessment_operations WHERE operation_id=?").get(operationId);
 assert.equal(operation.state,"completed");
 assert.equal(operation.assessment_id,result.data.id);
 assert.equal(operation.lease_request_id,null);
 assert.equal(operation.terminal_request_id,"terminal-transport");
 const event=sqlite.prepare("SELECT from_state,to_state,event_type,request_id FROM measurement_assessment_operation_events WHERE operation_id=? ORDER BY rowid DESC LIMIT 1").get(operationId);
 assert.deepEqual({...event},{from_state:"running",to_state:"completed",event_type:"completed",request_id:"terminal-transport"});
});

test("live source revocation between claim and completion yields a durable not_assessed result",async t=>{
 const {sqlite,db}=fixture(t);
 const operationId=await createRunningOperation(db);
 sqlite.prepare("UPDATE sources SET verification_status='disabled' WHERE id='source-1'").run();
 const result=await completeMeasurementAssessmentOperation(db,completionInput(operationId));
 assert.equal(result.status,201);
 assert.equal(result.data.status,"not_assessed");
 assert.equal(result.data.reason_code,"source_not_active_or_verified");
 assert.equal(sqlite.prepare("SELECT state FROM measurement_assessment_operations WHERE operation_id=?").get(operationId).state,"not_assessed");
});

test("terminal audit trigger failure rolls back the assessment insert and operation update",async t=>{
 const {sqlite,db}=fixture(t);
 const operationId=await createRunningOperation(db);
 sqlite.exec(`CREATE TRIGGER reject_completion_audit BEFORE INSERT ON measurement_assessment_operation_events
  WHEN NEW.event_type='completed' BEGIN SELECT RAISE(ABORT,'forced completion audit failure'); END`);
 await assert.rejects(()=>completeMeasurementAssessmentOperation(db,completionInput(operationId)),
  /forced completion audit failure/);
 assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM measurement_quality_assessments WHERE request_id=?").get(operationId).count,0);
 assert.equal(sqlite.prepare("SELECT state FROM measurement_assessment_operations WHERE operation_id=?").get(operationId).state,"running");
});

test("lost-response retry returns the original actor-scoped result without another insert",async t=>{
 const {sqlite,db}=fixture(t);
 const operationId=await createRunningOperation(db);
 const first=await completeMeasurementAssessmentOperation(db,completionInput(operationId));
 const second=await completeMeasurementAssessmentOperation(db,completionInput(operationId));
 assert.equal(first.status,201);
 assert.equal(second.status,200);
 assert.equal(second.data.id,first.data.id);
 assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM measurement_quality_assessments WHERE request_id=?").get(operationId).count,1);
});

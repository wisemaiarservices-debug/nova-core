import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { createSiteConfiguration } from "../src/configuration-write-persistence.mjs";

const membership = [{subject:"operator-1",tenant_id:"tenant-a",role:"tenant_admin",
  membership_status:"active",tenant_status:"active"}];
const grants = [{subject:"operator-1",tenant_id:"tenant-a",resource_type:"site",
  resource_id:"site-a",action:"create"}];

function fakeDb({prior=null,batchFailure=false}={}) {
  const calls=[];
  const db={
    calls,
    prepare(sql) {
      return {sql,params:[],bind(...params){this.params=params;return this;},
        async all(){calls.push({kind:"all",sql,params:this.params}); 
          if(sql.includes("tenant_memberships")) return {results:membership};
          if(sql.includes("tenant_resource_grants")) return {results:grants};
          if(sql.includes("tenant_site_configuration_idempotency")) return {results:prior?[prior]:[]};
          return {results:[]};}};
    },
    async batch(statements){calls.push({kind:"batch",statements});
      if(batchFailure) throw new Error("simulated_atomic_failure");
      const reservation = statements[0].params;
      const snapshot = statements[1].params;
      prior = {request_sha256:reservation[3],configuration_id:reservation[4],
        status:"completed",response_json:JSON.stringify({configuration_id:reservation[4],
          configuration_version:"v1",site_id:snapshot[2]})};
      return statements.map(()=>({success:true,meta:{changes:1}}));}
  };
  return db;
}
const input={principalSubject:"operator-1",tenantId:"tenant-a",siteId:"site-a",
  idempotencyKey:"idem-001",requestId:"req-001",payload:{crop:"olive"},
  schemaId:"nova.client-config.v1",cryptoProvider:webcrypto};

test("performs authorization reads before one atomic five-statement write batch",async()=>{
  const db=fakeDb();
  const result=await createSiteConfiguration({db,...input});
  assert.equal(result.replayed,false);
  assert.equal(db.calls.filter(c=>c.kind==="batch").length,1);
  const batch=db.calls.find(c=>c.kind==="batch").statements;
  assert.equal(batch.length,5);
  assert.match(batch[0].sql,/tenant_site_configuration_idempotency/);
  assert.match(batch[1].sql,/tenant_site_configurations/);
  assert.match(batch[2].sql,/submitted_for_review/);
  assert.match(batch[3].sql,/audit_events/);
  assert.match(batch[4].sql,/status = 'completed'/);
  assert.match(batch[4].sql,/configuration_version/);
  assert.equal(batch[4].params.length,3);
});

test("denies before writes when membership or exact site grant is missing",async()=>{
  const db=fakeDb(); db.prepare=(sql)=>({sql,bind(){return this;},async all(){
    return {results:sql.includes("tenant_memberships")?[]:grants};
  }});
  await assert.rejects(()=>createSiteConfiguration({db,...input}),/configuration_authorization_denied/);
  assert.equal(db.calls.filter(c=>c.kind==="batch").length,0);
});

test("returns an exact completed idempotent replay without a write batch",async()=>{
  const db=fakeDb({prior:{request_sha256:"",configuration_id:"cfg-1",status:"completed",
    response_json:JSON.stringify({configuration_id:"cfg-1",site_id:"site-a"})}});
  // Compute the canonical request hash using the same contract.
  const {sha256Hex}=await import("../src/configuration-write-contract.mjs");
  const {canonicalizeConfiguration}=await import("../src/configuration-write-contract.mjs");
  const canonical=canonicalizeConfiguration(input.payload).canonicalJson;
  db.calls.length=0;
  const digest=await sha256Hex(JSON.stringify([input.siteId,input.schemaId,canonical]),webcrypto);
  const db2=fakeDb({prior:{request_sha256:digest,configuration_id:"cfg-1",status:"completed",
    response_json:JSON.stringify({configuration_id:"cfg-1",site_id:"site-a"})}});
  const result=await createSiteConfiguration({db:db2,...input});
  assert.equal(result.replayed,true);
  assert.equal(db2.calls.some(c=>c.kind==="batch"),false);
});

test("rejects an idempotency key reused for a different canonical payload",async()=>{
  const db=fakeDb({prior:{request_sha256:"a".repeat(64),configuration_id:"cfg-1",
    status:"completed",response_json:"{}"}});
  await assert.rejects(()=>createSiteConfiguration({db,...input}),/configuration_idempotency_conflict/);
  assert.equal(db.calls.some(c=>c.kind==="batch"),false);
});

test("does not report success when the atomic D1 batch fails",async()=>{
  const db=fakeDb({batchFailure:true});
  await assert.rejects(()=>createSiteConfiguration({db,...input}),/simulated_atomic_failure/);
});

test("does not accept a successful-looking batch when a required statement changes zero rows",async()=>{
  const db=fakeDb();
  db.batch=async statements=>statements.map((_,index)=>({
    success:true,meta:{changes:index===4?0:1},
  }));
  await assert.rejects(()=>createSiteConfiguration({db,...input}),/configuration_atomic_write_failed/);
});

test("rejects schema IDs outside the server-owned allowlist before any write",async()=>{
  const db=fakeDb();
  await assert.rejects(()=>createSiteConfiguration({
    db,...input,schemaId:"nova.client-config.unapproved.v99",
  }),/configuration_schema_not_supported/);
  assert.equal(db.calls.some(c=>c.kind==="batch"),false);
});

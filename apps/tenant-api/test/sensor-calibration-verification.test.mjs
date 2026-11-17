import test from "node:test";
import assert from "node:assert/strict";
import {webcrypto} from "node:crypto";
import {reviewSensorCalibration} from "../src/sensor-calibration-verification.mjs";
globalThis.crypto??=webcrypto;
const base={decision:"verify",evidence_ref:"lab-1"};
function fake({owner="owner",reviewer="reviewer",last="registered_unverified",evidence="verified",writeChanges=1}={}){let inserted=null,insertSql=null;return {get inserted(){return inserted;},get insertSql(){return insertSql;},prepare(sql){return {sql,bind(...v){this.v=v;return this;},async all(){if(sql.includes("FROM sensor_calibrations"))return {results:[{id:"cal-1",tenant_id:"t-1",site_id:"s-1",asset_id:"a-1",registered_by_subject:owner,certificate_evidence_id:"lab-1"}]};if(sql.includes("FROM sensor_calibration_reviewers"))return {results:[{reviewer_subject:reviewer}]};if(sql.includes("FROM laboratory_report_evidence"))return {results:[{verification_status:evidence}]};if(sql.includes("FROM sensor_calibration_verification_events"))return {results:last==="registered_unverified"?[]:[{event_type:last}]};throw Error(sql);},async run(){inserted=this.v;insertSql=this.sql;return {meta:{changes:writeChanges}};}};}};}
test("independent reviewer can verify while preserving the registered certificate reference",async()=>{const db=fake();const r=await reviewSensorCalibration(db,"t-1","s-1","a-1","cal-1","reviewer","req-1",base);assert.equal(r.status,201);assert.equal(r.data.verification_status,"verified");assert.equal(db.inserted[6],"verified");});
test("submitter cannot review own calibration",async()=>{const r=await reviewSensorCalibration(fake(),"t-1","s-1","a-1","cal-1","owner","req-1",base);assert.equal(r.error,"calibration_submitter_cannot_review");});
test("review decision cites the exact registered certificate even while its authenticity remains unverified",async()=>{const r=await reviewSensorCalibration(fake({evidence:"registered_unverified"}),"t-1","s-1","a-1","cal-1","reviewer","req-1",base);assert.equal(r.status,201);});
test("revocation is allowed only after a verified event",async()=>{const r=await reviewSensorCalibration(fake({last:"rejected"}),"t-1","s-1","a-1","cal-1","reviewer","req-1",{decision:"revoke",evidence_ref:"evidence:reason:1",reason:"review withdrawn"});assert.equal(r.error,"calibration_verification_state_conflict");});


test("concurrent calibration verification loses safely at the event insert",async()=>{
 const db=fake({writeChanges:0});
 const r=await reviewSensorCalibration(db,"t-1","s-1","a-1","cal-1","reviewer","req-race",base);
 assert.equal(r.error,"calibration_verification_state_conflict");
 assert.match(db.insertSql,/NOT EXISTS \(SELECT 1 FROM sensor_calibration_verification_events/);
 assert.match(db.insertSql,/tenant_memberships/);
 assert.match(db.insertSql,/sensor_calibration_reviewers/);
});
test("concurrent calibration revocation requires verified to remain the latest event",async()=>{
 const db=fake({last:"verified",writeChanges:0});
 const r=await reviewSensorCalibration(db,"t-1","s-1","a-1","cal-1","reviewer","req-race",{decision:"revoke",evidence_ref:"lab-1",reason:"withdrawn"});
 assert.equal(r.error,"calibration_verification_state_conflict");
 assert.match(db.insertSql,/ORDER BY e2.occurred_at DESC,e2.rowid DESC LIMIT 1/);
});

test("requires a linked certificate before approval",async()=>{const d=fake();d.prepare=(sql)=>({bind(){return this;},async all(){if(sql.includes("FROM sensor_calibrations"))return {results:[{id:"cal-1",tenant_id:"t-1",site_id:"s-1",asset_id:"a-1",registered_by_subject:"owner",certificate_evidence_id:null}]};if(sql.includes("FROM sensor_calibration_reviewers"))return {results:[{reviewer_subject:"reviewer"}]};throw Error(sql);}});const r=await reviewSensorCalibration(d,"t-1","s-1","a-1","cal-1","reviewer","req-1",base);assert.equal(r.error,"calibration_certificate_evidence_required");});

test("rejects a review that cites a different certificate reference",async()=>{const r=await reviewSensorCalibration(fake(),"t-1","s-1","a-1","cal-1","reviewer","req-1",{...base,evidence_ref:"other-report"});assert.equal(r.error,"calibration_review_must_reference_registered_certificate");});

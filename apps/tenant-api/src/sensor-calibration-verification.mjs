const validText=(v,n)=>typeof v==="string"&&v.length>0&&v.length<=n&&v.trim()===v&&!/[\u0000-\u001f\u007f]/.test(v);
const validId=v=>validText(v,160)&&/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(v);
const onlyKeys=(v,k)=>v!==null&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).every(x=>k.includes(x));
export async function assignCalibrationReviewer(db,tenant,actor,requestId,body,action){
 const keys=action==="assign"?["site_id","reviewer_subject","evidence_ref"]:["site_id","reviewer_subject","evidence_ref","reason"];
 if(!onlyKeys(body,keys)||!validId(body.site_id)||!validText(body.reviewer_subject,200)||body.reviewer_subject===actor||
 !validText(body.evidence_ref,500)||(action==="revoke"&&!validText(body.reason,2000)))return {error:"calibration_reviewer_request_invalid",status:400};
 const site=await db.prepare("SELECT id FROM sites WHERE tenant_id=? AND id=? LIMIT 2").bind(tenant,body.site_id).all();
 if(!Array.isArray(site?.results)||site.results.length!==1)return {error:"site_not_found",status:404};
 if(action==="assign"){
  const member=await db.prepare("SELECT m.subject,m.status AS membership_status,t.status AS tenant_status FROM tenant_memberships m JOIN tenants t ON t.id=m.tenant_id WHERE m.subject=? AND m.tenant_id=? LIMIT 2").bind(body.reviewer_subject,tenant).all();
  if(!Array.isArray(member?.results)||member.results.length!==1||member.results[0].subject!==body.reviewer_subject||member.results[0].membership_status!=="active"||member.results[0].tenant_status!=="active")return {error:"calibration_reviewer_membership_not_active",status:409};
 }
 const id=crypto.randomUUID();
 const first=action==="assign"
  ?db.prepare("INSERT INTO sensor_calibration_reviewers(tenant_id,site_id,reviewer_subject,reviewer_role,status,assigned_by_subject,assignment_evidence_ref) VALUES(?,?,?,'calibration_reviewer','active',?,?) ON CONFLICT(tenant_id,site_id,reviewer_subject,reviewer_role) DO NOTHING").bind(tenant,body.site_id,body.reviewer_subject,actor,body.evidence_ref)
  :db.prepare("UPDATE sensor_calibration_reviewers SET status='revoked' WHERE tenant_id=? AND site_id=? AND reviewer_subject=? AND reviewer_role='calibration_reviewer' AND status='active'").bind(tenant,body.site_id,body.reviewer_subject);
 const second=action==="assign"
  ?db.prepare("INSERT INTO sensor_calibration_reviewer_events(id,tenant_id,site_id,reviewer_subject,reviewer_role,event_type,actor_subject,evidence_ref,request_id) SELECT ?,?,?,?,'calibration_reviewer','assigned',?,?,? WHERE changes()=1").bind(id,tenant,body.site_id,body.reviewer_subject,actor,body.evidence_ref,requestId)
  :db.prepare("INSERT INTO sensor_calibration_reviewer_events(id,tenant_id,site_id,reviewer_subject,reviewer_role,event_type,actor_subject,evidence_ref,reason,request_id) SELECT ?,?,?,?,'calibration_reviewer','revoked',?,?,?,? WHERE changes()=1").bind(id,tenant,body.site_id,body.reviewer_subject,actor,body.evidence_ref,body.reason,requestId);
 const result=await db.batch([first,second]);
 if(!Array.isArray(result)||result.length!==2||result.some(x=>!Number.isInteger(x?.meta?.changes)))throw new Error("calibration_reviewer_batch_invalid");
 if(result[0].meta.changes!==1||result[1].meta.changes!==1)return {error:"calibration_reviewer_state_conflict",status:409};
 return {data:{tenant_id:tenant,site_id:body.site_id,reviewer_subject:body.reviewer_subject,reviewer_role:"calibration_reviewer",status:action==="assign"?"active":"revoked"},status:action==="assign"?201:200};
}
export async function reviewSensorCalibration(db,tenant,siteId,assetId,calibrationId,reviewer,requestId,body){
 if(!validId(siteId)||!validId(assetId)||!validId(calibrationId)||!onlyKeys(body,["decision","evidence_ref","reason"])||
 !["verify","reject","revoke"].includes(body.decision)||!validText(body.evidence_ref,500)||
 (body.decision!=="verify"&&!validText(body.reason,2000))||(body.reason!==undefined&&!validText(body.reason,2000)))return {error:"calibration_verification_request_invalid",status:400};
 const record=await db.prepare("SELECT id,tenant_id,site_id,asset_id,registered_by_subject,certificate_evidence_id FROM sensor_calibrations WHERE tenant_id=? AND site_id=? AND asset_id=? AND id=? LIMIT 2").bind(tenant,siteId,assetId,calibrationId).all();
 if(!Array.isArray(record?.results)||record.results.length!==1)return {error:"sensor_calibration_not_found",status:404};
 const calibration=record.results[0];
 if(calibration.registered_by_subject===reviewer)return {error:"calibration_submitter_cannot_review",status:409};
 const assignments=await db.prepare("SELECT reviewer_subject FROM sensor_calibration_reviewers WHERE tenant_id=? AND site_id=? AND reviewer_subject=? AND reviewer_role='calibration_reviewer' AND status='active' LIMIT 2").bind(tenant,siteId,reviewer).all();
 if(!Array.isArray(assignments?.results)||assignments.results.length!==1)return {error:"calibration_reviewer_assignment_not_found",status:404};
 if(body.decision==="verify"&&!calibration.certificate_evidence_id)return {error:"calibration_certificate_evidence_required",status:409};
 if(calibration.certificate_evidence_id){
  const evidence=await db.prepare("SELECT verification_status FROM laboratory_report_evidence WHERE tenant_id=? AND site_id=? AND id=? LIMIT 2").bind(tenant,siteId,calibration.certificate_evidence_id).all();
  if(!Array.isArray(evidence?.results)||evidence.results.length!==1)return {error:"calibration_certificate_evidence_not_found",status:409};
 }
 const history=await db.prepare("SELECT event_type,reviewer_subject FROM sensor_calibration_verification_events WHERE tenant_id=? AND site_id=? AND calibration_id=? ORDER BY occurred_at DESC,rowid DESC LIMIT 2").bind(tenant,siteId,calibrationId).all();
 if(!Array.isArray(history?.results))throw new Error("calibration_verification_history_invalid");
 const current=history.results[0]?.event_type??"registered_unverified";
 const transitions={verify:{from:"registered_unverified",to:"verified"},reject:{from:"registered_unverified",to:"rejected"},revoke:{from:"verified",to:"revoked"}};
 const transition=transitions[body.decision];
 if(current!==transition.from)return {error:"calibration_verification_state_conflict",status:409};
 const eventId=crypto.randomUUID();
 const insert=db.prepare("INSERT INTO sensor_calibration_verification_events(id,tenant_id,site_id,asset_id,calibration_id,reviewer_subject,reviewer_role,event_type,evidence_ref,reason,request_id) VALUES(?,?,?,?,?,?,'calibration_reviewer',?,?,?,?)").bind(eventId,tenant,siteId,assetId,calibrationId,reviewer,body.decision==="verify"?"verified":body.decision==="reject"?"rejected":"revoked",body.evidence_ref,body.reason??null,requestId);
 const result=await insert.run();
 if(!Number.isInteger(result?.meta?.changes)||result.meta.changes!==1)return {error:"calibration_verification_state_conflict",status:409};
 return {data:{calibration_id:calibrationId,tenant_id:tenant,site_id:siteId,asset_id:assetId,verification_status:transition.to,reviewer_subject:reviewer,event_type:body.decision==="verify"?"verified":body.decision==="reject"?"rejected":"revoked"},status:201};
}

const textOk=(v,n)=>typeof v==="string"&&v.length>0&&v.length<=n&&v.trim()===v&&!/[\u0000-\u001f\u007f]/.test(v);
const idOk=v=>textOk(v,160)&&/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(v);
const only=(v,keys)=>v!==null&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k));
const timestamp=v=>typeof v==="string"&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
export async function registerSensorSourceMapping(db,tenant,siteId,assetId,actor,requestId,body){
 if(!only(body,["id","source_id","sensor_id","parameter","unit","effective_from","effective_to","mapping_method","evidence_ref"])||
 !idOk(body.id)||!idOk(body.source_id)||!idOk(body.sensor_id)||!textOk(body.parameter,120)||
 !textOk(body.unit,48)||!timestamp(body.effective_from)||
 (body.effective_to!==undefined&&body.effective_to!==null&&(!timestamp(body.effective_to)||body.effective_to<=body.effective_from))||
 !textOk(body.mapping_method,160)||!textOk(body.evidence_ref,500))return {error:"sensor_source_mapping_request_invalid",status:400};
 const asset=await db.prepare("SELECT id FROM assets WHERE tenant_id=? AND site_id=? AND id=? AND status='active' LIMIT 2").bind(tenant,siteId,assetId).all();
 const source=await db.prepare("SELECT id,site_id FROM sources WHERE tenant_id=? AND id=? LIMIT 2").bind(tenant,body.source_id).all();
 if(!Array.isArray(asset?.results)||asset.results.length!==1||!Array.isArray(source?.results)||source.results.length!==1||
 (source.results[0].site_id!==null&&source.results[0].site_id!==siteId))return {error:"sensor_source_mapping_scope_not_found",status:404};
 const result=await db.prepare("INSERT INTO sensor_source_identity_mappings(id,tenant_id,site_id,asset_id,source_id,sensor_id,parameter,unit,effective_from,effective_to,mapping_method,evidence_ref,registered_by_subject) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
 .bind(body.id,tenant,siteId,assetId,body.source_id,body.sensor_id,body.parameter,body.unit,body.effective_from,body.effective_to??null,body.mapping_method,body.evidence_ref,actor).run();
 if(result?.meta?.changes!==1)throw new Error("sensor_source_mapping_write_failed");
 return {data:{id:body.id,tenant_id:tenant,site_id:siteId,asset_id:assetId,source_id:body.source_id,sensor_id:body.sensor_id,parameter:body.parameter,unit:body.unit,status:"registered_unverified"},status:201};
}
export async function reviewSensorSourceMapping(db,tenant,siteId,assetId,mappingId,reviewer,requestId,body){
 if(!only(body,["decision","evidence_ref","reason"])||!["verify","reject","revoke"].includes(body.decision)||
 !textOk(body.evidence_ref,500)||(body.decision!=="verify"&&!textOk(body.reason,2000))||
 (body.reason!==undefined&&!textOk(body.reason,2000)))return {error:"sensor_source_mapping_review_invalid",status:400};
 const found=await db.prepare("SELECT id,source_id,registered_by_subject FROM sensor_source_identity_mappings WHERE tenant_id=? AND site_id=? AND asset_id=? AND id=? LIMIT 2").bind(tenant,siteId,assetId,mappingId).all();
 if(!Array.isArray(found?.results)||found.results.length!==1)return {error:"sensor_source_mapping_not_found",status:404};
 if(found.results[0].registered_by_subject===reviewer)return {error:"sensor_source_mapping_submitter_cannot_review",status:409};
 const reviewerRows=await db.prepare("SELECT reviewer_subject FROM sensor_source_mapping_reviewers WHERE tenant_id=? AND site_id=? AND reviewer_subject=? AND status='active' LIMIT 2").bind(tenant,siteId,reviewer).all();
 if(!Array.isArray(reviewerRows?.results)||reviewerRows.results.length!==1)return {error:"sensor_source_mapping_reviewer_not_assigned",status:404};
 const history=await db.prepare("SELECT event_type FROM sensor_source_mapping_events WHERE tenant_id=? AND mapping_id=? ORDER BY occurred_at DESC,rowid DESC LIMIT 1").bind(tenant,mappingId).all();
 if(!Array.isArray(history?.results))throw new Error("sensor_source_mapping_history_invalid");
 const current=history.results[0]?.event_type??"registered_unverified";
 const allowed={verify:"registered_unverified",reject:"registered_unverified",revoke:"verified"};
 if(current!==allowed[body.decision])return {error:"sensor_source_mapping_state_conflict",status:409};
 const type={verify:"verified",reject:"rejected",revoke:"revoked"}[body.decision];
 const result=await db.prepare("INSERT INTO sensor_source_mapping_events(id,tenant_id,site_id,asset_id,source_id,mapping_id,reviewer_subject,event_type,evidence_ref,reason,request_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
 .bind(crypto.randomUUID(),tenant,siteId,assetId,found.results[0].source_id,mappingId,reviewer,type,body.evidence_ref,body.reason??null,requestId).run();
 if(result?.meta?.changes!==1) return {error:"sensor_source_mapping_state_conflict",status:409};
 return {data:{mapping_id:mappingId,status:type,reviewer_subject:reviewer},status:201};
}
export async function resolveVerifiedSensorSourceMapping(db,tenant,observation){
 const result=await db.prepare("SELECT m.id,m.sensor_id,m.parameter,m.unit,m.effective_from,m.effective_to,e.event_type FROM sensor_source_identity_mappings m JOIN sensor_source_mapping_events e ON e.mapping_id=m.id AND e.tenant_id=m.tenant_id WHERE m.tenant_id=? AND m.site_id=? AND m.asset_id=? AND m.source_id=? AND m.parameter=? AND m.unit=? AND m.effective_from<=? AND (m.effective_to IS NULL OR m.effective_to>?) AND e.id=(SELECT e2.id FROM sensor_source_mapping_events e2 WHERE e2.tenant_id=m.tenant_id AND e2.mapping_id=m.id ORDER BY e2.occurred_at DESC,e2.rowid DESC LIMIT 1) AND e.event_type='verified' ORDER BY m.effective_from DESC LIMIT 2")
 .bind(tenant,observation.site_id,observation.asset_id,observation.source_id,observation.metric,observation.unit,observation.observed_at,observation.observed_at).all();
 if(!Array.isArray(result?.results))throw new Error("sensor_source_mapping_lookup_invalid");
 if(result.results.length!==1)return null;
 const row=result.results[0];
 return {mapping_id:row.id,sensor_id:row.sensor_id,parameter:row.parameter,unit:row.unit,effective_from:row.effective_from,effective_to:row.effective_to};
}

export async function assignSensorSourceMappingReviewer(db,tenant,siteId,actor,body,action){
 if(!only(body,["reviewer_subject","evidence_ref","reason"])||!textOk(body.reviewer_subject,200)||body.reviewer_subject===actor||
 !textOk(body.evidence_ref,500)||(action==="revoke"&&!textOk(body.reason,2000)))return {error:"sensor_source_mapping_reviewer_request_invalid",status:400};
 if(action==="assign"){
  const member=await db.prepare("SELECT m.subject FROM tenant_memberships m JOIN tenants t ON t.id=m.tenant_id WHERE m.subject=? AND m.tenant_id=? AND m.status='active' AND t.status='active' LIMIT 2").bind(body.reviewer_subject,tenant).all();
  if(!Array.isArray(member?.results)||member.results.length!==1)return {error:"sensor_source_mapping_reviewer_membership_not_active",status:409};
 }
 const site=await db.prepare("SELECT id FROM sites WHERE tenant_id=? AND id=? LIMIT 2").bind(tenant,siteId).all();
 if(!Array.isArray(site?.results)||site.results.length!==1)return {error:"site_not_found",status:404};
 const first=action==="assign"
 ?db.prepare("INSERT INTO sensor_source_mapping_reviewers(tenant_id,site_id,reviewer_subject,status,assigned_by_subject,evidence_ref) VALUES(?,?,?,'active',?,?) ON CONFLICT(tenant_id,site_id,reviewer_subject) DO NOTHING").bind(tenant,siteId,body.reviewer_subject,actor,body.evidence_ref)
 :db.prepare("UPDATE sensor_source_mapping_reviewers SET status='revoked' WHERE tenant_id=? AND site_id=? AND reviewer_subject=? AND status='active'").bind(tenant,siteId,body.reviewer_subject);
 const result=await first.run();
 if(result?.meta?.changes!==1)return {error:"sensor_source_mapping_reviewer_state_conflict",status:409};
 return {data:{site_id:siteId,reviewer_subject:body.reviewer_subject,status:action==="assign"?"active":"revoked"},status:action==="assign"?201:200};
}

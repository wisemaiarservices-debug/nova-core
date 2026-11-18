const textOk=(v,n)=>typeof v==="string"&&v.length>0&&v.length<=n&&v.trim()===v&&!/[\u0000-\u001f\u007f]/.test(v);
const idOk=v=>textOk(v,160)&&/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(v);
const only=(v,keys)=>v!==null&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k));
const modules=new Set(["nova-core","neoagro","neogrid","neocell"]);
const digestOk=v=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v);

export async function registerTenantSource(db,tenant,site,actor,requestId,idempotencyKey,requestSha256,body){
 if(!only(body,["module","provider","source_type","display_name","license_reference","evidence_ref"])||
 !modules.has(body.module)||!textOk(body.provider,120)||!textOk(body.source_type,120)||
 !textOk(body.display_name,160)||(body.license_reference!==undefined&&body.license_reference!==null&&!textOk(body.license_reference,500))||
 !textOk(body.evidence_ref,500)||!idOk(tenant)||!idOk(site)||!textOk(actor,200)||
 !idOk(requestId)||!idOk(idempotencyKey)||!digestOk(requestSha256))return {error:"source_registration_request_invalid",status:400};
 const authority=await db.prepare("SELECT m.subject FROM tenant_memberships m JOIN tenants t ON t.id=m.tenant_id WHERE m.tenant_id=? AND m.subject=? AND m.status='active' AND m.role IN ('tenant_owner','tenant_admin') AND t.status='active' LIMIT 2").bind(tenant,actor).all();
 if(!Array.isArray(authority?.results)||authority.results.length!==1)return {error:"source_registration_not_found",status:404};
 const siteRow=await db.prepare("SELECT id FROM sites WHERE tenant_id=? AND id=? AND status='active' LIMIT 2").bind(tenant,site).all();
 if(!Array.isArray(siteRow?.results)||siteRow.results.length!==1)return {error:"source_registration_not_found",status:404};
 const prior=await db.prepare("SELECT source_id,request_sha256 FROM tenant_source_registration_requests WHERE tenant_id=? AND site_id=? AND actor_subject=? AND idempotency_key=? LIMIT 2").bind(tenant,site,actor,idempotencyKey).all();
 if(!Array.isArray(prior?.results))throw new Error("source_registration_idempotency_lookup_invalid");
 if(prior.results.length>1)throw new Error("source_registration_idempotency_ambiguous");
 if(prior.results.length===1){
  if(prior.results[0].request_sha256!==requestSha256)return {error:"source_registration_idempotency_conflict",status:409};
  const existing=await db.prepare("SELECT id,verification_status FROM sources WHERE id=? AND tenant_id=? AND site_id=? LIMIT 2").bind(prior.results[0].source_id,tenant,site).all();
  if(!Array.isArray(existing?.results))throw new Error("source_registration_replay_lookup_invalid");
  if(existing.results.length!==1)return {error:"source_registration_replay_source_not_found",status:404};
  return {data:{id:existing.results[0].id,tenant_id:tenant,site_id:site,verification_status:existing.results[0].verification_status},status:200,replayed:true};
 }
 const sourceId=crypto.randomUUID();
 const statements=[
  db.prepare("INSERT INTO sources(id,site_id,module,provider,source_type,display_name,endpoint_reference,verification_status,verification_method,license_reference,metadata_json,tenant_id,registered_by_subject) VALUES(?,?,?,?,?,?,NULL,'unverified',NULL,?,'{}',?,?)").bind(sourceId,site,body.module,body.provider,body.source_type,body.display_name,body.license_reference??null,tenant,actor),
  db.prepare("INSERT INTO tenant_source_events(id,tenant_id,site_id,source_id,actor_subject,event_type,evidence_ref,reason,request_id) VALUES(?,?,?,?,?,'registered',?,NULL,?)").bind(crypto.randomUUID(),tenant,site,sourceId,actor,body.evidence_ref,requestId),
  db.prepare("INSERT INTO tenant_source_registration_requests(id,tenant_id,site_id,actor_subject,idempotency_key,request_sha256,source_id,request_id) VALUES(?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),tenant,site,actor,idempotencyKey,requestSha256,sourceId,requestId),
 ];
 const results=await db.batch(statements);
 if(!Array.isArray(results)||results.length!==3||results.some(x=>x?.meta?.changes!==1))throw new Error("source_registration_atomic_write_failed");
 return {data:{id:sourceId,tenant_id:tenant,site_id:site,module:body.module,provider:body.provider,source_type:body.source_type,display_name:body.display_name,verification_status:"unverified"},status:201,replayed:false};
}

export async function assignTenantSourceReviewer(db,tenant,site,actor,body){
 if(!only(body,["reviewer_subject","evidence_ref"])||!textOk(body.reviewer_subject,200)||body.reviewer_subject===actor||!textOk(body.evidence_ref,500))return {error:"source_reviewer_request_invalid",status:400};
 const results=await db.batch([
  db.prepare("INSERT INTO tenant_source_reviewers(tenant_id,site_id,reviewer_subject,status,assigned_by_subject,evidence_ref) SELECT ?,?,?,'active',?,? WHERE EXISTS(SELECT 1 FROM tenants WHERE id=? AND status='active') AND EXISTS(SELECT 1 FROM sites WHERE tenant_id=? AND id=? AND status='active') AND EXISTS(SELECT 1 FROM tenant_memberships WHERE tenant_id=? AND subject=? AND status='active' AND role IN ('tenant_owner','tenant_admin')) AND EXISTS(SELECT 1 FROM tenant_memberships WHERE tenant_id=? AND subject=? AND status='active') ON CONFLICT(tenant_id,site_id,reviewer_subject) DO NOTHING").bind(tenant,site,body.reviewer_subject,actor,body.evidence_ref,tenant,tenant,site,tenant,actor,tenant,body.reviewer_subject),
  db.prepare("INSERT INTO tenant_source_reviewer_events(id,tenant_id,site_id,reviewer_subject,actor_subject,event_type,evidence_ref,request_id) SELECT ?,?,?,?,?,'assigned',?,? WHERE changes()=1").bind(crypto.randomUUID(),tenant,site,body.reviewer_subject,actor,body.evidence_ref,crypto.randomUUID()),
 ]);
 if(!Array.isArray(results)||results.length!==2||results[0]?.meta?.changes!==1||results[1]?.meta?.changes!==1)return {error:"source_reviewer_assignment_conflict",status:409};
 return {data:{tenant_id:tenant,site_id:site,reviewer_subject:body.reviewer_subject,status:"active"},status:201};
}

export async function reviewTenantSource(db,tenant,site,sourceId,reviewer,requestId,body){
 if(!only(body,["decision","evidence_ref","reason"])||!["verify","reject","revoke"].includes(body.decision)||!textOk(body.evidence_ref,500)||(body.decision!=="verify"&&!textOk(body.reason,2000))||(body.reason!==undefined&&!textOk(body.reason,2000)))return {error:"source_review_request_invalid",status:400};
 const assigned=await db.prepare("SELECT reviewer_subject FROM tenant_source_reviewers WHERE tenant_id=? AND site_id=? AND reviewer_subject=? AND status='active' LIMIT 2").bind(tenant,site,reviewer).all();
 if(!Array.isArray(assigned?.results)||assigned.results.length!==1)return {error:"source_reviewer_not_assigned",status:404};
 const source=await db.prepare("SELECT id,registered_by_subject FROM sources WHERE tenant_id=? AND site_id=? AND id=? LIMIT 2").bind(tenant,site,sourceId).all();
 if(!Array.isArray(source?.results)||source.results.length!==1)return {error:"source_not_found",status:404};
 if(source.results[0].registered_by_subject===reviewer)return {error:"source_submitter_cannot_review",status:409};
 const latest=await db.prepare("SELECT event_type FROM tenant_source_events WHERE tenant_id=? AND site_id=? AND source_id=? ORDER BY occurred_at DESC,rowid DESC LIMIT 1").bind(tenant,site,sourceId).all();
 if(!Array.isArray(latest?.results))throw new Error("source_history_invalid");
 const current=latest.results[0]?.event_type;
 const allowed={verify:"registered",reject:"registered",revoke:"verified"};
 if(current!==allowed[body.decision])return {error:"source_state_conflict",status:409};
 const eventType={verify:"verified",reject:"rejected",revoke:"revoked"}[body.decision];
 const result=await db.prepare("INSERT INTO tenant_source_events(id,tenant_id,site_id,source_id,actor_subject,event_type,evidence_ref,reason,request_id) VALUES(?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),tenant,site,sourceId,reviewer,eventType,body.evidence_ref,body.reason??null,requestId).run();
 if(!Number.isSafeInteger(result?.meta?.changes)||result.meta.changes<1)return {error:"source_state_conflict",status:409};
 return {data:{source_id:sourceId,status:eventType,reviewer_subject:reviewer},status:201};
}

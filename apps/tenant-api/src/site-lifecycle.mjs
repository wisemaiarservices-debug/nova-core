const validText=(value,max)=>typeof value==="string"&&value.length>0&&value.length<=max&&
 value.trim()===value&&!/[\u0000-\u001f\u007f]/.test(value);
const validId=value=>validText(value,160)&&/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
const onlyKeys=(value,allowed)=>value!==null&&typeof value==="object"&&!Array.isArray(value)&&
 Object.keys(value).every(key=>allowed.includes(key));
async function rows(statement){
 const result=await statement.all();
 if(!result||!Array.isArray(result.results))throw new Error("site_lifecycle_storage_invalid_result");
 return result.results;
}
async function digest(value){
 const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
 return Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,"0")).join("");
}
const EVENT_SELECT=`SELECT id,tenant_id,site_id,actor_subject,event_type,previous_status,
 new_status,reason,idempotency_key,request_digest,request_id,occurred_at
 FROM tenant_site_lifecycle_events WHERE tenant_id=? AND site_id=? AND actor_subject=? AND idempotency_key=? LIMIT 2`;

export function matchTenantSiteLifecycleRoute(url,method){
 const parsed=url instanceof URL?url:new URL(url);
 if(parsed.search||parsed.hash)return null;
 const match=parsed.pathname.match(/^\/internal\/v1\/tenants\/([^/]+)\/sites\/([^/]+)\/lifecycle-events$/);
 if(!match||!validId(match[1])||!validId(match[2])||method!=="GET")return null;
 return {tenant:match[1],site:match[2],action:"read"};
}

export async function changeTenantSiteLifecycle(db,{tenant,site,actorSubject,idempotencyKey,requestId,body,now}){
 if(!validId(tenant)||!validId(site)||!validText(actorSubject,200)||!validId(idempotencyKey)||
    !validId(requestId)||!onlyKeys(body,["action","reason"])||
    !["deactivate","reactivate"].includes(body.action)||!validText(body.reason,2000)||
    typeof now!=="string"||!Number.isFinite(Date.parse(now))||new Date(now).toISOString()!==now)
  return {error:"site_lifecycle_request_invalid",status:400};
 const previous=body.action==="deactivate"?"active":"inactive";
 const next=body.action==="deactivate"?"inactive":"active";
 const eventType=body.action==="deactivate"?"deactivated":"reactivated";
 const requestDigest=await digest(JSON.stringify([
  "nova-core-site-lifecycle-v1",tenant,site,actorSubject,body.action,body.reason
 ]));
 const replay=async()=>{
  const prior=await rows(db.prepare(EVENT_SELECT).bind(tenant,site,actorSubject,idempotencyKey));
  if(prior.length!==1)return null;
  if(prior[0].request_digest!==requestDigest)return {error:"site_lifecycle_idempotency_conflict",status:409};
  const {request_digest:_digest,...data}=prior[0];
  return {data,status:200};
 };
 const authorized=await rows(db.prepare(
  "SELECT site.status FROM sites site JOIN tenants tenant ON tenant.id=site.tenant_id AND tenant.status='active' JOIN tenant_memberships membership ON membership.tenant_id=site.tenant_id AND membership.subject=? AND membership.status='active' AND membership.role IN ('tenant_owner','tenant_admin') JOIN tenant_resource_grants grant_read ON grant_read.tenant_id=site.tenant_id AND grant_read.subject=membership.subject AND grant_read.resource_type='site' AND grant_read.resource_id=site.id AND grant_read.action='read' WHERE site.tenant_id=? AND site.id=? LIMIT 2"
 ).bind(actorSubject,tenant,site));
 if(authorized.length!==1)return {error:"site_not_found",status:404};
 const prior=await replay();
 if(prior)return prior;
 if(authorized[0].status!==previous)return {error:"site_lifecycle_state_conflict",status:409};
 try{
  const result=await db.prepare(
   "INSERT INTO tenant_site_lifecycle_events(id,tenant_id,site_id,actor_subject,event_type,previous_status,new_status,reason,idempotency_key,request_digest,request_id,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)"
  ).bind(crypto.randomUUID(),tenant,site,actorSubject,eventType,previous,next,body.reason,
    idempotencyKey,requestDigest,requestId,now).run();
  if(!Number.isSafeInteger(result?.meta?.changes)||result.meta.changes<1){
   const raced=await replay();
   return raced??{error:"site_lifecycle_state_conflict",status:409};
  }
  const saved=await rows(db.prepare(EVENT_SELECT).bind(tenant,site,actorSubject,idempotencyKey));
  if(saved.length!==1)throw new Error("site_lifecycle_event_missing_after_write");
  const {request_digest:_digest,...data}=saved[0];
  return {data,status:201};
 }catch{
  const raced=await replay();
  return raced??{error:"site_lifecycle_state_conflict",status:409};
 }
}

export async function readTenantSiteLifecycleEvents(db,tenant,site,actorSubject){
 if(!validId(tenant)||!validId(site)||!validText(actorSubject,200))return {error:"site_lifecycle_request_invalid",status:400};
 const authorized=await rows(db.prepare(
  "SELECT site.status FROM sites site JOIN tenants tenant ON tenant.id=site.tenant_id AND tenant.status='active' JOIN tenant_memberships membership ON membership.tenant_id=site.tenant_id AND membership.subject=? AND membership.status='active' JOIN tenant_resource_grants grant_read ON grant_read.tenant_id=site.tenant_id AND grant_read.subject=membership.subject AND grant_read.resource_type='site' AND grant_read.resource_id=site.id AND grant_read.action='read' WHERE site.tenant_id=? AND site.id=? LIMIT 2"
 ).bind(actorSubject,tenant,site));
 if(authorized.length!==1)return {error:"site_not_found",status:404};
 const events=await rows(db.prepare(
  "SELECT id,event_type,previous_status,new_status,reason,actor_subject,request_id,occurred_at FROM tenant_site_lifecycle_events WHERE tenant_id=? AND site_id=? ORDER BY occurred_at DESC,rowid DESC LIMIT 100"
 ).bind(tenant,site));
 return {data:{tenant_id:tenant,site_id:site,current_status:authorized[0].status,events},status:200};
}

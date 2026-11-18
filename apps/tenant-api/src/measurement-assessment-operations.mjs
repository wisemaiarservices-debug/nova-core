const validText=(v,n)=>typeof v==="string"&&v.length>0&&v.length<=n&&v.trim()===v&&!/[\\u0000-\\u001f\\u007f]/.test(v);
const validId=v=>validText(v,160)&&/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(v);
const validDigest=v=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v);
const validPredecessor=v=>v===null||v===undefined||validId(v);

async function rows(statement){
 const result=await statement.all();
 if(!result||!Array.isArray(result.results))throw new Error("assessment_operation_storage_invalid_result");
 return result.results;
}

const OPERATION_SELECT=`SELECT operation.operation_id,operation.tenant_id,operation.site_id,operation.observation_id,
 operation.actor_subject,operation.request_digest,operation.state,operation.assessment_id,
 operation.predecessor_operation_id,operation.lease_version,operation.lease_expires_at,
 operation.attempt_count,operation.created_at,operation.updated_at,operation.completed_at
 FROM measurement_assessment_operations operation
 JOIN tenant_memberships membership ON membership.tenant_id=operation.tenant_id
  AND membership.subject=operation.actor_subject AND membership.status='active'
 JOIN tenants tenant ON tenant.id=operation.tenant_id AND tenant.status='active'
 JOIN sites site ON site.id=operation.site_id AND site.tenant_id=operation.tenant_id AND site.status='active'
 JOIN tenant_resource_grants grant_read ON grant_read.tenant_id=operation.tenant_id
  AND grant_read.subject=operation.actor_subject AND grant_read.resource_type='site'
  AND grant_read.resource_id=operation.site_id AND grant_read.action='read'
 WHERE operation.tenant_id=? AND operation.actor_subject=? AND operation.operation_id=? LIMIT 2`;

export async function reserveMeasurementAssessmentOperation(db,tenant,siteId,observationId,actorSubject,requestDigest,requestId,predecessorOperationId=null){
 if(!validId(tenant)||!validId(siteId)||!validId(observationId)||!validText(actorSubject,200)||
    !validDigest(requestDigest)||!validId(requestId,80)||!validPredecessor(predecessorOperationId))
  return {error:"assessment_operation_request_invalid",status:400};

 const prior=await rows(db.prepare(
  "SELECT operation.operation_id,operation.tenant_id,operation.site_id,operation.observation_id,operation.actor_subject,operation.request_digest,operation.state,operation.assessment_id,operation.predecessor_operation_id,operation.lease_version,operation.lease_expires_at,operation.attempt_count,operation.created_at,operation.updated_at,operation.completed_at FROM measurement_assessment_operations operation JOIN tenant_memberships membership ON membership.tenant_id=operation.tenant_id AND membership.subject=operation.actor_subject AND membership.status='active' JOIN tenants tenant_row ON tenant_row.id=operation.tenant_id AND tenant_row.status='active' JOIN sites site_row ON site_row.id=operation.site_id AND site_row.tenant_id=operation.tenant_id AND site_row.status='active' JOIN tenant_resource_grants grant_read ON grant_read.tenant_id=operation.tenant_id AND grant_read.subject=operation.actor_subject AND grant_read.resource_type='site' AND grant_read.resource_id=operation.site_id AND grant_read.action='read' WHERE operation.tenant_id=? AND operation.site_id=? AND operation.observation_id=? AND operation.actor_subject=? AND operation.request_digest=? LIMIT 2"
 ).bind(tenant,siteId,observationId,actorSubject,requestDigest));
 if(prior.length>1)return {error:"assessment_operation_identity_conflict",status:409};
 if(prior.length===1)return {data:prior[0],status:200};
 const operationId=crypto.randomUUID();
 const eventId=crypto.randomUUID();
 const insert=`INSERT INTO measurement_assessment_operations
 (operation_id,tenant_id,site_id,observation_id,actor_subject,request_digest,state,predecessor_operation_id)
 SELECT ?,?,?,?,?,?,'reserved',?
 FROM observations observation
 JOIN tenants tenant_row ON tenant_row.id=observation.tenant_id AND tenant_row.status='active'
 JOIN sites site_row ON site_row.id=observation.site_id AND site_row.tenant_id=observation.tenant_id AND site_row.status='active'
 JOIN tenant_memberships membership ON membership.tenant_id=observation.tenant_id
  AND membership.subject=? AND membership.status='active'
 JOIN tenant_resource_grants grant_read ON grant_read.tenant_id=observation.tenant_id
  AND grant_read.subject=membership.subject AND grant_read.resource_type='site'
  AND grant_read.resource_id=observation.site_id AND grant_read.action='read'
 WHERE observation.tenant_id=? AND observation.site_id=? AND observation.id=?
 AND (
  (? IS NULL AND NOT EXISTS (
    SELECT 1 FROM measurement_assessment_operations prior
    WHERE prior.tenant_id=observation.tenant_id AND prior.actor_subject=membership.subject
      AND prior.observation_id=observation.id
  ))
  OR
  (? IS NOT NULL AND EXISTS (
    SELECT 1 FROM measurement_assessment_operations predecessor
    WHERE predecessor.operation_id=? AND predecessor.tenant_id=observation.tenant_id
      AND predecessor.site_id=observation.site_id AND predecessor.observation_id=observation.id
      AND predecessor.actor_subject=membership.subject
      AND predecessor.state IN ('completed','not_assessed')
      AND NOT EXISTS (
        SELECT 1 FROM measurement_assessment_operations successor
        WHERE successor.tenant_id=predecessor.tenant_id
          AND successor.predecessor_operation_id=predecessor.operation_id
      )
  ))
 )
 ON CONFLICT DO NOTHING`;
 const event=`INSERT INTO measurement_assessment_operation_events
 (event_id,operation_id,tenant_id,site_id,observation_id,actor_subject,from_state,to_state,event_type,request_id)
 SELECT ?,operation_id,tenant_id,site_id,observation_id,actor_subject,NULL,'reserved','reserved',?
 FROM measurement_assessment_operations
 WHERE operation_id=? AND tenant_id=? AND actor_subject=? AND state='reserved'
 AND NOT EXISTS (SELECT 1 FROM measurement_assessment_operation_events WHERE operation_id=?)`;
 const results=await db.batch([
  db.prepare(insert).bind(operationId,tenant,siteId,observationId,actorSubject,requestDigest,predecessorOperationId,
    actorSubject,tenant,siteId,observationId,predecessorOperationId,predecessorOperationId,predecessorOperationId),
  db.prepare(event).bind(eventId,requestId,operationId,tenant,actorSubject,operationId)
 ]);
 if(!Array.isArray(results)||results.length!==2||!Number.isInteger(results[0]?.meta?.changes)||!Number.isInteger(results[1]?.meta?.changes))
  throw new Error("assessment_operation_reservation_batch_invalid");
 if(results[0].meta.changes===1){
  if(results[1].meta.changes!==1)throw new Error("assessment_operation_reservation_event_missing");
  return {data:{operation_id:operationId,tenant_id:tenant,site_id:siteId,observation_id:observationId,
   actor_subject:actorSubject,request_digest:requestDigest,state:"reserved",assessment_id:null,
   predecessor_operation_id:predecessorOperationId,lease_version:0,lease_expires_at:null,attempt_count:0},status:201};
 }
 const active=await rows(db.prepare(
  "SELECT operation_id,tenant_id,site_id,observation_id,actor_subject,request_digest,state,assessment_id,predecessor_operation_id,lease_version,lease_expires_at,attempt_count,created_at,updated_at,completed_at FROM measurement_assessment_operations WHERE tenant_id=? AND actor_subject=? AND observation_id=? AND state IN ('reserved','running') LIMIT 2"
 ).bind(tenant,actorSubject,observationId));
 if(active.length===1){
  if(active[0].request_digest!==requestDigest||active[0].site_id!==siteId)
   return {error:"assessment_operation_conflict",status:409};
  return {data:active[0],status:200};
 }
 return {error:"assessment_operation_not_available",status:404};
}

export async function readMeasurementAssessmentOperation(db,tenant,actorSubject,operationId){
 if(!validId(tenant)||!validText(actorSubject,200)||!validId(operationId))
  return {error:"assessment_operation_request_invalid",status:400};
 const found=await rows(db.prepare(OPERATION_SELECT).bind(tenant,actorSubject,operationId));
 if(found.length!==1)return {error:"assessment_operation_not_found",status:404};
 const events=await rows(db.prepare(
  "SELECT event_id,from_state,to_state,event_type,request_id,occurred_at FROM measurement_assessment_operation_events WHERE tenant_id=? AND operation_id=? AND actor_subject=? ORDER BY occurred_at,event_id"
 ).bind(tenant,operationId,actorSubject));
 return {data:{...found[0],events},status:200};
}

const validText=(v,n)=>typeof v==="string"&&v.length>0&&v.length<=n&&v.trim()===v&&!Array.from(v).some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127);
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
 operation.predecessor_operation_id,operation.lease_version,operation.lease_expires_at,operation.lease_request_id,
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
  "SELECT operation.operation_id,operation.tenant_id,operation.site_id,operation.observation_id,operation.actor_subject,operation.request_digest,operation.state,operation.assessment_id,operation.predecessor_operation_id,operation.lease_version,operation.lease_expires_at,operation.lease_request_id,operation.attempt_count,operation.created_at,operation.updated_at,operation.completed_at FROM measurement_assessment_operations operation JOIN tenant_memberships membership ON membership.tenant_id=operation.tenant_id AND membership.subject=operation.actor_subject AND membership.status='active' JOIN tenants tenant_row ON tenant_row.id=operation.tenant_id AND tenant_row.status='active' JOIN sites site_row ON site_row.id=operation.site_id AND site_row.tenant_id=operation.tenant_id AND site_row.status='active' JOIN tenant_resource_grants grant_read ON grant_read.tenant_id=operation.tenant_id AND grant_read.subject=operation.actor_subject AND grant_read.resource_type='site' AND grant_read.resource_id=operation.site_id AND grant_read.action='read' WHERE operation.tenant_id=? AND operation.site_id=? AND operation.observation_id=? AND operation.actor_subject=? AND operation.request_digest=? LIMIT 2"
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
  "SELECT operation_id,tenant_id,site_id,observation_id,actor_subject,request_digest,state,assessment_id,predecessor_operation_id,lease_version,lease_expires_at,lease_request_id,attempt_count,created_at,updated_at,completed_at FROM measurement_assessment_operations WHERE tenant_id=? AND actor_subject=? AND observation_id=? AND state IN ('reserved','running') LIMIT 2"
 ).bind(tenant,actorSubject,observationId));
 if(active.length===1){
  if(active[0].request_digest!==requestDigest||active[0].site_id!==siteId)
   return {error:"assessment_operation_conflict",status:409};
  return {data:active[0],status:200};
 }
 return {error:"assessment_operation_not_available",status:404};
}

const OPERATION_HISTORY_SELECT=`SELECT operation.operation_id,operation.tenant_id,operation.site_id,operation.observation_id,
 operation.actor_subject,operation.request_digest,operation.state,operation.assessment_id,
 operation.predecessor_operation_id,operation.lease_version,operation.lease_expires_at,operation.lease_request_id,
 operation.attempt_count,operation.created_at,operation.updated_at,operation.completed_at
 FROM measurement_assessment_operations operation
 JOIN tenant_memberships membership ON membership.tenant_id=operation.tenant_id
  AND membership.subject=operation.actor_subject AND membership.status='active'
 JOIN tenants tenant ON tenant.id=operation.tenant_id AND tenant.status='active'
 JOIN sites site ON site.id=operation.site_id AND site.tenant_id=operation.tenant_id
  AND site.status IN ('active','inactive')
 JOIN tenant_resource_grants grant_read ON grant_read.tenant_id=operation.tenant_id
  AND grant_read.subject=operation.actor_subject AND grant_read.resource_type='site'
  AND grant_read.resource_id=operation.site_id AND grant_read.action='read'
 WHERE operation.tenant_id=? AND operation.actor_subject=? AND operation.operation_id=? LIMIT 2`;

export async function readMeasurementAssessmentOperation(db,tenant,actorSubject,operationId){
 if(!validId(tenant)||!validText(actorSubject,200)||!validId(operationId))
  return {error:"assessment_operation_request_invalid",status:400};
 const found=await rows(db.prepare(OPERATION_HISTORY_SELECT).bind(tenant,actorSubject,operationId));
 if(found.length!==1)return {error:"assessment_operation_not_found",status:404};
 const events=await rows(db.prepare(
  "SELECT event_id,from_state,to_state,event_type,request_id,occurred_at FROM measurement_assessment_operation_events WHERE tenant_id=? AND operation_id=? AND actor_subject=? ORDER BY occurred_at,event_id"
 ).bind(tenant,operationId,actorSubject));
 let assessment=null;
 if(["completed","not_assessed"].includes(found[0].state)){
  const assessments=await rows(db.prepare(
   "SELECT id,tenant_id,site_id,observation_id,status,reason_code,mapping_id,calibration_id,policy_id,method_version,request_id FROM measurement_quality_assessments WHERE tenant_id=? AND site_id=? AND observation_id=? AND request_id=? AND operation_actor_subject=? LIMIT 2"
  ).bind(tenant,found[0].site_id,found[0].observation_id,operationId,actorSubject));
  if(assessments.length!==1||assessments[0].id!==found[0].assessment_id)
   return {error:"assessment_operation_result_unavailable",status:409};
  assessment=assessments[0];
 }
 return {data:{...found[0],assessment,events},status:200};
}


const validIsoTime=v=>{if(typeof v!=="string")return false;try{return Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;}catch{return false;}};

export async function claimMeasurementAssessmentOperation(db,tenant,actorSubject,operationId,requestId,now,leaseExpiresAt){
 if(!validId(tenant)||!validText(actorSubject,200)||!validId(operationId)||!validId(requestId,80)||
    !validIsoTime(now)||!validIsoTime(leaseExpiresAt))
  return {error:"assessment_operation_claim_invalid",status:400};
 const nowMs=Date.parse(now),expiryMs=Date.parse(leaseExpiresAt);
 if(expiryMs<=nowMs||expiryMs>nowMs+300000)
  return {error:"assessment_operation_lease_window_invalid",status:400};
 const current=await rows(db.prepare(OPERATION_SELECT).bind(tenant,actorSubject,operationId));
 if(current.length!==1)return {error:"assessment_operation_not_found",status:404};
 const operation=current[0];
 let fromState,eventType,statePredicate,stateValues;
 if(operation.state==="reserved"){
  fromState="reserved";eventType="claimed";
  statePredicate="state='reserved' AND lease_expires_at IS NULL";
  stateValues=[];
 }else if(operation.state==="running"&&typeof operation.lease_expires_at==="string"&&Date.parse(operation.lease_expires_at)<=nowMs){
  fromState="running";eventType="lease_recovered";
  statePredicate="state='running' AND lease_version=? AND lease_expires_at=? AND lease_expires_at<=?";
  stateValues=[operation.lease_version,operation.lease_expires_at,now];
 }else{
  return {error:"assessment_operation_state_conflict",status:409};
 }
 const update=`UPDATE measurement_assessment_operations
 SET state='running',lease_version=lease_version+1,attempt_count=attempt_count+1,
     lease_expires_at=?,lease_request_id=?,updated_at=?
 WHERE operation_id=? AND tenant_id=? AND site_id=? AND observation_id=?
 AND actor_subject=? AND ${statePredicate}
 AND EXISTS (SELECT 1 FROM tenant_memberships membership
   JOIN tenants tenant_row ON tenant_row.id=membership.tenant_id AND tenant_row.status='active'
   WHERE membership.tenant_id=? AND membership.subject=? AND membership.status='active')
 AND EXISTS (SELECT 1 FROM sites site_row WHERE site_row.id=? AND site_row.tenant_id=? AND site_row.status='active')
 AND EXISTS (SELECT 1 FROM tenant_resource_grants grant_read
   WHERE grant_read.tenant_id=? AND grant_read.subject=? AND grant_read.resource_type='site'
     AND grant_read.resource_id=? AND grant_read.action='read')`;
 const event=`INSERT INTO measurement_assessment_operation_events
 (event_id,operation_id,tenant_id,site_id,observation_id,actor_subject,from_state,to_state,event_type,request_id)
 SELECT ?,operation_id,tenant_id,site_id,observation_id,actor_subject,?,'running',?,?
 FROM measurement_assessment_operations
 WHERE operation_id=? AND tenant_id=? AND actor_subject=? AND state='running'
   AND lease_request_id=? AND lease_expires_at=?
   AND NOT EXISTS (SELECT 1 FROM measurement_assessment_operation_events
     WHERE operation_id=? AND request_id=?)`;
 const eventId=crypto.randomUUID();
 const results=await db.batch([
  db.prepare(update).bind(leaseExpiresAt,requestId,now,operationId,tenant,operation.site_id,operation.observation_id,
    actorSubject,...stateValues,tenant,actorSubject,operation.site_id,tenant,tenant,actorSubject,operation.site_id),
  db.prepare(event).bind(eventId,fromState,eventType,requestId,operationId,tenant,actorSubject,
    requestId,leaseExpiresAt,operationId,requestId)
 ]);
 if(!Array.isArray(results)||results.length!==2||!Number.isInteger(results[0]?.meta?.changes)||!Number.isInteger(results[1]?.meta?.changes))
  throw new Error("assessment_operation_claim_batch_invalid");
 if(results[0].meta.changes===0)return {error:"assessment_operation_state_conflict",status:409};
 if(results[0].meta.changes!==1||results[1].meta.changes!==1)
  throw new Error("assessment_operation_claim_event_missing");
 return {data:{...operation,state:"running",lease_version:operation.lease_version+1,
  lease_expires_at:leaseExpiresAt,lease_request_id:requestId,attempt_count:operation.attempt_count+1,
  updated_at:now},status:200};
}


export async function renewMeasurementAssessmentOperationLease(db,tenant,actorSubject,operationId,
 expectedLeaseVersion,expectedLeaseRequestId,expectedLeaseExpiresAt,newRequestId,now,newLeaseExpiresAt){
 if(!validId(tenant)||!validText(actorSubject,200)||!validId(operationId)||
    !Number.isSafeInteger(expectedLeaseVersion)||expectedLeaseVersion<1||
    !validId(expectedLeaseRequestId)||!validIsoTime(expectedLeaseExpiresAt)||
    !validId(newRequestId)||newRequestId===expectedLeaseRequestId||
    !validIsoTime(now)||!validIsoTime(newLeaseExpiresAt))
  return {error:"assessment_operation_lease_renewal_invalid",status:400};
 const nowMs=Date.parse(now),oldExpiryMs=Date.parse(expectedLeaseExpiresAt),newExpiryMs=Date.parse(newLeaseExpiresAt);
 if(oldExpiryMs<=nowMs||newExpiryMs<=oldExpiryMs||newExpiryMs>nowMs+300000)
  return {error:"assessment_operation_lease_renewal_window_invalid",status:409};
 const current=await rows(db.prepare(OPERATION_SELECT).bind(tenant,actorSubject,operationId));
 if(current.length!==1)return {error:"assessment_operation_not_found",status:404};
 const operation=current[0];
 if(operation.state!=="running"||operation.lease_version!==expectedLeaseVersion||
    operation.lease_request_id!==expectedLeaseRequestId||operation.lease_expires_at!==expectedLeaseExpiresAt)
  return {error:"assessment_operation_lease_conflict",status:409};
 const update=`UPDATE measurement_assessment_operations
 SET lease_version=lease_version+1,lease_expires_at=?,lease_request_id=?,updated_at=?
 WHERE operation_id=? AND tenant_id=? AND site_id=? AND observation_id=? AND actor_subject=?
 AND state='running' AND lease_version=? AND lease_request_id=? AND lease_expires_at=? AND lease_expires_at>?
 AND EXISTS (SELECT 1 FROM tenant_memberships membership
   JOIN tenants tenant_row ON tenant_row.id=membership.tenant_id AND tenant_row.status='active'
   WHERE membership.tenant_id=? AND membership.subject=? AND membership.status='active')
 AND EXISTS (SELECT 1 FROM sites site_row WHERE site_row.id=? AND site_row.tenant_id=? AND site_row.status='active')
 AND EXISTS (SELECT 1 FROM tenant_resource_grants grant_read
   WHERE grant_read.tenant_id=? AND grant_read.subject=? AND grant_read.resource_type='site'
     AND grant_read.resource_id=? AND grant_read.action='read')`;
 const event=`INSERT INTO measurement_assessment_operation_events
 (event_id,operation_id,tenant_id,site_id,observation_id,actor_subject,from_state,to_state,event_type,request_id)
 SELECT ?,operation_id,tenant_id,site_id,observation_id,actor_subject,'running','running','lease_renewed',?
 FROM measurement_assessment_operations
 WHERE operation_id=? AND tenant_id=? AND actor_subject=? AND state='running'
   AND lease_version=? AND lease_request_id=? AND lease_expires_at=?
   AND NOT EXISTS (SELECT 1 FROM measurement_assessment_operation_events
     WHERE operation_id=? AND request_id=?)`;
 const eventId=crypto.randomUUID();
 const results=await db.batch([
  db.prepare(update).bind(newLeaseExpiresAt,newRequestId,now,operationId,tenant,operation.site_id,
   operation.observation_id,actorSubject,expectedLeaseVersion,expectedLeaseRequestId,expectedLeaseExpiresAt,now,
   tenant,actorSubject,operation.site_id,tenant,tenant,actorSubject,operation.site_id),
  db.prepare(event).bind(eventId,newRequestId,operationId,tenant,actorSubject,expectedLeaseVersion+1,
   newRequestId,newLeaseExpiresAt,operationId,newRequestId)
 ]);
 if(!Array.isArray(results)||results.length!==2||!Number.isInteger(results[0]?.meta?.changes)||
    !Number.isInteger(results[1]?.meta?.changes))
  throw new Error("assessment_operation_lease_renewal_batch_invalid");
 if(results[0].meta.changes===0)return {error:"assessment_operation_lease_conflict",status:409};
 if(results[0].meta.changes!==1||results[1].meta.changes!==1)
  throw new Error("assessment_operation_lease_renewal_event_missing");
 return {data:{...operation,lease_version:expectedLeaseVersion+1,
  lease_request_id:newRequestId,lease_expires_at:newLeaseExpiresAt,updated_at:now},status:200};
}

import { evaluateMeasurementQuality } from "./measurement-quality.mjs";

const validText=(value,max)=>typeof value==="string"&&value.length>0&&value.length<=max&&
 value.trim()===value&&!Array.from(value).some(character=>character.charCodeAt(0)<32||character.charCodeAt(0)===127);
const validId=value=>validText(value,160)&&/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
const validTime=value=>{if(typeof value!=="string")return false;try{return Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;}catch{return false;}};
async function rows(statement){
 const result=await statement.all();
 if(!result||!Array.isArray(result.results))throw new Error("assessment_completion_storage_invalid_result");
 return result.results;
}

const OPERATION_SQL=`SELECT operation.operation_id,operation.tenant_id,operation.site_id,
 operation.observation_id,operation.actor_subject,operation.state,operation.assessment_id,
 operation.lease_version,operation.lease_expires_at,operation.lease_request_id,site.status AS site_status
 FROM measurement_assessment_operations operation
 JOIN tenants tenant ON tenant.id=operation.tenant_id AND tenant.status='active'
 JOIN sites site ON site.id=operation.site_id AND site.tenant_id=operation.tenant_id
 JOIN tenant_memberships membership ON membership.tenant_id=operation.tenant_id
  AND membership.subject=operation.actor_subject AND membership.status='active'
 JOIN tenant_resource_grants grant_read ON grant_read.tenant_id=operation.tenant_id
  AND grant_read.subject=operation.actor_subject AND grant_read.resource_type='site'
  AND grant_read.resource_id=operation.site_id AND grant_read.action='read'
 WHERE operation.operation_id=? AND operation.tenant_id=? AND operation.actor_subject=? LIMIT 2`;

const ASSESSMENT_SQL=`SELECT id,tenant_id,site_id,observation_id,status,reason_code,
 mapping_id,calibration_id,policy_id,method_version,request_id
 FROM measurement_quality_assessments
 WHERE tenant_id=? AND request_id=? AND operation_actor_subject=? LIMIT 2`;

const INSERT_SQL=`WITH operation_context AS (
 SELECT operation.operation_id,operation.tenant_id,operation.site_id,operation.observation_id,
  operation.actor_subject,operation.lease_version,operation.lease_request_id,
  observation.source_id,observation.module,observation.metric,observation.value,
  observation.unit,observation.observed_at,observation.provenance_json,
  observation.verification_status,site.status AS site_status
 FROM measurement_assessment_operations operation
 JOIN observations observation ON observation.id=operation.observation_id
  AND observation.tenant_id=operation.tenant_id AND observation.site_id=operation.site_id
 JOIN tenants tenant ON tenant.id=operation.tenant_id AND tenant.status='active'
 JOIN sites site ON site.id=operation.site_id AND site.tenant_id=operation.tenant_id
 JOIN tenant_memberships membership ON membership.tenant_id=operation.tenant_id
  AND membership.subject=operation.actor_subject AND membership.status='active'
 JOIN tenant_resource_grants grant_read ON grant_read.tenant_id=operation.tenant_id
  AND grant_read.subject=operation.actor_subject AND grant_read.resource_type='site'
  AND grant_read.resource_id=operation.site_id AND grant_read.action='read'
 WHERE operation.operation_id=? AND operation.tenant_id=? AND operation.actor_subject=?
  AND operation.state='running' AND operation.lease_version=?
  AND operation.lease_request_id=? AND operation.lease_expires_at>?
),
evidence_gate AS (
 SELECT CASE WHEN ctx.site_status='active' AND ? IN ('passed','failed')
  AND ctx.verification_status='verified'
  AND EXISTS (
   SELECT 1 FROM assets asset WHERE asset.id=? AND asset.tenant_id=ctx.tenant_id
    AND asset.site_id=ctx.site_id AND asset.status='active'
  )
  AND EXISTS (
   SELECT 1 FROM sources source WHERE source.id=ctx.source_id
    AND source.tenant_id=ctx.tenant_id AND source.module=ctx.module
    AND source.verification_status='verified'
    AND (source.site_id IS NULL OR source.site_id=ctx.site_id)
  )
  AND EXISTS (
   SELECT 1 FROM sensor_source_identity_mappings mapping
   JOIN sensor_source_mapping_events event ON event.mapping_id=mapping.id
    AND event.tenant_id=mapping.tenant_id
   WHERE mapping.id=? AND mapping.tenant_id=ctx.tenant_id AND mapping.site_id=ctx.site_id
    AND mapping.asset_id=? AND mapping.sensor_id=? AND mapping.source_id=ctx.source_id
    AND mapping.parameter=ctx.metric AND mapping.unit=ctx.unit
    AND mapping.effective_from<=ctx.observed_at
    AND (mapping.effective_to IS NULL OR mapping.effective_to>ctx.observed_at)
    AND event.id=(SELECT latest.id FROM sensor_source_mapping_events latest
      WHERE latest.tenant_id=mapping.tenant_id AND latest.mapping_id=mapping.id
      ORDER BY latest.occurred_at DESC,latest.rowid DESC LIMIT 1)
    AND event.event_type='verified'
  )
  AND EXISTS (
   SELECT 1 FROM sensor_calibrations calibration
   JOIN sensor_calibration_verification_events event ON event.calibration_id=calibration.id
    AND event.tenant_id=calibration.tenant_id
   WHERE calibration.id=? AND calibration.tenant_id=ctx.tenant_id
    AND calibration.site_id=ctx.site_id AND calibration.asset_id=?
    AND calibration.sensor_id=? AND calibration.parameter=ctx.metric
    AND calibration.unit=ctx.unit AND calibration.calibrated_at<=ctx.observed_at
    AND calibration.valid_until>=ctx.observed_at
    AND event.id=(SELECT latest.id FROM sensor_calibration_verification_events latest
      WHERE latest.tenant_id=calibration.tenant_id AND latest.calibration_id=calibration.id
      ORDER BY latest.occurred_at DESC,latest.rowid DESC LIMIT 1)
    AND event.event_type='verified'
  )
  AND EXISTS (
   SELECT 1 FROM measurement_quality_policies policy
   JOIN measurement_quality_policy_events event ON event.policy_id=policy.id
    AND event.tenant_id=policy.tenant_id
   WHERE policy.id=? AND policy.tenant_id=ctx.tenant_id AND policy.site_id=ctx.site_id
    AND policy.asset_id=? AND policy.sensor_id=? AND policy.parameter=ctx.metric
    AND policy.unit=ctx.unit AND policy.effective_from<=ctx.observed_at
    AND (policy.effective_to IS NULL OR policy.effective_to>ctx.observed_at)
    AND policy.minimum_value IS ? AND policy.maximum_value IS ? AND policy.version=?
    AND event.id=(SELECT latest.id FROM measurement_quality_policy_events latest
      WHERE latest.tenant_id=policy.tenant_id AND latest.policy_id=policy.id
      ORDER BY latest.occurred_at DESC,latest.rowid DESC LIMIT 1)
    AND event.event_type='verified'
  )
  AND ((?='passed' AND (? IS NULL OR ctx.value>=?) AND (? IS NULL OR ctx.value<=?))
    OR (?='failed' AND ((? IS NOT NULL AND ctx.value<?) OR (? IS NOT NULL AND ctx.value>?))))
 THEN 1 ELSE 0 END AS approved
 FROM operation_context ctx
)
INSERT INTO measurement_quality_assessments
 (id,tenant_id,site_id,observation_id,mapping_id,calibration_id,policy_id,status,
  reason_code,observed_value,unit,method_version,request_id,operation_actor_subject,
  operation_lease_version,operation_lease_request_id,operation_terminal_request_id,
  operation_completed_at)
SELECT ?,ctx.tenant_id,ctx.site_id,ctx.observation_id,
 CASE WHEN gate.approved=1 THEN ? ELSE NULL END,
 CASE WHEN gate.approved=1 THEN ? ELSE NULL END,
 CASE WHEN gate.approved=1 THEN ? ELSE NULL END,
 CASE WHEN gate.approved=1 THEN ? ELSE 'not_assessed' END,
 CASE WHEN gate.approved=1 THEN ?
  WHEN ctx.site_status='inactive' THEN 'site_inactive_at_completion'
  WHEN ?='not_assessed' THEN ? ELSE 'governance_state_changed_before_assessment' END,
 ctx.value,ctx.unit,'1.0.0',ctx.operation_id,ctx.actor_subject,
 ctx.lease_version,ctx.lease_request_id,?,?
FROM operation_context ctx CROSS JOIN evidence_gate gate
WHERE 1=1
ON CONFLICT(tenant_id,request_id) DO NOTHING`;

export async function completeMeasurementAssessmentOperation(db,{
 tenant,actorSubject,operationId,expectedLeaseVersion,expectedLeaseRequestId,
 terminalRequestId,now
}){
 if(!validId(tenant)||!validText(actorSubject,200)||!validId(operationId)||
    !Number.isSafeInteger(expectedLeaseVersion)||expectedLeaseVersion<1||
    !validId(expectedLeaseRequestId)||!validId(terminalRequestId)||
    terminalRequestId===expectedLeaseRequestId||!validTime(now))
  return {error:"assessment_completion_request_invalid",status:400};

 const found=await rows(db.prepare(OPERATION_SQL).bind(operationId,tenant,actorSubject));
 if(found.length!==1)return {error:"assessment_operation_not_found",status:404};
 const operation=found[0];
 if(operation.state==="completed"||operation.state==="not_assessed"){
  const prior=await rows(db.prepare(ASSESSMENT_SQL).bind(tenant,operationId,actorSubject));
  if(prior.length!==1)return {error:"assessment_operation_result_unavailable",status:409};
  return {data:prior[0],status:200};
 }
 if(!["active","inactive"].includes(operation.site_status))
  return {error:"assessment_operation_site_unavailable",status:409};
 if(operation.state!=="running"||operation.lease_version!==expectedLeaseVersion||
    operation.lease_request_id!==expectedLeaseRequestId||
    typeof operation.lease_expires_at!=="string"||Date.parse(operation.lease_expires_at)<=Date.parse(now))
  return {error:"assessment_operation_lease_conflict",status:409};

 const decision=await evaluateMeasurementQuality(db,tenant,operation.observation_id);
 if(decision?.error)return decision;
 if(!decision?.observation||decision.observation.id!==operation.observation_id||
    decision.observation.tenant_id!==tenant||decision.observation.site_id!==operation.site_id||
    !["passed","failed","not_assessed"].includes(decision.status))
  throw new Error("assessment_completion_evaluator_result_invalid");

 const mapping=decision.mapping??null;
 const calibration=decision.calibration??null;
 const policy=decision.policy??null;
 const values=[
  operationId,tenant,actorSubject,expectedLeaseVersion,expectedLeaseRequestId,now,
  decision.status,
  mapping?.asset_id??null,mapping?.id??null,mapping?.asset_id??null,mapping?.sensor_id??null,
  calibration?.id??null,mapping?.asset_id??null,mapping?.sensor_id??null,
  policy?.id??null,mapping?.asset_id??null,mapping?.sensor_id??null,
  policy?.minimum_value??null,policy?.maximum_value??null,policy?.version??null,
  decision.status,policy?.minimum_value??null,policy?.minimum_value??null,
  policy?.maximum_value??null,policy?.maximum_value??null,
  decision.status,policy?.minimum_value??null,policy?.minimum_value??null,
  policy?.maximum_value??null,policy?.maximum_value??null,
  crypto.randomUUID(),mapping?.id??null,calibration?.id??null,policy?.id??null,
  decision.status,decision.reason,decision.status,decision.reason,terminalRequestId,now
 ];
 const result=await db.prepare(INSERT_SQL).bind(...values).run();
 if(result?.meta?.changes===1){
  const saved=await rows(db.prepare(ASSESSMENT_SQL).bind(tenant,operationId,actorSubject));
  if(saved.length!==1)throw new Error("assessment_completion_saved_result_missing");
  return {data:saved[0],status:201};
 }
 const replay=await rows(db.prepare(ASSESSMENT_SQL).bind(tenant,operationId,actorSubject));
 if(replay.length===1)return {data:replay[0],status:200};
 return {error:"assessment_operation_lease_or_governance_conflict",status:409};
}

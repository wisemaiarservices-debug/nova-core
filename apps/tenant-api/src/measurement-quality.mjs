const validText=(v,n)=>typeof v==="string"&&v.length>0&&v.length<=n&&v.trim()===v&&!/[\u0000-\u001f\u007f]/.test(v);
const validId=v=>validText(v,160)&&/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(v);
const onlyKeys=(v,k)=>v!==null&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).every(x=>k.includes(x));
const validTime=v=>typeof v==="string"&&Number.isFinite(Date.parse(v))&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(v);

export async function registerMeasurementQualityPolicy(db,tenant,siteId,assetId,actor,body){
 if(!onlyKeys(body,["id","sensor_id","parameter","unit","version","minimum_value","maximum_value","effective_from","effective_to","method","evidence_ref"])||
 !validId(body.id)||!validId(body.sensor_id)||!validText(body.parameter,120)||!validText(body.unit,48)||
 !validText(body.version,80)||(!Number.isFinite(body.minimum_value)&&!Number.isFinite(body.maximum_value))||
 (body.minimum_value!==undefined&&!Number.isFinite(body.minimum_value))||
 (body.maximum_value!==undefined&&!Number.isFinite(body.maximum_value))||
 (body.minimum_value!==undefined&&body.maximum_value!==undefined&&body.minimum_value>body.maximum_value)||
 !validTime(body.effective_from)||(body.effective_to!==undefined&&body.effective_to!==null&&(!validTime(body.effective_to)||body.effective_to<=body.effective_from))||
 !validText(body.method,160)||!validText(body.evidence_ref,500))return {error:"measurement_quality_policy_request_invalid",status:400};
 const asset=await db.prepare("SELECT id FROM assets WHERE tenant_id=? AND site_id=? AND id=? AND status='active' LIMIT 2").bind(tenant,siteId,assetId).all();
 if(!Array.isArray(asset?.results)||asset.results.length!==1)return {error:"asset_not_found",status:404};
 const result=await db.prepare("INSERT INTO measurement_quality_policies(id,tenant_id,site_id,asset_id,sensor_id,parameter,unit,version,minimum_value,maximum_value,effective_from,effective_to,method,evidence_ref,registered_by_subject) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
 .bind(body.id,tenant,siteId,assetId,body.sensor_id,body.parameter,body.unit,body.version,body.minimum_value??null,body.maximum_value??null,body.effective_from,body.effective_to??null,body.method,body.evidence_ref,actor).run();
 if(result?.meta?.changes!==1)throw new Error("measurement_quality_policy_write_failed");
 return {data:{id:body.id,tenant_id:tenant,site_id:siteId,asset_id:assetId,sensor_id:body.sensor_id,parameter:body.parameter,unit:body.unit,version:body.version,status:"registered_unverified"},status:201};
}

export async function reviewMeasurementQualityPolicy(db,tenant,siteId,assetId,policyId,reviewer,requestId,body){
 if(!onlyKeys(body,["decision","evidence_ref","reason"])||!["verify","reject","revoke"].includes(body.decision)||
 !validText(body.evidence_ref,500)||(body.decision!=="verify"&&!validText(body.reason,2000))||
 (body.reason!==undefined&&!validText(body.reason,2000)))return {error:"measurement_quality_policy_review_invalid",status:400};
 const policy=await db.prepare("SELECT id,registered_by_subject FROM measurement_quality_policies WHERE tenant_id=? AND site_id=? AND asset_id=? AND id=? LIMIT 2").bind(tenant,siteId,assetId,policyId).all();
 if(!Array.isArray(policy?.results)||policy.results.length!==1)return {error:"measurement_quality_policy_not_found",status:404};
 if(policy.results[0].registered_by_subject===reviewer)return {error:"policy_submitter_cannot_review",status:409};
 const assigned=await db.prepare("SELECT reviewer_subject FROM observation_reviewers WHERE tenant_id=? AND site_id=? AND reviewer_subject=? AND reviewer_role='measurement_reviewer' AND status='active' LIMIT 2").bind(tenant,siteId,reviewer).all();
 if(!Array.isArray(assigned?.results)||assigned.results.length!==1)return {error:"measurement_reviewer_assignment_not_found",status:404};
 const history=await db.prepare("SELECT event_type FROM measurement_quality_policy_events WHERE tenant_id=? AND policy_id=? ORDER BY occurred_at DESC,rowid DESC LIMIT 1").bind(tenant,policyId).all();
 if(!Array.isArray(history?.results))throw new Error("measurement_quality_policy_history_invalid");
 const current=history.results[0]?.event_type??"registered_unverified";
 const from={verify:"registered_unverified",reject:"registered_unverified",revoke:"verified"}[body.decision];
 if(current!==from)return {error:"measurement_quality_policy_state_conflict",status:409};
 const type={verify:"verified",reject:"rejected",revoke:"revoked"}[body.decision];
 const result=await db.prepare("INSERT INTO measurement_quality_policy_events(id,tenant_id,site_id,asset_id,policy_id,reviewer_subject,event_type,evidence_ref,reason,request_id) VALUES(?,?,?,?,?,?,?,?,?,?)")
 .bind(crypto.randomUUID(),tenant,siteId,assetId,policyId,reviewer,type,body.evidence_ref,body.reason??null,requestId).run();
 if(result?.meta?.changes!==1)return {error:"measurement_quality_policy_state_conflict",status:409};
 return {data:{policy_id:policyId,status:type,reviewer_subject:reviewer},status:201};
}

async function exactlyOne(db,sql,values,errorCode){
 const result=await db.prepare(sql).bind(...values).all();
 if(!Array.isArray(result?.results))throw new Error("measurement_quality_lookup_invalid");
 return result.results.length===1?result.results[0]:null;
}
async function assessmentResult(db,tenant,observation,requestId,status,reason,mapping=null,calibration=null,policy=null){
 const id=crypto.randomUUID();
 const result=await db.prepare("INSERT INTO measurement_quality_assessments(id,tenant_id,site_id,observation_id,mapping_id,calibration_id,policy_id,status,reason_code,observed_value,unit,method_version,request_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
 .bind(id,tenant,observation.site_id,observation.id,mapping?.id??null,calibration?.id??null,policy?.id??null,status,reason,Number.isFinite(observation.value)?observation.value:null,observation.unit??null,"1.0.0",requestId).run();
 if(result?.meta?.changes!==1)throw new Error("measurement_quality_assessment_write_failed");
 return {data:{id,observation_id:observation.id,status,reason_code:reason,mapping_id:mapping?.id??null,calibration_id:calibration?.id??null,policy_id:policy?.id??null,method_version:"1.0.0"},status:201};
}

export async function assessMeasurementQuality(db,tenant,observationId,requestId){
 if(!validId(observationId)||!validText(requestId,80))return {error:"measurement_quality_assessment_request_invalid",status:400};
 const prior=await db.prepare("SELECT id,observation_id,status,reason_code,mapping_id,calibration_id,policy_id,method_version FROM measurement_quality_assessments WHERE tenant_id=? AND request_id=? LIMIT 1").bind(tenant,requestId).all();
 if(!Array.isArray(prior?.results))throw new Error("measurement_quality_idempotency_lookup_invalid");
 if(prior.results.length===1)return {data:prior.results[0],status:200};
 const observation=await exactlyOne(db,"SELECT id,tenant_id,site_id,source_id,metric,value,unit,observed_at,verification_status,provenance_json FROM observations WHERE tenant_id=? AND id=? LIMIT 2",[tenant,observationId]);
 if(!observation)return {error:"observation_not_found",status:404};
 if(observation.verification_status!=="verified")return assessmentResult(db,tenant,observation,requestId,"not_assessed","observation_not_verified");
 if(!Number.isFinite(observation.value)||!validText(observation.source_id,160)||!validText(observation.metric,120)||!validText(observation.unit,48)||!validTime(observation.observed_at))
  return assessmentResult(db,tenant,observation,requestId,"not_assessed","observation_measurement_fields_invalid");
 let provenance={};
 try{provenance=JSON.parse(observation.provenance_json??"{}");}catch{return assessmentResult(db,tenant,observation,requestId,"not_assessed","observation_provenance_invalid");}
 if(["synthetic","demo","modelled","modeled"].includes(provenance.provenance_class))
  return assessmentResult(db,tenant,observation,requestId,"not_assessed","non_field_evidence");
 const mapRows=await db.prepare("SELECT m.id,m.asset_id,m.sensor_id,m.parameter,m.unit FROM sensor_source_identity_mappings m JOIN sensor_source_mapping_events e ON e.mapping_id=m.id AND e.tenant_id=m.tenant_id WHERE m.tenant_id=? AND m.site_id=? AND m.source_id=? AND m.parameter=? AND m.unit=? AND m.effective_from<=? AND (m.effective_to IS NULL OR m.effective_to>?) AND e.id=(SELECT e2.id FROM sensor_source_mapping_events e2 WHERE e2.tenant_id=m.tenant_id AND e2.mapping_id=m.id ORDER BY e2.occurred_at DESC,e2.rowid DESC LIMIT 1) AND e.event_type='verified' ORDER BY m.effective_from DESC LIMIT 2")
 .bind(tenant,observation.site_id,observation.source_id,observation.metric,observation.unit,observation.observed_at,observation.observed_at).all();
 if(!Array.isArray(mapRows?.results))throw new Error("measurement_quality_mapping_lookup_invalid");
 if(mapRows.results.length!==1)return assessmentResult(db,tenant,observation,requestId,"not_assessed",mapRows.results.length?"ambiguous_sensor_mapping":"verified_sensor_mapping_missing");
 const mapping=mapRows.results[0];
 const calRows=await db.prepare("SELECT c.id,c.calibrated_at,c.valid_until,c.uncertainty FROM sensor_calibrations c JOIN sensor_calibration_verification_events e ON e.calibration_id=c.id AND e.tenant_id=c.tenant_id WHERE c.tenant_id=? AND c.site_id=? AND c.asset_id=? AND c.sensor_id=? AND c.parameter=? AND c.unit=? AND c.calibrated_at<=? AND c.valid_until>=? AND e.id=(SELECT e2.id FROM sensor_calibration_verification_events e2 WHERE e2.tenant_id=c.tenant_id AND e2.calibration_id=c.id ORDER BY e2.occurred_at DESC,e2.rowid DESC LIMIT 1) AND e.event_type='verified' ORDER BY c.calibrated_at DESC LIMIT 2")
 .bind(tenant,observation.site_id,mapping.asset_id,mapping.sensor_id,observation.metric,observation.unit,observation.observed_at,observation.observed_at).all();
 if(!Array.isArray(calRows?.results))throw new Error("measurement_quality_calibration_lookup_invalid");
 if(calRows.results.length!==1)return assessmentResult(db,tenant,observation,requestId,"not_assessed",calRows.results.length?"ambiguous_verified_calibration":"verified_calibration_missing_or_expired",mapping);
 const calibration=calRows.results[0];
 const policyRows=await db.prepare("SELECT p.id,p.minimum_value,p.maximum_value,p.version FROM measurement_quality_policies p JOIN measurement_quality_policy_events e ON e.policy_id=p.id AND e.tenant_id=p.tenant_id WHERE p.tenant_id=? AND p.site_id=? AND p.asset_id=? AND p.sensor_id=? AND p.parameter=? AND p.unit=? AND p.effective_from<=? AND (p.effective_to IS NULL OR p.effective_to>?) AND e.id=(SELECT e2.id FROM measurement_quality_policy_events e2 WHERE e2.tenant_id=p.tenant_id AND e2.policy_id=p.id ORDER BY e2.occurred_at DESC,e2.rowid DESC LIMIT 1) AND e.event_type='verified' ORDER BY p.effective_from DESC LIMIT 2")
 .bind(tenant,observation.site_id,mapping.asset_id,mapping.sensor_id,observation.metric,observation.unit,observation.observed_at,observation.observed_at).all();
 if(!Array.isArray(policyRows?.results))throw new Error("measurement_quality_policy_lookup_invalid");
 if(policyRows.results.length!==1)return assessmentResult(db,tenant,observation,requestId,"not_assessed",policyRows.results.length?"ambiguous_quality_policy":"approved_quality_policy_missing",mapping,calibration);
 const policy=policyRows.results[0];
 const inRange=(policy.minimum_value===null||observation.value>=policy.minimum_value)&&
  (policy.maximum_value===null||observation.value<=policy.maximum_value);
 return assessmentResult(db,tenant,observation,requestId,inRange?"passed":"failed",inRange?"within_approved_policy_bounds":"outside_approved_policy_bounds",mapping,calibration,policy);
}

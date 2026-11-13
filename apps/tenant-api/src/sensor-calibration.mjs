const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const ISO = /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$/;
function text(v,max){return typeof v==="string"&&v.length>0&&v.length<=max&&v.trim()===v&&!/[\\u0000-\\u001f\\u007f]/.test(v);}
function id(v,max=160){return text(v,max)&&ID.test(v);}
function timestamp(v){if(!text(v,40)||!ISO.test(v)||!Number.isFinite(Date.parse(v)))return false;const m=/^(\\d{4})-(\\d{2})-(\\d{2})T/.exec(v);if(!m)return false;const d=new Date(Date.UTC(+m[1],+m[2]-1,+m[3]));return d.getUTCFullYear()===+m[1]&&d.getUTCMonth()===+m[2]-1&&d.getUTCDate()===+m[3];}
function onlyKeys(v,keys){return v!==null&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k));}
export async function registerSensorCalibration(db,tenantId,siteId,assetId,subject,requestId,body){
 const allowed=["sensor_id","parameter","unit","calibration_method","calibrated_at","valid_until","laboratory_name","certificate_evidence_id","reference_value","as_found_value","as_left_value","uncertainty","notes"];
 if(!onlyKeys(body,allowed)||!id(siteId)||!id(assetId)||!id(body.sensor_id)||!text(body.parameter,120)||!text(body.unit,40)||!text(body.calibration_method,160)||!timestamp(body.calibrated_at)||!timestamp(body.valid_until)||Date.parse(body.valid_until)<=Date.parse(body.calibrated_at)||(body.laboratory_name!==undefined&&!text(body.laboratory_name,200))||(body.certificate_evidence_id!==undefined&&!id(body.certificate_evidence_id))||(body.notes!==undefined&&!text(body.notes,2000))){
  return {error:"sensor_calibration_request_invalid",status:400};
 }
 for(const key of ["reference_value","as_found_value","as_left_value","uncertainty"]){
  if(body[key]!==undefined&&(!Number.isFinite(body[key])||(key==="uncertainty"&&body[key]<0)))return {error:"sensor_calibration_numeric_value_invalid",status:400};
 }
 if(body.uncertainty!==undefined&&body.reference_value===undefined)return {error:"sensor_calibration_uncertainty_requires_reference",status:400};
 const assets=await db.prepare("SELECT id, site_id FROM assets WHERE tenant_id = ? AND site_id = ? AND id = ? LIMIT 2").bind(tenantId,siteId,assetId).all();
 if(!Array.isArray(assets?.results)||assets.results.length!==1||assets.results[0].id!==assetId||assets.results[0].site_id!==siteId)return {error:"asset_not_found",status:404};
 if(body.certificate_evidence_id){
  const evidence=await db.prepare("SELECT id FROM laboratory_report_evidence WHERE tenant_id = ? AND site_id = ? AND id = ? LIMIT 2").bind(tenantId,siteId,body.certificate_evidence_id).all();
  if(!Array.isArray(evidence?.results)||evidence.results.length!==1)return {error:"calibration_evidence_not_found",status:404};
 }
 const calibrationId=crypto.randomUUID(),eventId=crypto.randomUUID();
 const insert=db.prepare("INSERT INTO sensor_calibrations (id,tenant_id,site_id,asset_id,sensor_id,parameter,unit,calibration_method,calibrated_at,valid_until,laboratory_name,certificate_evidence_id,reference_value,as_found_value,as_left_value,uncertainty,notes,registered_by_subject) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
  .bind(calibrationId,tenantId,siteId,assetId,body.sensor_id,body.parameter,body.unit,body.calibration_method,body.calibrated_at,body.valid_until,body.laboratory_name??null,body.certificate_evidence_id??null,body.reference_value??null,body.as_found_value??null,body.as_left_value??null,body.uncertainty??null,body.notes??null,subject);
 const event=db.prepare("INSERT INTO sensor_calibration_events (id,calibration_id,tenant_id,site_id,event_type,actor_subject,request_id) SELECT ?,?,?,?,'registered',?,? WHERE changes()=1").bind(eventId,calibrationId,tenantId,siteId,subject,requestId);
 const results=await db.batch([insert,event]);
 if(!Array.isArray(results)||results.length!==2||results.some(x=>!x?.meta||!Number.isInteger(x.meta.changes)))throw new Error("sensor_calibration_batch_invalid");
 if(results[0].meta.changes!==1||results[1].meta.changes!==1)throw new Error("sensor_calibration_batch_incomplete");
 return {data:{id:calibrationId,tenant_id:tenantId,site_id:siteId,asset_id:assetId,sensor_id:body.sensor_id,parameter:body.parameter,unit:body.unit,calibrated_at:body.calibrated_at,valid_until:body.valid_until,certificate_evidence_id:body.certificate_evidence_id??null,verification_status:"registered_unverified",measurement_quality_status:"not_assessed"},status:201};
}
export async function readSensorCalibrations(db,tenantId,siteId,assetId){
 const result=await db.prepare("SELECT id,tenant_id,site_id,asset_id,sensor_id,parameter,unit,calibration_method,calibrated_at,valid_until,laboratory_name,certificate_evidence_id,reference_value,as_found_value,as_left_value,uncertainty,notes,verification_status,registered_by_subject,created_at FROM sensor_calibrations WHERE tenant_id=? AND site_id=? AND asset_id=? ORDER BY calibrated_at DESC,id").bind(tenantId,siteId,assetId).all();
 if(!Array.isArray(result?.results))throw new Error("sensor_calibration_read_invalid");
 return result.results;
}

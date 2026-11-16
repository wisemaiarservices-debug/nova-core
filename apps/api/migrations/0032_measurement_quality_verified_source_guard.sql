-- Require the source registry row to remain verified when a quality result is persisted.
-- This additive migration applies the V1 source lifecycle gate without rewriting 0015.
DROP TRIGGER IF EXISTS measurement_quality_assessment_evidence_guard;

CREATE TRIGGER measurement_quality_assessment_evidence_guard
BEFORE INSERT ON measurement_quality_assessments
WHEN NEW.status IN ('passed','failed')
AND NOT EXISTS (
 SELECT 1 FROM observations o
 JOIN sources src
   ON src.id=o.source_id AND src.tenant_id=o.tenant_id AND src.site_id=o.site_id
  AND src.verification_status='verified'
 JOIN sensor_source_identity_mappings m
   ON m.id=NEW.mapping_id AND m.tenant_id=o.tenant_id AND m.site_id=o.site_id
  AND m.source_id=o.source_id AND m.asset_id=o.asset_id AND m.parameter=o.metric AND m.unit=o.unit
  AND m.effective_from<=o.observed_at AND (m.effective_to IS NULL OR m.effective_to>o.observed_at)
 JOIN sensor_source_mapping_events me
   ON me.mapping_id=m.id AND me.tenant_id=m.tenant_id AND me.site_id=m.site_id AND me.asset_id=m.asset_id AND me.source_id=m.source_id AND me.event_type='verified'
  AND me.id=(SELECT e.id FROM sensor_source_mapping_events e
    WHERE e.tenant_id=m.tenant_id AND e.mapping_id=m.id ORDER BY e.occurred_at DESC,e.rowid DESC LIMIT 1)
 JOIN sensor_calibrations c
   ON c.id=NEW.calibration_id AND c.tenant_id=o.tenant_id AND c.site_id=o.site_id
  AND c.asset_id=m.asset_id AND c.sensor_id=m.sensor_id AND c.parameter=o.metric AND c.unit=o.unit
  AND c.calibrated_at<=o.observed_at AND c.valid_until>=o.observed_at
 JOIN sensor_calibration_verification_events ce
   ON ce.calibration_id=c.id AND ce.tenant_id=c.tenant_id AND ce.site_id=c.site_id AND ce.asset_id=c.asset_id AND ce.event_type='verified'
  AND ce.id=(SELECT e.id FROM sensor_calibration_verification_events e
    WHERE e.tenant_id=c.tenant_id AND e.calibration_id=c.id ORDER BY e.occurred_at DESC,e.rowid DESC LIMIT 1)
 JOIN measurement_quality_policies p
   ON p.id=NEW.policy_id AND p.tenant_id=o.tenant_id AND p.site_id=o.site_id
  AND p.asset_id=m.asset_id AND p.sensor_id=m.sensor_id AND p.parameter=o.metric AND p.unit=o.unit
  AND p.effective_from<=o.observed_at AND (p.effective_to IS NULL OR p.effective_to>o.observed_at)
 JOIN measurement_quality_policy_events pe
   ON pe.policy_id=p.id AND pe.tenant_id=p.tenant_id AND pe.site_id=p.site_id AND pe.asset_id=p.asset_id AND pe.event_type='verified'
  AND pe.id=(SELECT e.id FROM measurement_quality_policy_events e
    WHERE e.tenant_id=p.tenant_id AND e.policy_id=p.id ORDER BY e.occurred_at DESC,e.rowid DESC LIMIT 1)
 WHERE o.id=NEW.observation_id AND o.tenant_id=NEW.tenant_id AND o.site_id=NEW.site_id
   AND o.verification_status='verified' AND o.value=NEW.observed_value AND o.unit=NEW.unit
   AND ((NEW.status='passed' AND (p.minimum_value IS NULL OR o.value>=p.minimum_value)
      AND (p.maximum_value IS NULL OR o.value<=p.maximum_value))
     OR (NEW.status='failed' AND ((p.minimum_value IS NOT NULL AND o.value<p.minimum_value)
      OR (p.maximum_value IS NOT NULL AND o.value>p.maximum_value))))
)
BEGIN SELECT RAISE(ABORT,'quality result requires verified exact-scope mapping, calibration and policy'); END;

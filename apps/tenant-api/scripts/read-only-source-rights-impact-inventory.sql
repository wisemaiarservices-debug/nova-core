-- READ-ONLY source data-rights impact inventory.
-- Execute only against a disposable local D1 copy or an explicitly authorized
-- read-only snapshot. Never run against production from this script.
-- No document bytes, tenant names, source names, raw telemetry or secrets are selected.
-- Read-only enforcement: this file contains SELECT statements only; CI invokes it with Wrangler --local against disposable D1. Do not add writes or run with --remote.

-- 1. Capability counts by status and reference resolution class.
WITH capability_refs AS (
  SELECT
    c.id,
    c.status,
    c.tenant_id,
    c.site_id,
    c.source_id,
    c.asset_id,
    c.data_rights_ref,
    CASE
      WHEN c.data_rights_ref IS NULL OR trim(c.data_rights_ref) = '' THEN 'missing'
      WHEN d.id IS NULL THEN
        CASE WHEN c.data_rights_ref GLOB 'source-rights:*'
          THEN 'registry_id_unresolved' ELSE 'legacy_or_malformed_reference' END
      WHEN d.tenant_id <> c.tenant_id OR d.site_id <> c.site_id OR d.source_id <> c.source_id
        THEN 'scope_mismatch'
      ELSE 'registry_id_resolved'
    END AS rights_ref_class
  FROM source_capabilities c
  LEFT JOIN source_data_rights_declarations d ON d.id = c.data_rights_ref
)
SELECT status, rights_ref_class, COUNT(*) AS capability_count
FROM capability_refs
GROUP BY status, rights_ref_class
ORDER BY status, rights_ref_class;

-- 2. Rights/evidence state and permitted-purpose coverage for resolved references.
WITH capability_refs AS (
  SELECT c.id, c.status, c.tenant_id, c.site_id, c.source_id, c.data_rights_ref,
         d.id AS declaration_id, d.tenant_id AS rights_tenant_id,
         d.site_id AS rights_site_id, d.source_id AS rights_source_id,
         d.supporting_evidence_id, d.supporting_evidence_sha256,
         d.permitted_purposes_json, d.effective_from, d.effective_to,
         doc.tenant_id AS evidence_tenant_id, doc.site_id AS evidence_site_id,
         doc.source_id AS evidence_source_id, doc.effective_from AS evidence_effective_from,
         doc.effective_to AS evidence_effective_to
  FROM source_capabilities c
  LEFT JOIN source_data_rights_declarations d ON d.id = c.data_rights_ref
  LEFT JOIN source_evidence_documents doc ON doc.id=d.supporting_evidence_id
),
states AS (
  SELECT cr.*,
    (SELECT e.event_type FROM source_data_rights_events e
      WHERE e.declaration_id = cr.declaration_id ORDER BY e.rowid DESC LIMIT 1) AS latest_rights_event,
    (SELECT e.event_type FROM source_evidence_events e
      WHERE e.evidence_id = cr.supporting_evidence_id ORDER BY e.rowid DESC LIMIT 1) AS latest_evidence_event
  FROM capability_refs cr
)
SELECT
  status,
  CASE
    WHEN declaration_id IS NULL THEN 'unresolved'
    WHEN rights_tenant_id <> tenant_id OR rights_site_id <> site_id OR rights_source_id <> source_id
      THEN 'rights_scope_mismatch'
    WHEN evidence_tenant_id <> tenant_id OR evidence_site_id <> site_id OR evidence_source_id <> source_id
      THEN 'evidence_scope_mismatch'
    WHEN latest_rights_event IS NULL THEN 'no_rights_event'
    WHEN latest_rights_event <> 'approved' THEN 'rights_not_approved'
    WHEN latest_evidence_event IS NULL OR latest_evidence_event <> 'verified' THEN 'evidence_not_verified'
    WHEN (evidence_effective_from IS NOT NULL AND evidence_effective_from > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      OR (evidence_effective_to IS NOT NULL AND evidence_effective_to <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      THEN 'supporting_evidence_outside_effective_window'
    ELSE 'approved_and_evidence_verified'
  END AS governance_state,
  CASE WHEN declaration_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM json_each(states.permitted_purposes_json) p
    WHERE p.value = 'measurement_ingestion'
  ) THEN 1 ELSE 0 END AS has_measurement_ingestion_purpose,
  CASE WHEN declaration_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM json_each(states.permitted_purposes_json) p
    WHERE p.value = 'storage'
  ) THEN 1 ELSE 0 END AS has_storage_purpose,
  CASE WHEN declaration_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM json_each(states.permitted_purposes_json) p
    WHERE p.value = 'analytics'
  ) THEN 1 ELSE 0 END AS has_analytics_purpose,
  CASE WHEN declaration_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM json_each(states.permitted_purposes_json) p
    WHERE p.value = 'model_training'
  ) THEN 1 ELSE 0 END AS has_model_training_purpose,
  CASE WHEN declaration_id IS NOT NULL AND (
    effective_from > strftime('%Y-%m-%dT%H:%M:%fZ','now')
    OR (effective_to IS NOT NULL AND effective_to <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  ) THEN 1 ELSE 0 END AS outside_current_effective_window,
  COUNT(*) AS capability_count
FROM states
GROUP BY status, governance_state, has_measurement_ingestion_purpose,
         has_storage_purpose, has_analytics_purpose, has_model_training_purpose,
         outside_current_effective_window
ORDER BY status, governance_state;

-- 3. Capability evidence_ref classification, independently of data_rights_ref.
SELECT
  c.status,
  CASE
    WHEN c.evidence_ref IS NULL OR trim(c.evidence_ref) = '' THEN 'missing'
    WHEN e.id IS NOT NULL AND e.tenant_id=c.tenant_id AND e.site_id=c.site_id
      AND e.source_id=c.source_id THEN 'matching_evidence_registry_id'
    WHEN e.id IS NOT NULL THEN 'evidence_scope_mismatch'
    WHEN c.evidence_ref GLOB 'source-evidence:*' THEN 'evidence_registry_id_unresolved'
    ELSE 'legacy_or_malformed_reference'
  END AS evidence_ref_class,
  COUNT(*) AS capability_count
FROM source_capabilities c
LEFT JOIN source_evidence_documents e ON e.id=c.evidence_ref
GROUP BY c.status, evidence_ref_class
ORDER BY c.status, evidence_ref_class;

-- 4. Observation counts by capability status and time band. No observation values
-- or identifiers are emitted. NULL capability IDs are counted explicitly.
SELECT
  CASE WHEN o.source_capability_id IS NULL THEN 'missing_capability_id'
       WHEN c.id IS NULL THEN 'unresolved_capability_id'
       ELSE c.status END AS capability_status,
  CASE
    WHEN julianday(o.observed_at) IS NULL THEN 'invalid_timestamp'
    WHEN julianday(o.observed_at) < julianday('now','-365 days') THEN 'older_than_365_days'
    WHEN julianday(o.observed_at) < julianday('now','-90 days') THEN '90_to_365_days'
    ELSE 'within_90_days'
  END AS observation_time_band,
  COUNT(*) AS observation_count
FROM observations o
LEFT JOIN source_capabilities c ON c.id=o.source_capability_id
GROUP BY capability_status, observation_time_band
ORDER BY capability_status, observation_time_band;

-- 5. Approved capabilities with no currently approved rights/evidence chain,
-- insufficient explicit ingestion/storage purpose, or expired effective window.
WITH approved AS (
  SELECT c.id, c.tenant_id, c.site_id, c.source_id, c.data_rights_ref,
         d.id AS declaration_id, d.tenant_id AS rights_tenant_id,
         d.site_id AS rights_site_id, d.source_id AS rights_source_id,
         d.supporting_evidence_id, d.permitted_purposes_json,
         d.effective_from, d.effective_to,
         doc.tenant_id AS evidence_tenant_id, doc.site_id AS evidence_site_id,
         doc.source_id AS evidence_source_id, doc.effective_from AS evidence_effective_from,
         doc.effective_to AS evidence_effective_to
  FROM source_capabilities c
  LEFT JOIN source_data_rights_declarations d ON d.id=c.data_rights_ref
  LEFT JOIN source_evidence_documents doc ON doc.id=d.supporting_evidence_id
  WHERE c.status='approved'
),
evaluated AS (
  SELECT a.*,
    (SELECT e.event_type FROM source_data_rights_events e
      WHERE e.declaration_id=a.declaration_id ORDER BY e.rowid DESC LIMIT 1) AS rights_state,
    (SELECT e.event_type FROM source_evidence_events e
      WHERE e.evidence_id=a.supporting_evidence_id ORDER BY e.rowid DESC LIMIT 1) AS evidence_state
  FROM approved a
)
SELECT
  CASE
    WHEN declaration_id IS NULL THEN 'no_resolvable_rights_declaration'
    WHEN rights_tenant_id <> tenant_id OR rights_site_id <> site_id OR rights_source_id <> source_id
      THEN 'rights_scope_mismatch'
    WHEN evidence_tenant_id <> tenant_id OR evidence_site_id <> site_id OR evidence_source_id <> source_id
      THEN 'evidence_scope_mismatch'
    WHEN rights_state <> 'approved' OR rights_state IS NULL THEN 'rights_not_currently_approved'
    WHEN evidence_state <> 'verified' OR evidence_state IS NULL THEN 'supporting_evidence_not_verified'
    WHEN (evidence_effective_from IS NOT NULL AND evidence_effective_from > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      OR (evidence_effective_to IS NOT NULL AND evidence_effective_to <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      THEN 'supporting_evidence_outside_effective_window'
    WHEN NOT EXISTS (SELECT 1 FROM json_each(permitted_purposes_json) p WHERE p.value='measurement_ingestion')
      THEN 'missing_measurement_ingestion_purpose'
    WHEN NOT EXISTS (SELECT 1 FROM json_each(permitted_purposes_json) p WHERE p.value='storage')
      THEN 'missing_storage_purpose'
    WHEN effective_from > strftime('%Y-%m-%dT%H:%M:%fZ','now')
      OR (effective_to IS NOT NULL AND effective_to <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      THEN 'outside_current_effective_window'
    ELSE 'currently_satisfies_inventory_checks'
  END AS finding_class,
  COUNT(*) AS approved_capability_count
FROM evaluated
GROUP BY finding_class
ORDER BY finding_class;

-- This inventory intentionally does not decide whether historical observations
-- are retroactively authorized. It emits counts only; policy must decide that.

-- 6. Migration-0064 approval predicates: evidence is source-scoped (the
-- evidence-document schema has no asset_id); asset scope is enforced by the
-- rights declaration and capability. Counts only; no identifiers are emitted.
WITH candidates AS (
  SELECT c.id, c.tenant_id, c.site_id, c.source_id, c.asset_id,
         c.data_rights_ref, c.evidence_ref,
         rd.id AS rights_id, rd.tenant_id AS rights_tenant_id,
         rd.site_id AS rights_site_id, rd.source_id AS rights_source_id,
         rd.asset_id AS rights_asset_id,
         rd.supporting_evidence_id, rd.supporting_evidence_sha256,
         rd.permitted_purposes_json, rd.effective_from AS rights_effective_from,
         rd.effective_to AS rights_effective_to,
         doc.id AS evidence_id, doc.tenant_id AS evidence_tenant_id,
         doc.site_id AS evidence_site_id, doc.source_id AS evidence_source_id,
         doc.sha256 AS evidence_sha256,
         doc.effective_from AS evidence_effective_from,
         doc.effective_to AS evidence_effective_to,
         (SELECT e.event_type FROM source_data_rights_events e
           WHERE e.declaration_id=rd.id ORDER BY e.rowid DESC LIMIT 1) AS latest_rights_event,
         (SELECT e.event_type FROM source_evidence_events e
           WHERE e.evidence_id=doc.id ORDER BY e.rowid DESC LIMIT 1) AS latest_evidence_event
  FROM source_capabilities c
  LEFT JOIN source_data_rights_declarations rd ON rd.id=c.data_rights_ref
  LEFT JOIN source_evidence_documents doc ON doc.id=rd.supporting_evidence_id
  WHERE c.status='approved'
),
classified AS (
  SELECT *,
    CASE
      WHEN rights_id IS NULL THEN 'unresolved_rights_reference'
      WHEN rights_tenant_id<>tenant_id OR rights_site_id<>site_id
        OR rights_source_id<>source_id OR rights_asset_id IS NOT asset_id
        THEN 'rights_scope_mismatch'
      WHEN evidence_id IS NULL THEN 'unresolved_supporting_evidence'
      WHEN evidence_tenant_id<>tenant_id OR evidence_site_id<>site_id
        OR evidence_source_id<>source_id
        THEN 'evidence_scope_mismatch'
      WHEN evidence_sha256<>supporting_evidence_sha256 THEN 'evidence_digest_mismatch'
      WHEN evidence_ref IS NOT evidence_id THEN 'capability_evidence_ref_mismatch'
      WHEN latest_rights_event IS NOT 'approved' THEN 'rights_not_currently_approved'
      WHEN latest_evidence_event IS NOT 'verified' THEN 'evidence_not_currently_verified'
      WHEN rights_effective_from>strftime('%Y-%m-%dT%H:%M:%fZ','now')
        OR (rights_effective_to IS NOT NULL AND rights_effective_to<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        THEN 'rights_outside_effective_window'
      WHEN evidence_effective_from IS NOT NULL
        AND evidence_effective_from>strftime('%Y-%m-%dT%H:%M:%fZ','now')
        OR evidence_effective_to IS NOT NULL
        AND evidence_effective_to<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        THEN 'evidence_outside_effective_window'
      WHEN NOT EXISTS (SELECT 1 FROM json_each(permitted_purposes_json) p
        WHERE p.type='text' AND p.value='measurement_ingestion')
        THEN 'missing_measurement_ingestion_purpose'
      WHEN NOT EXISTS (SELECT 1 FROM json_each(permitted_purposes_json) p
        WHERE p.type='text' AND p.value='storage')
        THEN 'missing_storage_purpose'
      ELSE 'satisfies_0064_approval_predicates'
    END AS migration_0064_approval_class
  FROM candidates
)
SELECT migration_0064_approval_class, COUNT(*) AS approved_capability_count
FROM classified
GROUP BY migration_0064_approval_class
ORDER BY migration_0064_approval_class;

-- 7. Observation counts by current migration-0064 rights-chain state and age.
-- Age bands are descriptive only: they do not decide retroactive authorization.
WITH evaluated AS (
  SELECT o.id, o.observed_at,
    CASE
      WHEN o.source_capability_id IS NULL THEN 'missing_capability_id'
      WHEN c.id IS NULL THEN 'unresolved_capability'
      WHEN c.tenant_id<>o.tenant_id OR c.site_id<>o.site_id
        OR c.source_id<>o.source_id OR c.asset_id IS NOT o.asset_id
        THEN 'capability_scope_mismatch'
      WHEN rd.id IS NULL THEN 'unresolved_rights_reference'
      WHEN rd.tenant_id<>c.tenant_id OR rd.site_id<>c.site_id
        OR rd.source_id<>c.source_id OR rd.asset_id IS NOT c.asset_id
        THEN 'rights_scope_mismatch'
      WHEN doc.id IS NULL THEN 'unresolved_supporting_evidence'
      WHEN doc.tenant_id<>c.tenant_id OR doc.site_id<>c.site_id
        OR doc.source_id<>c.source_id OR doc.sha256<>rd.supporting_evidence_sha256
        THEN 'evidence_scope_or_digest_mismatch'
      WHEN c.evidence_ref IS NOT doc.id THEN 'capability_evidence_ref_mismatch'
      WHEN (SELECT e.event_type FROM source_data_rights_events e
        WHERE e.declaration_id=rd.id ORDER BY e.rowid DESC LIMIT 1) IS NOT 'approved'
        THEN 'rights_not_currently_approved'
      WHEN (SELECT e.event_type FROM source_evidence_events e
        WHERE e.evidence_id=doc.id ORDER BY e.rowid DESC LIMIT 1) IS NOT 'verified'
        THEN 'evidence_not_currently_verified'
      WHEN rd.effective_from>strftime('%Y-%m-%dT%H:%M:%fZ','now')
        OR (rd.effective_to IS NOT NULL AND rd.effective_to<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        THEN 'rights_outside_effective_window'
      WHEN (doc.effective_from IS NOT NULL AND doc.effective_from>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        OR (doc.effective_to IS NOT NULL AND doc.effective_to<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        THEN 'evidence_outside_effective_window'
      WHEN NOT EXISTS (SELECT 1 FROM json_each(rd.permitted_purposes_json) p
        WHERE p.type='text' AND p.value='measurement_ingestion')
        THEN 'missing_measurement_ingestion_purpose'
      WHEN NOT EXISTS (SELECT 1 FROM json_each(rd.permitted_purposes_json) p
        WHERE p.type='text' AND p.value='storage')
        THEN 'missing_storage_purpose'
      ELSE 'currently_satisfies_0064_rights_predicates'
    END AS current_rights_chain_class,
    CASE
      WHEN julianday(o.observed_at) IS NULL THEN 'invalid_timestamp'
      WHEN julianday(o.observed_at)<julianday('now','-365 days') THEN 'older_than_365_days'
      WHEN julianday(o.observed_at)<julianday('now','-90 days') THEN '90_to_365_days'
      ELSE 'within_90_days'
    END AS observation_age_band
  FROM observations o
  LEFT JOIN source_capabilities c ON c.id=o.source_capability_id
  LEFT JOIN source_data_rights_declarations rd ON rd.id=c.data_rights_ref
  LEFT JOIN source_evidence_documents doc ON doc.id=rd.supporting_evidence_id
)
SELECT current_rights_chain_class, observation_age_band,
       COUNT(*) AS observation_count
FROM evaluated
GROUP BY current_rights_chain_class, observation_age_band
ORDER BY current_rights_chain_class, observation_age_band;

-- Sections 6–7 mirror migration 0064's approval/insert predicates for aggregate impact analysis.
-- Evidence documents are tenant/site/source scoped; do not infer an evidence asset_id.
-- Keep these classifications aligned with the trigger whenever migration 0064 changes.
-- They estimate present-day predicate compatibility only. They do not
-- establish the legal authorization status at observation time or decide
-- retroactivity. Do not use the results to rewrite or delete historical rows.

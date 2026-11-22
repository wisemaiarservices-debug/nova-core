-- Enforce current, exact-scope data rights at capability approval and observation commit.
-- Historical rows are not rewritten; every new approval and observation rechecks live state.

CREATE TRIGGER source_capability_rights_approval_guard
BEFORE INSERT ON source_capability_events
WHEN NEW.event_type='approved' AND NOT EXISTS (
  SELECT 1
  FROM source_capabilities c
  JOIN source_data_rights_declarations rd
    ON rd.id=c.data_rights_ref
   AND rd.tenant_id=c.tenant_id
   AND rd.site_id=c.site_id
   AND rd.source_id=c.source_id
   AND rd.asset_id IS c.asset_id
  JOIN source_evidence_documents doc
    ON doc.id=rd.supporting_evidence_id
   AND doc.tenant_id=rd.tenant_id
   AND doc.site_id=rd.site_id
   AND doc.source_id=rd.source_id
   AND doc.sha256=rd.supporting_evidence_sha256
  WHERE c.id=NEW.capability_id
    AND c.tenant_id=NEW.tenant_id
    AND c.site_id=NEW.site_id
    AND c.source_id=NEW.source_id
    AND c.evidence_ref=doc.id
    AND rd.id=c.data_rights_ref
    AND rd.effective_from<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND (rd.effective_to IS NULL OR rd.effective_to>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    AND (doc.effective_from IS NULL OR doc.effective_from<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    AND (doc.effective_to IS NULL OR doc.effective_to>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    AND EXISTS (
      SELECT 1 FROM source_data_rights_events re
      WHERE re.declaration_id=rd.id AND re.event_type='approved'
        AND re.id=(SELECT latest.id FROM source_data_rights_events latest
          WHERE latest.declaration_id=rd.id ORDER BY latest.rowid DESC LIMIT 1)
    )
    AND EXISTS (
      SELECT 1 FROM source_evidence_events ee
      WHERE ee.evidence_id=doc.id AND ee.event_type='verified'
        AND ee.id=(SELECT latest.id FROM source_evidence_events latest
          WHERE latest.evidence_id=doc.id ORDER BY latest.rowid DESC LIMIT 1)
    )
    AND EXISTS (SELECT 1 FROM json_each(rd.permitted_purposes_json) p
      WHERE p.type='text' AND p.value='measurement_ingestion')
    AND EXISTS (SELECT 1 FROM json_each(rd.permitted_purposes_json) p
      WHERE p.type='text' AND p.value='storage')
)
BEGIN
  SELECT RAISE(ABORT, 'capability approval requires current exact-scope approved ingestion and storage rights');
END;

CREATE TRIGGER observations_source_rights_insert_guard
BEFORE INSERT ON observations
WHEN NOT EXISTS (
  SELECT 1
  FROM source_capabilities c
  JOIN source_data_rights_declarations rd
    ON rd.id=c.data_rights_ref
   AND rd.tenant_id=c.tenant_id
   AND rd.site_id=c.site_id
   AND rd.source_id=c.source_id
   AND rd.asset_id IS c.asset_id
  JOIN source_evidence_documents doc
    ON doc.id=rd.supporting_evidence_id
   AND doc.tenant_id=rd.tenant_id
   AND doc.site_id=rd.site_id
   AND doc.source_id=rd.source_id
   AND doc.sha256=rd.supporting_evidence_sha256
  WHERE c.id=NEW.source_capability_id
    AND c.tenant_id=NEW.tenant_id
    AND c.site_id=NEW.site_id
    AND c.source_id=NEW.source_id
    AND c.asset_id IS NEW.asset_id
    AND c.evidence_ref=doc.id
    AND rd.effective_from<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND (rd.effective_to IS NULL OR rd.effective_to>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    AND (doc.effective_from IS NULL OR doc.effective_from<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    AND (doc.effective_to IS NULL OR doc.effective_to>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    AND EXISTS (
      SELECT 1 FROM source_data_rights_events re
      WHERE re.declaration_id=rd.id AND re.event_type='approved'
        AND re.id=(SELECT latest.id FROM source_data_rights_events latest
          WHERE latest.declaration_id=rd.id ORDER BY latest.rowid DESC LIMIT 1)
    )
    AND EXISTS (
      SELECT 1 FROM source_evidence_events ee
      WHERE ee.evidence_id=doc.id AND ee.event_type='verified'
        AND ee.id=(SELECT latest.id FROM source_evidence_events latest
          WHERE latest.evidence_id=doc.id ORDER BY latest.rowid DESC LIMIT 1)
    )
    AND EXISTS (SELECT 1 FROM json_each(rd.permitted_purposes_json) p
      WHERE p.type='text' AND p.value='measurement_ingestion')
    AND EXISTS (SELECT 1 FROM json_each(rd.permitted_purposes_json) p
      WHERE p.type='text' AND p.value='storage')
)
BEGIN
  SELECT RAISE(ABORT, 'observation requires current exact-scope approved ingestion and storage rights');
END;

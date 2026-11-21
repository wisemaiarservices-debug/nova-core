-- Allow an approved rights declaration to be explicitly revoked after its
-- supporting evidence is revoked. New declarations/approvals/rejections still
-- require the supporting evidence's latest event to be verified.
DROP TRIGGER IF EXISTS source_data_rights_event_insert_guard;

CREATE TRIGGER source_data_rights_event_insert_guard
BEFORE INSERT ON source_data_rights_events
WHEN NOT EXISTS (
  SELECT 1 FROM source_data_rights_declarations d
  JOIN source_evidence_documents doc ON doc.id=d.supporting_evidence_id
    AND doc.tenant_id=d.tenant_id AND doc.site_id=d.site_id
    AND doc.source_id=d.source_id AND doc.sha256=d.supporting_evidence_sha256
  JOIN sources src ON src.id=d.source_id AND src.tenant_id=d.tenant_id
    AND src.site_id=d.site_id
  JOIN tenants t ON t.id=NEW.tenant_id AND t.status='active'
  JOIN sites s ON s.id=NEW.site_id AND s.tenant_id=NEW.tenant_id AND s.status='active'
  JOIN audit_events a ON a.tenant_id=NEW.tenant_id
    AND a.actor_type='operator' AND a.actor_id=NEW.actor_subject
    AND a.action='source_data_rights.' || NEW.event_type
    AND a.entity_type='source_data_rights_declaration' AND a.entity_id=NEW.declaration_id
    AND a.request_id=NEW.request_id
  WHERE d.id=NEW.declaration_id AND d.tenant_id=NEW.tenant_id
    AND d.site_id=NEW.site_id AND d.source_id=NEW.source_id
    AND d.declaration_sha256=NEW.reviewed_declaration_sha256
    AND doc.sha256=NEW.reviewed_evidence_sha256
    AND (
      (NEW.event_type IN ('declared','approved','rejected') AND EXISTS (
        SELECT 1 FROM source_evidence_events ee
        WHERE ee.evidence_id=doc.id AND ee.event_type='verified'
          AND ee.id=(SELECT ee2.id FROM source_evidence_events ee2
            WHERE ee2.evidence_id=doc.id ORDER BY ee2.rowid DESC LIMIT 1)
      ))
      OR
      (NEW.event_type='revoked' AND EXISTS (
        SELECT 1 FROM source_evidence_events ee
        WHERE ee.evidence_id=doc.id AND ee.event_type IN ('verified','revoked')
          AND ee.id=(SELECT ee2.id FROM source_evidence_events ee2
            WHERE ee2.evidence_id=doc.id ORDER BY ee2.rowid DESC LIMIT 1)
      ))
    )
    AND (
      (NEW.event_type='declared' AND NEW.actor_subject=d.declared_by_subject
        AND NOT EXISTS (SELECT 1 FROM source_data_rights_events e
          WHERE e.declaration_id=d.id))
      OR
      (NEW.event_type IN ('approved','rejected')
        AND NEW.actor_subject<>d.declared_by_subject
        AND NEW.actor_subject<>doc.uploaded_by_subject
        AND NEW.actor_subject<>COALESCE(src.registered_by_subject,'')
        AND EXISTS (SELECT 1 FROM tenant_source_reviewers r
          JOIN tenant_memberships m ON m.tenant_id=r.tenant_id
            AND m.subject=r.reviewer_subject AND m.status='active'
          WHERE r.tenant_id=NEW.tenant_id AND r.site_id=NEW.site_id
            AND r.reviewer_subject=NEW.actor_subject AND r.status='active')
        AND EXISTS (SELECT 1 FROM source_data_rights_events e
          WHERE e.declaration_id=d.id AND e.event_type='declared'
            AND e.id=(SELECT e2.id FROM source_data_rights_events e2
              WHERE e2.declaration_id=d.id ORDER BY e2.rowid DESC LIMIT 1))
        AND (NEW.event_type<>'approved' OR (
          d.effective_from<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          AND (d.effective_to IS NULL OR d.effective_to>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        ))
      )
      OR
      (NEW.event_type='revoked'
        AND NEW.actor_subject<>d.declared_by_subject
        AND NEW.actor_subject<>doc.uploaded_by_subject
        AND NEW.actor_subject<>COALESCE(src.registered_by_subject,'')
        AND EXISTS (SELECT 1 FROM tenant_source_reviewers r
          JOIN tenant_memberships m ON m.tenant_id=r.tenant_id
            AND m.subject=r.reviewer_subject AND m.status='active'
          WHERE r.tenant_id=NEW.tenant_id AND r.site_id=NEW.site_id
            AND r.reviewer_subject=NEW.actor_subject AND r.status='active')
        AND EXISTS (SELECT 1 FROM source_data_rights_events e
          WHERE e.declaration_id=d.id AND e.event_type='approved'
            AND e.id=(SELECT e2.id FROM source_data_rights_events e2
              WHERE e2.declaration_id=d.id ORDER BY e2.rowid DESC LIMIT 1))
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'data rights event requires exact declaration and evidence digests, valid lifecycle and independent reviewer authority');
END;

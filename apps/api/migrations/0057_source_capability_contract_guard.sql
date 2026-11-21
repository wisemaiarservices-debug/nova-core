-- Enforce source-capability draft string contracts at the D1 write boundary — 0057
-- Application validation is useful feedback, not a substitute for persisted-row
-- integrity. These checks mirror the structural rules that SQLite can enforce.
-- Time-zone database membership remains an application/runtime check.

CREATE TRIGGER source_capability_contract_insert_guard
BEFORE INSERT ON source_capabilities
WHEN
  NEW.metric NOT GLOB '[a-z]*'
  OR NEW.metric GLOB '*[^a-z0-9._-]*'
  OR NEW.metric GLOB '*[._-]'
  OR NEW.metric GLOB '*[._-][._-]*'
  OR NEW.quantity_semantics GLOB '*[' || char(1) || '-' || char(31) || char(127) || ']*'
  OR NEW.acquisition_protocol NOT GLOB '[A-Za-z0-9]*'
  OR NEW.acquisition_protocol GLOB '*[^A-Za-z0-9._:-]*'
  OR NEW.timezone NOT IN ('UTC')
     AND (
       NEW.timezone NOT GLOB '[A-Za-z_]*/*'
       OR NEW.timezone GLOB '*[^A-Za-z0-9_+/-]*'
       OR NEW.timezone GLOB '*//*'
       OR NEW.timezone GLOB '*/'
     )
  OR NEW.data_rights_ref NOT GLOB '[A-Za-z0-9]*'
  OR NEW.data_rights_ref GLOB '*[^A-Za-z0-9._:/-]*'
  OR instr('/' || NEW.data_rights_ref || '/', '/../') > 0
  OR instr('/' || NEW.data_rights_ref || '/', '/./') > 0
  OR NEW.evidence_ref NOT GLOB '[A-Za-z0-9]*'
  OR NEW.evidence_ref GLOB '*[^A-Za-z0-9._:/-]*'
  OR instr('/' || NEW.evidence_ref || '/', '/../') > 0
  OR instr('/' || NEW.evidence_ref || '/', '/./') > 0
  OR NEW.unit GLOB '*[ ' || char(9) || char(10) || char(11) || char(12) || char(13) ||
       '                 　]*'
BEGIN
  SELECT RAISE(ABORT, 'source capability fields violate the canonical draft contract');
END;

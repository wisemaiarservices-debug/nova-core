-- Enforce source-capability draft string contracts at the D1 write boundary — 0057
-- Application validation is useful feedback, not a substitute for persisted-row
-- integrity. These checks mirror the structural rules that SQLite can enforce.
-- Time-zone database membership remains an application/runtime check.

CREATE TRIGGER source_capability_contract_insert_guard
BEFORE INSERT ON source_capabilities
WHEN
  length(NEW.metric) NOT BETWEEN 1 AND 120
  OR length(NEW.unit) NOT BETWEEN 1 AND 32
  OR length(NEW.quantity_semantics) NOT BETWEEN 1 AND 500
  OR length(NEW.acquisition_protocol) NOT BETWEEN 1 AND 80
  OR length(NEW.timezone) NOT BETWEEN 1 AND 80
  OR length(NEW.data_rights_ref) NOT BETWEEN 1 AND 500
  OR length(NEW.evidence_ref) NOT BETWEEN 1 AND 500
  OR NEW.metric NOT GLOB '[a-z]*'
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
  OR instr(NEW.unit, char(1)) > 0
  OR instr(NEW.unit, char(2)) > 0
  OR instr(NEW.unit, char(3)) > 0
  OR instr(NEW.unit, char(4)) > 0
  OR instr(NEW.unit, char(5)) > 0
  OR instr(NEW.unit, char(6)) > 0
  OR instr(NEW.unit, char(7)) > 0
  OR instr(NEW.unit, char(8)) > 0
  OR instr(NEW.unit, char(9)) > 0
  OR instr(NEW.unit, char(10)) > 0
  OR instr(NEW.unit, char(11)) > 0
  OR instr(NEW.unit, char(12)) > 0
  OR instr(NEW.unit, char(13)) > 0
  OR instr(NEW.unit, char(14)) > 0
  OR instr(NEW.unit, char(15)) > 0
  OR instr(NEW.unit, char(16)) > 0
  OR instr(NEW.unit, char(17)) > 0
  OR instr(NEW.unit, char(18)) > 0
  OR instr(NEW.unit, char(19)) > 0
  OR instr(NEW.unit, char(20)) > 0
  OR instr(NEW.unit, char(21)) > 0
  OR instr(NEW.unit, char(22)) > 0
  OR instr(NEW.unit, char(23)) > 0
  OR instr(NEW.unit, char(24)) > 0
  OR instr(NEW.unit, char(25)) > 0
  OR instr(NEW.unit, char(26)) > 0
  OR instr(NEW.unit, char(27)) > 0
  OR instr(NEW.unit, char(28)) > 0
  OR instr(NEW.unit, char(29)) > 0
  OR instr(NEW.unit, char(30)) > 0
  OR instr(NEW.unit, char(31)) > 0
  OR instr(NEW.unit, char(127)) > 0
  OR instr(NEW.unit, char(32)) > 0
  OR instr(NEW.unit, char(160)) > 0
  OR instr(NEW.unit, char(65279)) > 0
  OR instr(NEW.unit, char(5760)) > 0
  OR instr(NEW.unit, char(8192)) > 0
  OR instr(NEW.unit, char(8193)) > 0
  OR instr(NEW.unit, char(8194)) > 0
  OR instr(NEW.unit, char(8195)) > 0
  OR instr(NEW.unit, char(8196)) > 0
  OR instr(NEW.unit, char(8197)) > 0
  OR instr(NEW.unit, char(8198)) > 0
  OR instr(NEW.unit, char(8199)) > 0
  OR instr(NEW.unit, char(8200)) > 0
  OR instr(NEW.unit, char(8201)) > 0
  OR instr(NEW.unit, char(8202)) > 0
  OR instr(NEW.unit, char(8232)) > 0
  OR instr(NEW.unit, char(8233)) > 0
  OR instr(NEW.unit, char(8239)) > 0
  OR instr(NEW.unit, char(8287)) > 0
  OR instr(NEW.unit, char(12288)) > 0
BEGIN
  SELECT RAISE(ABORT, 'source capability fields violate the canonical draft contract');
END;

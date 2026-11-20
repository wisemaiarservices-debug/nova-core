-- Capability lifecycle guard: no_delete.

CREATE TRIGGER source_capability_no_delete
BEFORE DELETE ON source_capabilities
BEGIN
  SELECT RAISE(ABORT, 'source capabilities are retained');
END;

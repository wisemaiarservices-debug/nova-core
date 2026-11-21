-- Validate capability quality-flag allow-lists at the D1 write boundary — 0056
-- The application contract allows at most 32 unique ASCII identifiers, each 1–64
-- characters. Definitions are immutable after insert, so this guard protects every
-- capability version before it can be reviewed or used by observation ingestion.

CREATE TRIGGER source_capability_quality_flags_insert_guard
BEFORE INSERT ON source_capabilities
WHEN CASE
  WHEN NOT json_valid(NEW.allowed_quality_flags_json) THEN 1
  WHEN json_type(NEW.allowed_quality_flags_json) <> 'array' THEN 1
  WHEN json_array_length(NEW.allowed_quality_flags_json) > 32 THEN 1
  WHEN EXISTS (
    SELECT 1
    FROM json_each(NEW.allowed_quality_flags_json) flag
    WHERE flag.type <> 'text'
      OR length(flag.value) NOT BETWEEN 1 AND 64
      OR trim(flag.value) <> flag.value
      OR substr(flag.value,1,1) NOT GLOB '[A-Za-z0-9]'
      OR flag.value GLOB '*[^A-Za-z0-9._:-]*'
  ) THEN 1
  WHEN EXISTS (
    SELECT flag.value
    FROM json_each(NEW.allowed_quality_flags_json) flag
    GROUP BY flag.value
    HAVING COUNT(*) > 1
  ) THEN 1
  ELSE 0
END = 1
BEGIN
  SELECT RAISE(ABORT, 'source capability quality flags must be unique valid identifiers');
END;

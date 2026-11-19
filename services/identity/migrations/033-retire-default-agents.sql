-- Runner discovery used to create one unnamed Agent per runtime profile.
-- Retire those placeholders without breaking execution records that reference
-- them; all future Agents are explicit user configurations.
UPDATE mas_business_project_coordinator c
SET agent_id=NULL,
  paused=true,
  pause_reason='项目协调 Agent 已移除，请选择一个 Agent',
  version=c.version+1,
  last_resume_version=NULL
FROM mas_business_agent a
WHERE c.agent_id=a.id AND a.is_default;

DELETE FROM mas_business_agent_project g
USING mas_business_agent a
WHERE g.agent_id=a.id AND a.is_default;

DELETE FROM mas_business_agent_creation c
USING mas_business_agent a
WHERE (c.source_agent_id=a.id OR c.agent_id=a.id) AND a.is_default;

-- Remove unused placeholders completely. Historical attempts retain their
-- referenced Agent row, but it is disabled and hidden from every active path.
DELETE FROM mas_business_agent a
WHERE a.is_default
  AND NOT EXISTS(SELECT 1 FROM mas_business_work_attempt attempt WHERE attempt.agent_id=a.id);

UPDATE mas_business_agent
SET enabled=false,
  ready_until=to_timestamp(0),
  deleted_at=coalesce(deleted_at,clock_timestamp()),
  version=version+1
WHERE is_default;

DROP INDEX mas_business_agent_default_runtime;
ALTER TABLE mas_business_agent DROP COLUMN is_default;
